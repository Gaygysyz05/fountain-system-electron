"""WS wire protocol: Command (frontend->backend, Ack'd by `id`) and Event (backend->frontend) are discriminated unions on a literal field, so malformed/unknown messages fail validation instead of being silently misinterpreted."""
from __future__ import annotations

from typing import Annotated, Literal, Optional, Union
from uuid import uuid4

from pydantic import BaseModel, Field

#: Mirrors app.drivers.base.DeviceCategory; "nozzle" is deliberately absent -- it's just two motor devices grouped at authoring time, not a runtime category.
DeviceType = Literal["valve", "motor", "light"]
Subsystem = Literal["valve", "motor", "light", "daemon"]
Severity = Literal["info", "warning", "critical"]
ZoneState = Literal["stopped", "connecting", "ready", "playing", "paused", "error"]


# ---------------------------------------------------------------------------
# Commands: frontend -> backend
# ---------------------------------------------------------------------------

class _CommandBase(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)


class ConnectZone(_CommandBase):
    """Reconnects already-configured instances (they connect at add-time via ADD_DRIVER_INSTANCE, so this is mainly a drop-retry); empty `device_types` means all."""
    command: Literal["CONNECT_ZONE"] = "CONNECT_ZONE"
    zone_id: int
    device_types: list[DeviceType] = []


class DisconnectZone(_CommandBase):
    command: Literal["DISCONNECT_ZONE"] = "DISCONNECT_ZONE"
    zone_id: int


class RenameZone(_CommandBase):
    """Purely a display label -- never persisted elsewhere, never read by playback; `name=None`/empty reverts to the bare zone_id."""
    command: Literal["RENAME_ZONE"] = "RENAME_ZONE"
    zone_id: int
    name: Optional[str] = None


class DeleteZone(_CommandBase):
    """Disconnects everything and removes the zone_id itself -- the only way to actually delete a zone (they're otherwise never destroyed once created; see get_zone in main.py)."""
    command: Literal["DELETE_ZONE"] = "DELETE_ZONE"
    zone_id: int


class AddDriverInstance(_CommandBase):
    """`driver_type` must be one of the values from GET /drivers; `config` is validated against that driver's own schema."""
    command: Literal["ADD_DRIVER_INSTANCE"] = "ADD_DRIVER_INSTANCE"
    zone_id: int
    instance_id: str
    driver_type: str
    config: dict


class RemoveDriverInstance(_CommandBase):
    command: Literal["REMOVE_DRIVER_INSTANCE"] = "REMOVE_DRIVER_INSTANCE"
    zone_id: int
    instance_id: str


class AddDevice(_CommandBase):
    """`nozzle_group`/`nozzle_inverter` are purely an authoring-time label for the HMI's Nozzles tab (one fountain nozzle = two VFDs moving together, per the reference PyQt6 app's Nozzle model) -- the daemon still sees two independent motor devices and playback is unaffected."""
    command: Literal["ADD_DEVICE"] = "ADD_DEVICE"
    zone_id: int
    device_id: str
    instance_id: str
    channel: str
    nozzle_group: Optional[str] = None
    nozzle_inverter: Optional[int] = None


class RemoveDevice(_CommandBase):
    command: Literal["REMOVE_DEVICE"] = "REMOVE_DEVICE"
    zone_id: int
    device_id: str


class PlayScenario(_CommandBase):
    command: Literal["PLAY_SCENARIO"] = "PLAY_SCENARIO"
    zone_id: int
    scenario_id: str


class StopZone(_CommandBase):
    command: Literal["STOP_ZONE"] = "STOP_ZONE"
    zone_id: int


class PauseZone(_CommandBase):
    command: Literal["PAUSE_ZONE"] = "PAUSE_ZONE"
    zone_id: int


class SeekZone(_CommandBase):
    command: Literal["SEEK_ZONE"] = "SEEK_ZONE"
    zone_id: int
    position: float = Field(ge=0)


class SetLoop(_CommandBase):
    command: Literal["SET_LOOP"] = "SET_LOOP"
    zone_id: int
    enabled: bool


class SetGlobalBrightness(_CommandBase):
    command: Literal["SET_GLOBAL_BRIGHTNESS"] = "SET_GLOBAL_BRIGHTNESS"
    zone_id: int
    value: int = Field(ge=0, le=100)


