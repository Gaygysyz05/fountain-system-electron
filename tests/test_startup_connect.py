"""Regression tests for main.py's background hardware-connect path --
_connect_pending_instances, which persistence.load_installation's
registered-but-not-yet-connected instances get handed off to (see both
docstrings) so a slow/unreachable board can't block the daemon's ASGI
startup, including the HMI's own WS handshake."""
from __future__ import annotations

from app import main
from app.event_bus import EventBus
from app.hardware.modbus_valve import AsyncValveController
from tests.fakes.fake_modbus import FakeModbusServer


async def _make_controller(host: str, port: int, bus: EventBus, instance_id: str) -> AsyncValveController:
    return AsyncValveController(
        zone_id=1, host=host, port=port, slave_id=1, instance_id=instance_id,
        total_channels=2, bus=bus, min_toggle_interval=0.0, write_timeout=0.5,
    )


async def test_connect_pending_instances_connects_every_instance_concurrently() -> None:
    bus = EventBus()
    async with FakeModbusServer() as server_a, FakeModbusServer() as server_b:
        controller_a = await _make_controller(server_a.host, server_a.port, bus, "rele1")
        controller_b = await _make_controller(server_b.host, server_b.port, bus, "rele2")

        assert controller_a.is_connected() is False
        assert controller_b.is_connected() is False

        await main._connect_pending_instances([
            (1, "rele1", controller_a),
            (1, "rele2", controller_b),
        ])

        assert controller_a.is_connected() is True
        assert controller_b.is_connected() is True

        await controller_a.disconnect()
        await controller_b.disconnect()


async def test_connect_pending_instances_tolerates_one_failure() -> None:
    """A single unreachable board must not stop the others from
    connecting, and must not raise out of _connect_pending_instances --
    lifespan awaits this as a background task with nothing else around it
    to catch an escaping exception."""
    bus = EventBus()
    async with FakeModbusServer() as server:
        good = await _make_controller(server.host, server.port, bus, "rele1")
        # Nothing listens on port 1 -- a fast, deterministic "connection
        # refused" instead of a real timeout.
        bad = await _make_controller("127.0.0.1", 1, bus, "rele-bad")

        await main._connect_pending_instances([
            (1, "rele1", good),
            (1, "rele-bad", bad),
        ])

        assert good.is_connected() is True
        assert bad.is_connected() is False

        await good.disconnect()


async def test_connect_pending_instances_is_a_noop_for_an_empty_list() -> None:
    await main._connect_pending_instances([])
