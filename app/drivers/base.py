"""Driver registry mapping driver_type -> adapter (new hardware = one small file + registration, no core changes). Two-level model mirrors real fieldbus hardware: a DriverInstance owns one physical connection since most relay boards/Art-Net nodes/serial gateways tolerate only one or a few concurrent connections (several motor inverters often share one serial bus bridged to one TCP endpoint), while a "device" (zone_runtime.py) is a channel within that instance and multiple devices routinely share one DriverInstance."""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Callable, Protocol

from pydantic import BaseModel

from app.event_bus import EventBus


class DeviceCategory(str, Enum):
    VALVE = "valve"
    MOTOR = "motor"
    LIGHT = "light"


class DriverInstance(Protocol):
    """What every driver adapter must implement; ZoneRuntime and the WS command handlers only ever talk to this shape, never a concrete driver class."""

    async def connect(self) -> bool: ...
    async def disconnect(self) -> None: ...
    async def emergency_stop(self) -> None: ...
    def is_connected(self) -> bool: ...

    async def register_channel(self, channel: str) -> bool:
        """Called once when ADD_DEVICE first maps a device_id onto this channel; no-op for drivers where any channel is valid once connected, but for a shared gateway (e.g. Modbus) each channel/slave-id needs its own bring-up sequence before it responds."""
        ...

    def apply_state(self, channel: str, state: dict[str, Any]) -> None:
        """Non-blocking, fire-and-forget; `state` shape is category-specific: {"on": bool} valve, {"frequency", "active"} motor, {"r","g","b"} light."""
        ...


DriverFactory = Callable[[int, str, BaseModel, EventBus], DriverInstance]
"""(zone_id, instance_id, validated_config, event_bus) -> DriverInstance"""


@dataclass(frozen=True)
class DriverDescriptor:
    driver_type: str
    category: DeviceCategory
    display_name: str
    config_model: type[BaseModel]
    factory: DriverFactory


_registry: dict[str, DriverDescriptor] = {}


def register_driver(descriptor: DriverDescriptor) -> None:
    if descriptor.driver_type in _registry:
        raise ValueError(f"driver_type '{descriptor.driver_type}' already registered")
    _registry[descriptor.driver_type] = descriptor


def get_driver(driver_type: str) -> DriverDescriptor:
    try:
        return _registry[driver_type]
    except KeyError:
        raise KeyError(f"unknown driver_type: {driver_type!r} (known: {sorted(_registry)})") from None


def list_drivers(category: DeviceCategory | None = None) -> list[DriverDescriptor]:
    drivers = list(_registry.values())
    if category is not None:
        drivers = [d for d in drivers if d.category == category]
    return sorted(drivers, key=lambda d: d.driver_type)


def create_instance(zone_id: int, instance_id: str, driver_type: str, raw_config: dict, bus: EventBus) -> tuple[DriverInstance, BaseModel]:
    """Validates raw_config against the driver's schema (a clear Pydantic error here beats a confusing AttributeError deep in a controller); callers needing a schema field (e.g. total_channels) must read the returned config, not raw_config, since only the validated model reflects schema defaults/coercions."""
    descriptor = get_driver(driver_type)
    config = descriptor.config_model.model_validate(raw_config)
    return descriptor.factory(zone_id, instance_id, config, bus), config
