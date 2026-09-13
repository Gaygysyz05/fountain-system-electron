"""Driver adapter: a Modbus TCP relay bank (R4D3C32-style), wrapping the
AsyncValveController built in Step 2/3. `channel` is the valve number as a
string ("1".."total_channels")."""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, model_validator

from app.drivers.base import DeviceCategory, DriverDescriptor, register_driver
from app.event_bus import EventBus
from app.hardware.modbus_valve import AsyncValveController


class ModbusValveConfig(BaseModel):
    host: str
    port: int = 502
    slave_id: int = Field(1, ge=1, le=247)
    total_channels: int = Field(32, ge=1, le=256)
    min_toggle_interval: float = Field(0.5, ge=0, description="Shortest time a relay can be held open/closed before flipping again -- tune to the valve/relay datasheet; also the floor the HMI's grid Step and timeline snapping enforce")

    @model_validator(mode="after")
    def _validate_slave_id_range(self) -> "ModbusValveConfig":
        """AsyncValveController spans multiple Modbus unit IDs once total_channels > 32 (each board
        addresses only 32 relays): target_slave = slave_id + (relay_num-1)//32, reaching slave_id +
        (total_channels-1)//32 for the last relay. slave_id and total_channels each validate fine on
        their own (1-247, 1-256) but a combination of the two can still push that computed unit ID past
        247 -- worth catching here rather than at runtime, since a write to an invalid unit ID times out
        and flips _connected, which then makes emergency_all_off() skip every OTHER (correctly
        addressed) relay in the same pass too."""
        max_slave = self.slave_id + (self.total_channels - 1) // 32
        if max_slave > 247:
            raise ValueError(
                f"slave_id={self.slave_id} with total_channels={self.total_channels} would address "
                f"unit ID {max_slave} for the last relay, past the legal maximum of 247 -- reduce "
                f"slave_id or total_channels"
            )
        return self


class ModbusValveDriver:
    def __init__(self, zone_id: int, instance_id: str, config: ModbusValveConfig, bus: EventBus) -> None:
        self._total_channels = config.total_channels
        self._controller = AsyncValveController(
            zone_id=zone_id, host=config.host, port=config.port, slave_id=config.slave_id,
            total_channels=config.total_channels, bus=bus, instance_id=instance_id,
            min_toggle_interval=config.min_toggle_interval,
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
