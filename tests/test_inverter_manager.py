"""Regression test for AsyncInverterManager.emergency_stop_all() against a
real (fake) Modbus TCP gateway -- guards the in-flight-ramp E-stop bug found
during the pre-deployment safety review."""
from __future__ import annotations

import asyncio
import contextlib

from app.event_bus import EventBus
from app.hardware import inverter_manager
from app.hardware.inverter_manager import AsyncInverterManager
from app.hardware.modbus_inverter import (
    CMD_FORWARD,
    CMD_FREE_STOP,
    P0_01_ADDR,
    P0_03_ADDR,
    P0_06_ADDR,
    REG_CTRL_WORD,
)
from tests.fakes.fake_modbus import FakeModbusServer

SLAVE_ID = 5


async def test_emergency_stop_all_cancels_in_flight_ramp(monkeypatch) -> None:
    """_apply_frequency's ramp loop only bails early for a NEWER queued
    command -- an EMPTY queue does not stop it, it just keeps stepping
    toward the pre-E-stop target. emergency_stop_all() used to only drain
    the (already-empty, since the ramp's command was long since dequeued)
    queue and call controller.emergency_stop(), never touching the running
    ramp. Worse, emergency_stop() resets last_command to None, so the
    ramp's own next start_forward() call would write CMD_FORWARD again --
    right after CMD_FREE_STOP -- and turn the motor back on."""
    monkeypatch.setattr(inverter_manager, "RAMP_STEP_INTERVAL", 0.02)

    async with FakeModbusServer() as server:
        server.registers[P0_03_ADDR] = 2
        server.registers[P0_01_ADDR] = 9
        server.registers[P0_06_ADDR] = 5000  # -> max_frequency = 50.0 Hz

        bus = EventBus()
        manager = AsyncInverterManager(zone_id=1, host=server.host, port=server.port, bus=bus)
        manager.add_inverter(motor_id=1, slave_id=SLAVE_ID)
        assert (await manager.connect_all())[SLAVE_ID] is True

        # A slow ramp toward a target far from zero -- with RAMP_STEP_INTERVAL
        # patched to 0.02s and this rate, one step covers only 0.02Hz, so a
        # short sleep below is nowhere near enough to reach the 40Hz target.
        manager.execute_motor_event(SLAVE_ID, {"frequency": 40.0, "active": True, "max_ramp_rate": 1.0})
        await asyncio.sleep(0.06)

        controller = manager.inverters[SLAVE_ID]
        assert controller.last_frequency is not None
        assert controller.last_frequency < 40.0  # ramp genuinely in progress, nowhere near target

        stopped = await manager.emergency_stop_all()
        assert stopped == 1

        estop_index = max(
            i for i, w in enumerate(server.received_writes)
            if w == (SLAVE_ID, REG_CTRL_WORD, CMD_FREE_STOP)
        )

        await asyncio.sleep(0.3)  # several ramp-step-intervals -- plenty of time for a straggler step

        later_writes = server.received_writes[estop_index + 1:]
        assert not any(w[1] == REG_CTRL_WORD and w[2] == CMD_FORWARD for w in later_writes), (
            "a ramp step still in flight re-enabled the motor (wrote CMD_FORWARD) after the E-stop"
        )

        await manager.disconnect_all()


async def test_execute_motor_event_immediate_is_cancelled_by_emergency_stop(monkeypatch) -> None:
    """execute_motor_event_immediate() bypasses the queue entirely and used to run its ramp with
    nothing tracking the task -- emergency_stop_all() could only cancel _consumer_tasks, so a ramp
    started this way kept stepping toward its pre-E-stop target for seconds after E-stop returned,
    the exact bug already fixed above for the queued path but unreachable from there."""
    # Deliberately large (unlike the queued-path test above, which uses 0.02s): each ramp step writes
    # immediately, THEN sleeps for this interval -- cancelling while a write is actually in flight is
    # a real (if rare) transport-level disruption in its own right, not a bug in this fix, so the test
    # must land its cancel comfortably inside that sleep window rather than racing the write itself.
    monkeypatch.setattr(inverter_manager, "RAMP_STEP_INTERVAL", 1.0)

    async with FakeModbusServer() as server:
        server.registers[P0_03_ADDR] = 2
        server.registers[P0_01_ADDR] = 9
        server.registers[P0_06_ADDR] = 5000  # -> max_frequency = 50.0 Hz

        bus = EventBus()
        manager = AsyncInverterManager(zone_id=1, host=server.host, port=server.port, bus=bus)
        manager.add_inverter(motor_id=1, slave_id=SLAVE_ID)
        assert (await manager.connect_all())[SLAVE_ID] is True

        ramp_task = asyncio.create_task(
            manager.execute_motor_event_immediate(SLAVE_ID, {"frequency": 40.0, "active": True, "max_ramp_rate": 1.0})
        )
        await asyncio.sleep(0.1)  # comfortably inside the first 1.0s sleep, well past the near-instant first write

        controller = manager.inverters[SLAVE_ID]
        assert controller.last_frequency is not None
        assert controller.last_frequency < 40.0  # ramp genuinely in progress, nowhere near target

        stopped = await manager.emergency_stop_all()
        assert stopped == 1

        estop_index = max(
            i for i, w in enumerate(server.received_writes)
            if w == (SLAVE_ID, REG_CTRL_WORD, CMD_FREE_STOP)
        )

        with contextlib.suppress(asyncio.CancelledError):
            await ramp_task  # the E-stop's cancellation propagates here, same as any other asyncio cancellation

        await asyncio.sleep(0.3)  # several ramp-step-intervals -- plenty of time for a straggler step

        later_writes = server.received_writes[estop_index + 1:]
        assert not any(w[1] == REG_CTRL_WORD and w[2] == CMD_FORWARD for w in later_writes), (
            "a directly-ramped (execute_motor_event_immediate) motor re-enabled itself after the E-stop"
        )

        await manager.disconnect_all()


async def test_connect_inverter_does_not_open_a_second_connection_when_racing_the_reconnect_watchdog(monkeypatch) -> None:
    """connect_inverter() checked `if not self._client.connected` and then awaited
    self._client.connect() with no lock -- two concurrent callers sharing the same
    AsyncModbusTcpClient (e.g. connect_all()'s gather racing the 1s reconnect watchdog while the
    link is down) could both open a real TCP connection on the same client object at once, leaking
    one and leaving pymodbus's internal state pointing at whichever connection_made() ran last."""
    async with FakeModbusServer() as server:
        bus = EventBus()
        manager = AsyncInverterManager(zone_id=1, host=server.host, port=server.port, bus=bus)
        manager.add_inverter(motor_id=1, slave_id=SLAVE_ID)

        connect_calls = 0
        real_connect = manager._client.connect

        async def slow_connect() -> bool:
            nonlocal connect_calls
            connect_calls += 1
            await asyncio.sleep(0.05)  # widens the race window so both callers are definitely in flight together
            return await real_connect()

        monkeypatch.setattr(manager._client, "connect", slow_connect)

        # Two concurrent callers racing the same not-yet-connected shared client -- simulates
        # connect_all() (which gathers connect_inverter() for every registered motor) landing at
        # the same moment as the reconnect watchdog's own attempt.
        results = await asyncio.gather(
            manager.connect_inverter(SLAVE_ID),
            manager.connect_inverter(SLAVE_ID),
        )

        assert all(results)
        assert connect_calls == 1, "two concurrent callers both dialed the shared client instead of one waiting for the other"

        await manager.disconnect_all()
