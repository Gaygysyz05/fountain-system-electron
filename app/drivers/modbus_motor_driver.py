"""Driver adapter: an RTU/TCP gateway serving one or more DGI900-style VFD
inverters on a shared RS485 bus, wrapping AsyncInverterManager.

One instance = one gateway (host:port), NOT one motor -- corrected after
confirming the real deployment (DegDrive DGI900 inverters behind an
RTU/TCP converter). `channel` is the inverter's Modbus slave/unit ID as a
string; each channel gets registered (and does its own comm-source bring-up)
via `register_channel`, called once when ADD_DEVICE first maps a device_id
onto it -- unlike the valve/light drivers, a motor channel needs real setup
before it responds to anything, it isn't just a number that's always valid.
"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from app.drivers.base import DeviceCategory, DriverDescriptor, register_driver
from app.event_bus import EventBus
from app.hardware.inverter_manager import DEFAULT_MAX_RAMP_RATE_HZ_PER_SEC, AsyncInverterManager


class ModbusMotorGatewayConfig(BaseModel):
    host: str
    port: int = 502
    max_ramp_rate_hz_per_sec: float = Field(DEFAULT_MAX_RAMP_RATE_HZ_PER_SEC, gt=0)


class ModbusMotorGatewayDriver:
    def __init__(self, zone_id: int, instance_id: str, config: ModbusMotorGatewayConfig, bus: EventBus) -> None:
        self._manager = AsyncInverterManager(
            zone_id=zone_id, host=config.host, port=config.port, bus=bus, instance_id=instance_id,
            subsystem="motor", max_ramp_rate_hz_per_sec=config.max_ramp_rate_hz_per_sec,
        )
        self._next_motor_id = 1  # internal bookkeeping id for AsyncInverterManager, distinct from slave_id

    async def connect(self) -> bool:
        """Nothing to do at the gateway level yet -- the shared TCP link is
        established lazily by AsyncInverterManager as soon as the first
        motor is registered via register_channel. A gateway with zero
        motors configured has nothing to connect to."""
        return True

    async def disconnect(self) -> None:
        await self._manager.disconnect_all()

    async def emergency_stop(self) -> None:
        await self._manager.emergency_stop_all()

    def is_connected(self) -> bool:
        return any(self._manager.is_connected(sid) for sid in self._manager.inverters)

    async def register_channel(self, channel: str) -> bool:
        try:
            slave_id = int(channel)
        except ValueError:
            return False

        if slave_id in self._manager.inverters:
            return self._manager.is_connected(slave_id)

        if not self._manager.add_inverter(motor_id=self._next_motor_id, slave_id=slave_id):
            return False
        self._next_motor_id += 1
        return await self._manager.connect_inverter(slave_id)

    def apply_state(self, channel: str, state: dict[str, Any]) -> None:
        self._manager.execute_motor_event(int(channel), {
            "frequency": state.get("frequency", 0.0),
            "active": state.get("active", False),
        })

    async def reset_fault(self, channel: str) -> bool:
        try:
            slave_id = int(channel)
        except ValueError:
            return False
        return await self._manager.reset_fault(slave_id)


register_driver(DriverDescriptor(
    driver_type="modbus_vfd_motor_gateway",
    category=DeviceCategory.MOTOR,
    display_name="DegDrive DGI900 (RTU/TCP gateway)",
    config_model=ModbusMotorGatewayConfig,
    factory=lambda zone_id, instance_id, config, bus: ModbusMotorGatewayDriver(zone_id, instance_id, config, bus),
))
