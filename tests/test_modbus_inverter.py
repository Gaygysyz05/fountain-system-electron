"""Regression tests for AsyncInverterController against a real (fake) Modbus
TCP VFD gateway -- guards reset_fault()'s dedup bypass and the same
transport-vs-protocol-error distinction as test_modbus_valve.py, both fixed
this session."""
from __future__ import annotations

import asyncio

from pymodbus.client import AsyncModbusTcpClient

from app.event_bus import EventBus
from app.hardware.modbus_inverter import (
    CMD_FAULT_RESET,
    P0_01_ADDR,
    P0_03_ADDR,
    P0_06_ADDR,
    REG_CTRL_WORD,
    REG_SETPOINT_PCT,
    AsyncInverterController,
)
from tests.fakes.fake_modbus import FakeModbusServer

SLAVE_ID = 5


async def make_controller(server: FakeModbusServer, bus: EventBus) -> tuple[AsyncInverterController, AsyncModbusTcpClient]:
    # Pre-seed the comm-source registers connect() checks so bring-up
    # succeeds without needing to test that separately here -- these tests
    # are about reset_fault/write behavior, not the DGI900 bring-up sequence.
    server.registers[P0_03_ADDR] = 2
    server.registers[P0_01_ADDR] = 9
    server.registers[P0_06_ADDR] = 5000  # -> max_frequency = 50.0 Hz

    client = AsyncModbusTcpClient(host=server.host, port=server.port, timeout=0.5)
    await client.connect()
    assert client.connected

    controller = AsyncInverterController(
        zone_id=1, client=client, bus_lock=asyncio.Lock(), slave_id=SLAVE_ID,
        motor_id=1, bus=bus, instance_id="inv1", timeout=0.5, min_command_interval=0.0,
    )
    assert await controller.connect()
    return controller, client


async def test_reset_fault_bypasses_command_dedup() -> None:
    """send_command() no-ops a repeat of the same command (the drive already
    got it) -- correct for normal run/stop commands, but reset_fault() must
    always go out even if CMD_FAULT_RESET was already the last thing sent,
    because the operator clicking Reset Fault a second time means the drive
    tripped again, not "nothing changed"."""
    async with FakeModbusServer() as server:
        bus = EventBus()
        controller, client = await make_controller(server, bus)

        # Simulate a prior reset already having been sent -- send_command's
        # dedup would silently no-op a second CMD_FAULT_RESET in this state.
        controller.last_command = CMD_FAULT_RESET

        writes_before = len(server.received_writes)
        ok = await controller.reset_fault()
        writes_after = len(server.received_writes)

        assert ok is True
        assert writes_after == writes_before + 1  # the write actually reached the wire
        assert (SLAVE_ID, REG_CTRL_WORD, CMD_FAULT_RESET) in server.received_writes

        await controller.disconnect()
        client.close()  # this test owns the client (it's not AsyncInverterManager), so it must close it -- see fake_modbus.py's stop()


async def test_send_command_dedup_still_applies_normally() -> None:
    """Contrast case: send_command() itself (unlike reset_fault) SHOULD skip
    a repeat of the same command -- this is existing, intentional behavior,
    not a bug; the point of the fix is that reset_fault avoids it, not that
    the dedup itself is wrong."""
    async with FakeModbusServer() as server:
        bus = EventBus()
        controller, client = await make_controller(server, bus)
        controller.last_command = CMD_FAULT_RESET

        writes_before = len(server.received_writes)
        ok = await controller.send_command(CMD_FAULT_RESET)
        writes_after = len(server.received_writes)

        assert ok is True
        assert writes_after == writes_before  # deduped -- no new write on the wire

        await controller.disconnect()
        client.close()  # this test owns the client (it's not AsyncInverterManager), so it must close it -- see fake_modbus.py's stop()


async def test_protocol_rejection_does_not_mark_disconnected() -> None:
    async with FakeModbusServer() as server:
        bus = EventBus()
        controller, client = await make_controller(server, bus)

        server.reject_writes[REG_SETPOINT_PCT] = 10_000

        ok = await controller.set_frequency(25.0)

        assert ok is False
        assert controller.is_connected() is True  # rejected, not disconnected

        await controller.disconnect()
        client.close()  # this test owns the client (it's not AsyncInverterManager), so it must close it -- see fake_modbus.py's stop()


async def test_genuine_transport_failure_marks_disconnected() -> None:
    async with FakeModbusServer() as server:
        bus = EventBus()
        controller, client = await make_controller(server, bus)

        server.drop_after_n_requests = 0

        ok = await controller.set_frequency(25.0)

        assert ok is False
        assert controller.is_connected() is False

        await controller.disconnect()
        client.close()  # this test owns the client (it's not AsyncInverterManager), so it must close it -- see fake_modbus.py's stop()
