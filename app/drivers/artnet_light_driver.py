"""Driver adapter: direct RGB over Art-Net (EightOutputLEDController from the
original codebase), wrapping AsyncArtNetController. `channel` is the
universe/output number, "0".."7" (the Node8 numbers its 8 outputs from zero).

This is the ONE light driver with real reference code behind it. The
DMX-decoder + RGB-amplifier rig mentioned in the architecture discussion is a
different addressing/protocol story (decoder channel maps, amplifier
mapping) that needs real specs before it can be written -- register it here
as `dmx_decoder_rgb_amplifier_light` once that hardware is in hand, following
this file as the template. Nothing else in the system needs to change to add
it: the registry, ZoneRuntime, and the WS protocol are already generic over
`category=LIGHT`.
"""
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
        )

    async def connect(self) -> bool:
        return await self._controller.connect()

    async def disconnect(self) -> None:
        await self._controller.disconnect()

    async def emergency_stop(self) -> None:
        self._controller.all_off()

    def is_connected(self) -> bool:
        return self._controller.is_connected()

    async def register_channel(self, channel: str) -> bool:
        """The Node8 (confirmed hardware: CR061SA) has 8 fixed outputs,
        numbered 0-7 -- nothing to bring up per-channel, just validate the
        number is real."""
        try:
            return 0 <= int(channel) <= 7
        except ValueError:
            return False

    def apply_state(self, channel: str, state: dict[str, Any]) -> None:
        # AsyncArtNetController numbers its outputs 1-8 internally (ported
        # as-is from the original working EightOutputLEDController) -- the
        # +1 here is the one place that translates our 0-7 user-facing
        # universe number into that.
        self._controller.update_led(int(channel) + 1, state.get("r", 0), state.get("g", 0), state.get("b", 0))


register_driver(DriverDescriptor(
    driver_type="artnet_rgb_light",
    category=DeviceCategory.LIGHT,
    display_name="Art-Net Node8 (CR061SA)",
    config_model=ArtNetLightConfig,
    factory=lambda zone_id, instance_id, config, bus: ArtNetLightDriver(zone_id, instance_id, config, bus),
))
