"""Driver adapter: a Modbus TCP relay bank (R4D3C32-style), wrapping the
AsyncValveController built in Step 2/3. `channel` is the valve number as a
string ("1".."total_channels")."""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from app.drivers.base import DeviceCategory, DriverDescriptor, register_driver
from app.event_bus import EventBus
from app.hardware.modbus_valve import AsyncValveController


class ModbusValveConfig(BaseModel):
    host: str
    port: int = 502
    slave_id: int = Field(1, ge=1, le=247)
    total_channels: int = Field(32, ge=1, le=256)
    min_toggle_interval: float = Field(0.25, ge=0, description="Tune to the valve/relay datasheet")


class ModbusValveDriver:
    def __init__(self, zone_id: int, instance_id: str, config: ModbusValveConfig, bus: EventBus) -> None:
        self._total_channels = config.total_channels
        self._controller = AsyncValveController(
            zone_id=zone_id, host=config.host, port=config.port, slave_id=config.slave_id,
            total_channels=config.total_channels, bus=bus, min_toggle_interval=config.min_toggle_interval,
        )

    async def connect(self) -> bool:
        return await self._controller.connect()

    async def disconnect(self) -> None:
        await self._controller.disconnect()

    async def emergency_stop(self) -> None:
        await self._controller.emergency_all_off()

    def is_connected(self) -> bool:
        return self._controller.is_connected()

    async def register_channel(self, channel: str) -> bool:
        """Every channel is always valid once the relay bank is connected --
        no per-channel bring-up needed, just catch an out-of-range number
        early instead of it silently doing nothing at apply_state time."""
        try:
            return 1 <= int(channel) <= self._total_channels
        except ValueError:
            return False

    def apply_state(self, channel: str, state: dict[str, Any]) -> None:
        self._controller.set_valve_state(int(channel), bool(state.get("on", False)))


register_driver(DriverDescriptor(
    driver_type="modbus_relay_valve",
    category=DeviceCategory.VALVE,
    display_name="Relay Board (R421C32)",
    config_model=ModbusValveConfig,
    factory=lambda zone_id, instance_id, config, bus: ModbusValveDriver(zone_id, instance_id, config, bus),
))