class SetGlobalSpeed(_CommandBase):
    command: Literal["SET_GLOBAL_SPEED"] = "SET_GLOBAL_SPEED"
    zone_id: int
    value: int = Field(ge=0, le=100)


class EmergencyStop(_CommandBase):
    command: Literal["EMERGENCY_STOP"] = "EMERGENCY_STOP"
    zone_id: Optional[int] = None  # None = all zones


class ReconnectInstance(_CommandBase):
    """Forces an immediate reconnect instead of waiting for the driver's own watchdog retry timer; outcome surfaces via ConnectionStateEvent/HardwareErrorEvent, not this command's Ack -- hardware being unreachable isn't itself a bad command."""
    command: Literal["RECONNECT_INSTANCE"] = "RECONNECT_INSTANCE"
    zone_id: int
    instance_id: str


class SetDeviceState(_CommandBase):
    """Applies `parameters` to one device immediately, bypassing the scenario player, using the same shape a scenario event for that device's category would use (see ScenarioEventDto)."""
    command: Literal["SET_DEVICE_STATE"] = "SET_DEVICE_STATE"
    zone_id: int
    device_id: str
    parameters: dict


class ResetMotorFault(_CommandBase):
    """Sends CMD_FAULT_RESET to clear a tripped VFD fault -- the reference DegDrive DGI900 stays latched until this is sent, otherwise the only recourse is power-cycling it by hand."""
    command: Literal["RESET_MOTOR_FAULT"] = "RESET_MOTOR_FAULT"
    zone_id: int
    device_id: str


Command = Annotated[
    Union[
        ConnectZone,
        DisconnectZone,
        RenameZone,
        DeleteZone,
        AddDriverInstance,
        RemoveDriverInstance,
        AddDevice,
        RemoveDevice,
        PlayScenario,
        StopZone,
        PauseZone,
        SeekZone,
        SetLoop,
        SetGlobalBrightness,
        SetGlobalSpeed,
        EmergencyStop,
        ReconnectInstance,
        SetDeviceState,
        ResetMotorFault,
    ],
    Field(discriminator="command"),
]
"""Every inbound WS frame must parse as this; `id` is optional in (server fills a default) and echoed back on the Ack so the client can correlate request/response."""


# ---------------------------------------------------------------------------
# Acks: backend -> frontend, one per received command, correlated by id
# ---------------------------------------------------------------------------

class Ack(BaseModel):
    type: Literal["ack"] = "ack"
    id: str
    ok: bool
    error: Optional[str] = None


# ---------------------------------------------------------------------------
# Events: backend -> frontend, unsolicited, streamed continuously
# ---------------------------------------------------------------------------

class ZoneStatusEvent(BaseModel):
    type: Literal["zone_status"] = "zone_status"
    zone_id: int
    state: ZoneState
    scenario_id: Optional[str] = None
    position: float = 0.0
    duration: float = 0.0
    # Reported so a reconnecting HMI or second window can learn the loop state instead of assuming off.
    is_looping: bool = False


class DeviceStateEvent(BaseModel):
    """`device_id` is an internal id fabricated by the low-level controller (NOT the operator-facing ADD_DEVICE id) -- match on `instance_id`+`channel` against GET /zones instead."""
    type: Literal["device_event"] = "device_event"
    zone_id: int
    device_id: str
    instance_id: str
    channel: str
    device_type: DeviceType
    state: dict  # e.g. {"on": true} / {"frequency": 32.5, "active": true} / {"r":255,"g":0,"b":0}


class ConnectionStateEvent(BaseModel):
    type: Literal["connection_state"] = "connection_state"
    zone_id: int
    subsystem: Subsystem
    connected: bool
    detail: Optional[str] = None


class HardwareErrorEvent(BaseModel):
    """Modbus drop, Art-Net send failure, etc. Always survivable — never a crash."""
    type: Literal["hardware_error"] = "hardware_error"
    zone_id: Optional[int]
    subsystem: Subsystem
    message: str
    severity: Severity = "warning"


class HeartbeatEvent(BaseModel):
    """Lets the frontend distinguish 'daemon alive, nothing happening' from a dead socket."""
    type: Literal["heartbeat"] = "heartbeat"
    ts: float


Event = Annotated[
    Union[
        ZoneStatusEvent,
        DeviceStateEvent,
        ConnectionStateEvent,
        HardwareErrorEvent,
        HeartbeatEvent,
    ],
    Field(discriminator="type"),
]
