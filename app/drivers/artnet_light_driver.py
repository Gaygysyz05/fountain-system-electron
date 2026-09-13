"""Direct RGB over Art-Net, wrapping AsyncArtNetController; `channel` is "0".."7" since the Node8 numbers its 8 outputs from zero."""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from app.drivers.base import DeviceCategory, DriverDescriptor, register_driver
from app.event_bus import EventBus
from app.hardware.artnet import AsyncArtNetController


class ArtNetLightConfig(BaseModel):
    target_ip: str
    target_port: int = 6454


class ArtNetLightDriver:
    def __init__(self, zone_id: int, instance_id: str, config: ArtNetLightConfig, bus: EventBus) -> None:
        self._controller = AsyncArtNetController(
            zone_id=zone_id, target_ip=config.target_ip, target_port=config.target_port, bus=bus,
            instance_id=instance_id,
        )

    async def connect(self) -> bool:
        return await self._controller.connect()

    async def disconnect(self) -> None:
        await self._controller.disconnect()

    async def emergency_stop(self) -> None:
        await self._controller.emergency_stop()

    def is_connected(self) -> bool:
        return self._controller.is_connected()

    async def register_channel(self, channel: str) -> bool:
        """Node8 has 8 fixed outputs (0-7); nothing to bring up per-channel, just validate the number is real."""
        try:
            return 0 <= int(channel) <= 7
        except ValueError:
            return False

    def apply_state(self, channel: str, state: dict[str, Any]) -> None:
        # AsyncArtNetController numbers outputs 1-8 internally; +1 translates our 0-7 user-facing number into that.
        self._controller.update_led(int(channel) + 1, state.get("r", 0), state.get("g", 0), state.get("b", 0))


register_driver(DriverDescriptor(
    driver_type="artnet_rgb_light",
    category=DeviceCategory.LIGHT,
    display_name="Art-Net Node8 (CR061SA)",
    config_model=ArtNetLightConfig,
    factory=lambda zone_id, instance_id, config, bus: ArtNetLightDriver(zone_id, instance_id, config, bus),
))
