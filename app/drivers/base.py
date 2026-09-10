"""
Driver registry: the mechanism that makes the system "universal" rather than
hardcoded to a fixed device list, per the architecture discussion. A device
category (valve/motor/light) is a small, stable set the daemon's core knows
about. A *driver* is a concrete implementation for one piece of hardware
speaking one protocol -- there can be many per category (a relay board on
Modbus TCP today, a different valve controller brand tomorrow; direct
Art-Net RGB today, a DMX-decoder-plus-amplifier rig tomorrow). Adding a new
driver means writing one small adapter file and registering it here -- the
scheduler, the WS protocol, and ZoneRuntime never change.

Two-level model, because real fieldbus hardware works this way:
  - A DriverInstance owns ONE physical connection (one Modbus TCP socket, one
    Art-Net UDP target, one RTU/TCP gateway). Most relay boards / Art-Net
    nodes / serial gateways only tolerate one or a few concurrent
    connections -- you do not want 32 valves each opening their own TCP
    socket to the same relay board, and confirmed real hardware (DegDrive
    DGI900 inverters behind an RTU/TCP converter) makes this doubly true for
    motors: several inverters typically share ONE serial bus bridged to ONE
    TCP endpoint.
  - A "device" (see zone_runtime.py) is a scenario-facing channel *within*
    that instance -- e.g. valve #7 on relay bank "A", or motor slave-id 12 on
    gateway "gw_a". Multiple devices routinely share one DriverInstance.
"""
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
    """What every driver adapter must implement, regardless of protocol.
    ZoneRuntime and the WS command handlers only ever talk to this shape."""

    async def connect(self) -> bool: ...
    async def disconnect(self) -> None: ...
    async def emergency_stop(self) -> None: ...
    def is_connected(self) -> bool: ...

    async def register_channel(self, channel: str) -> bool:
        """Called once, when ADD_DEVICE first maps a device_id onto this
        channel. A no-op returning True for drivers where every channel is
        always valid once the instance is connected (a valve bank's 32
        channels, an Art-Net node's 8 universes). NOT a no-op for a shared
        Modbus gateway serving multiple inverters: each channel is a
        distinct unit/slave ID that needs its own bring-up sequence over the
        shared connection before it will respond to anything."""
        ...

    def apply_state(self, channel: str, state: dict[str, Any]) -> None:
        """Non-blocking, fire-and-forget -- mirrors set_valve_state/
        execute_motor_event/update_led's existing signatures. `state`'s
        shape is category-specific: {"on": bool} for a valve, {"frequency",
        "active"} for a motor, {"r","g","b"} for a light."""
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
    """Validates raw_config against the driver's own schema before
    construction -- a malformed device config fails here with a clear
    Pydantic error instead of surfacing as a confusing runtime AttributeError
    three calls deep into some controller. Returns the validated config
    alongside the instance: a caller that needs a schema field (e.g.
    total_channels) must read it from here, not from raw_config -- the raw
    dict doesn't reflect the schema's own defaults/coercions (an omitted
    total_channels defaults to 32 on the validated model but is simply
    absent from raw_config, and a string "32" from a form post coerces to
    int only on the validated model)."""
    descriptor = get_driver(driver_type)
    config = descriptor.config_model.model_validate(raw_config)
    return descriptor.factory(zone_id, instance_id, config, bus), config
