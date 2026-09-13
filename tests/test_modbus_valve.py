"""Regression tests for AsyncValveController against a real (fake) Modbus TCP
relay board -- guards the transport-vs-protocol-error distinction and the
emergency_all_off retry/critical-error path found and fixed this session by
testing against exactly this kind of failure-injecting fake."""
from __future__ import annotations

import asyncio
import time

from app.event_bus import EventBus
from app.hardware.modbus_valve import AsyncValveController
from tests.fakes.fake_modbus import FakeModbusServer

ON_VALUE = 0x0100
OFF_VALUE = 0x0200


async def make_controller(server: FakeModbusServer, bus: EventBus, total_channels: int = 4) -> AsyncValveController:
    controller = AsyncValveController(
        zone_id=1, host=server.host, port=server.port, slave_id=1, instance_id="rele1",
        total_channels=total_channels, bus=bus, min_toggle_interval=0.0, write_timeout=0.5,
    )
    assert await controller.connect()
    return controller


async def test_protocol_rejection_does_not_mark_disconnected() -> None:
    """A Modbus exception response (board alive, transaction rejected) must
    not be treated the same as the transport being down -- the actual bug:
    an earlier version raised through the same except block for both, which
    marked the whole connection dead over one rejected relay and, via the
    retry loop, cascade-failed every other relay in the same pass."""
    async with FakeModbusServer() as server:
        bus = EventBus()
        events = bus.subscribe()
        controller = await make_controller(server, bus, total_channels=4)

        # Relay 2 (register address 2) always rejects; everything else works.
        server.reject_writes[2] = 10_000

        confirmed = await controller.emergency_all_off(retries=1)

        assert confirmed == 3  # relays 1, 3, 4 -- everything except the rejected one
        assert controller.is_connected() is True  # protocol rejection, not a transport failure
        assert (1, 2, OFF_VALUE) in server.received_writes  # the write DID reach the wire and WAS rejected

        # A critical HardwareErrorEvent should have been published for the
        # relay that never confirmed -- an E-stop leaving a valve open must
        # be loud, not just a log line.
        critical = [e for e in _drain(events) if getattr(e, "severity", None) == "critical"]
        assert any("2" in e.message for e in critical)

        await controller.disconnect()


async def test_transient_rejection_recovers_on_retry() -> None:
    """A relay that rejects the first attempt but accepts the retry should
    end up confirmed, with no critical error -- retries exist for exactly
    this transient case."""
    async with FakeModbusServer() as server:
        bus = EventBus()
        controller = await make_controller(server, bus, total_channels=3)

        server.reject_writes[1] = 1  # relay 1 rejects once, then succeeds

        confirmed = await controller.emergency_all_off(retries=2)

        assert confirmed == 3
        assert controller.is_connected() is True

        await controller.disconnect()


async def test_genuine_transport_failure_marks_disconnected() -> None:
    """A dropped TCP connection (not a protocol-level rejection) is the one
    case that SHOULD flip _connected, so the reconnect watchdog takes over."""
    async with FakeModbusServer() as server:
        bus = EventBus()
        events = bus.subscribe()
        controller = await make_controller(server, bus, total_channels=2)

        server.drop_after_n_requests = 0  # close the connection before answering anything further

        ok = await controller._write_relay(1, True)

        assert ok is False
        assert controller.is_connected() is False

        warnings = [e for e in _drain(events) if getattr(e, "severity", None) == "warning"]
        assert len(warnings) >= 1

        await controller.disconnect()


async def test_reconnect_closes_the_previous_client_instead_of_leaking_it() -> None:
    """connect() used to unconditionally create a new AsyncModbusTcpClient
    and overwrite self._client with no regard for whatever the old one was
    doing -- on the exact flaky-link scenario _reconnect_watchdog exists to
    ride out, that leaked one more socket/transport per retry cycle. The
    fix must close the outgoing client before replacing it."""
    async with FakeModbusServer() as server:
        bus = EventBus()
        controller = await make_controller(server, bus, total_channels=2)

        first_client = controller._client
        assert first_client is not None
        assert first_client.connected is True

        assert await controller.connect()  # simulates the watchdog's repeat connect() call

        assert controller._client is not first_client  # a fresh client was made, as before
        assert first_client.connected is False  # ...but the old one was actually closed, not abandoned

        await controller.disconnect()


async def test_emergency_all_off_cancels_in_flight_command_consumer() -> None:
    """emergency_all_off() bypasses the queue for its OWN writes, but used
    to leave _command_consumer running underneath. A command that had
    already been dequeued and was mid-flight -- past _respect_min_interval's
    sleep, about to write -- when the E-stop fired was never touched by
    that drain, so it would still land on the wire and turn a valve back on
    some time after emergency_all_off() had already reported it off.

    Forces exactly that ordering deterministically: seed _last_command_time
    so the queued command's own min-interval wait is long (~1s), let the
    consumer actually dequeue it and enter that wait, THEN call
    emergency_all_off() (which returns almost immediately against the fake
    local server) and check nothing writes valve 1 back on afterward."""
    async with FakeModbusServer() as server:
        bus = EventBus()
        controller = await make_controller(server, bus, total_channels=2)

        controller.min_toggle_interval = 1.0
        controller._last_command_time[1] = time.monotonic()
        controller.set_valve_state(1, True)
        await asyncio.sleep(0.05)  # let the consumer dequeue it and enter the ~1s min-interval wait

        writes_before_estop = len(server.received_writes)
        confirmed = await controller.emergency_all_off()
        assert confirmed == 2  # both relays confirmed off
        assert (1, 1, OFF_VALUE) in server.received_writes[writes_before_estop:]

        await asyncio.sleep(1.2)  # long enough for the stale command's ~1s wait to have elapsed

        assert (1, 1, ON_VALUE) not in server.received_writes[writes_before_estop:], (
            "a command already in flight when the E-stop fired still turned valve 1 back on"
        )

        await controller.disconnect()


def _drain(queue: asyncio.Queue) -> list:
    items = []
    while not queue.empty():
        items.append(queue.get_nowait())
    return items
