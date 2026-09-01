"""
WebSocket wire protocol between the Electron/React HMI and the daemon.

Two independent message families travel over the same socket:
  - Command  (frontend -> backend): one command in, one Ack out, correlated by `id`.
  - Event    (backend -> frontend): unsolicited, pushed whenever hardware/playback state changes.

Both are discriminated unions keyed on a literal field, so a malformed or unknown
message fails Pydantic validation instead of being interpreted as something else.
"""
from __future__ import annotations

from typing import Annotated, Literal, Optional, Union
from uuid import uuid4

from pydantic import BaseModel, Field

#: Matches app.drivers.base.DeviceCategory's values exactly -- one vocabulary
#: for "what kind of thing is this" shared by the driver registry and the
#: wire protocol. A "nozzle" is not a category: it's two motor devices the
#: scenario/timeline groups together at authoring time, not a distinct
#: runtime concept the daemon needs to know about.
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
    """(Re)connects every driver instance already configured for this zone
    (via ADD_DRIVER_INSTANCE) -- instances connect at add-time, so this is
    mainly a retry after a drop. `device_types` omitted or empty means all."""
    command: Literal["CONNECT_ZONE"] = "CONNECT_ZONE"
    zone_id: int
    device_types: list[DeviceType] = []


class DisconnectZone(_CommandBase):
    command: Literal["DISCONNECT_ZONE"] = "DISCONNECT_ZONE"
    zone_id: int


class RenameZone(_CommandBase):
    """A zone otherwise only ever shows as its bare zone_id ("Zone 3") --
    this is purely a display label, never persisted anywhere else and never
    read by playback. `name=None`/empty clears it back to the bare id."""
    command: Literal["RENAME_ZONE"] = "RENAME_ZONE"
    zone_id: int
    name: Optional[str] = None


class DeleteZone(_CommandBase):
    """Tears down every driver instance/device this zone owns (same
    disconnect() a normal DISCONNECT_ZONE runs) and forgets the zone
    entirely -- unlike REMOVE_DRIVER_INSTANCE, which can leave an empty
    zone lingering, this removes the zone_id itself. Zones are otherwise
    never destroyed once created (see get_zone in main.py), so this is
    the only way to actually delete one instead of just emptying it."""
    command: Literal["DELETE_ZONE"] = "DELETE_ZONE"
    zone_id: int


class AddDriverInstance(_CommandBase):
    """Creates and connects one physical connection (a relay bank, a VFD, an
    Art-Net node) for a zone. `driver_type` must be one of the values from
    GET /drivers; `config` is validated against that driver's own schema."""
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
    """Registers a scenario-facing device_id as one channel on an existing
    driver instance -- e.g. device "V3" = channel "3" on instance "relay_bank_a".

    `nozzle_group`/`nozzle_inverter` are optional and only meaningful for a
    motor-category device that's one of a nozzle's two inverters (the
    reference PyQt6 app's Nozzle model: one fountain nozzle = two VFDs move
    together). Purely an authoring-time grouping label for the HMI's
    Nozzles tab -- the daemon still just sees two independent motor
    devices/events, nothing here changes playback."""
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
    """Forces an immediate reconnect attempt for ONE driver instance instead
    of waiting for its background watchdog's next pass (each driver retries
    on its own timer, up to a few seconds away) -- for right after power-
    cycling real hardware or fixing a cable, when the operator already
    knows it's back and doesn't want to sit through the wait. The outcome
    surfaces the same way any other connect attempt does (ConnectionStateEvent
    / HardwareErrorEvent on the bus), not as this command's own Ack --
    hardware still being unreachable isn't a bad command."""
    command: Literal["RECONNECT_INSTANCE"] = "RECONNECT_INSTANCE"
    zone_id: int
    instance_id: str


class SetDeviceState(_CommandBase):
    """Applies `parameters` to ONE device immediately, bypassing the
    scenario player entirely -- lets the Devices tab test "does this valve
    actually open" / "does this light actually turn that color" on real
    hardware without authoring and playing a whole scenario. Same
    parameters shape a scenario event for this device's category would use
    (see ScenarioEventDto)."""
    command: Literal["SET_DEVICE_STATE"] = "SET_DEVICE_STATE"
    zone_id: int
    device_id: str
    parameters: dict


class ResetMotorFault(_CommandBase):
    """Clears a tripped VFD fault (overcurrent, undervoltage, etc.) so the
    drive accepts run commands again -- sends the drive's own
    CMD_FAULT_RESET control word. The reference hardware (DegDrive DGI900)
    stays latched in fault after a trip until this is sent; without it, an
    operator's only recourse is power-cycling the drive by hand. Only
    meaningful for a motor-category device; the daemon reports Ack(ok=False)
    for anything else (unknown device, valve/light, or a driver that
    doesn't implement fault reset), same as any other bad command."""
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
"""Every inbound WS text frame must parse as this, e.g.:
{"command": "PLAY_SCENARIO", "zone_id": 3, "scenario_id": "kase_v2", "id": "..."}
`id` is optional on the way in (client may omit it, server fills a default);
the server echoes it back on the Ack so the client can correlate request/response."""


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


class DeviceStateEvent(BaseModel):
    """Fine-grained state for the 3D preview and the Devices tab's live
    status readout: one device's state changed.

    `device_id` is NOT the operator-facing device_id from ADD_DEVICE / the
    device map -- it's an internal id the low-level controller fabricates
    from its own addressing (an inverter's sequential motor_id, a valve's
    channel number), which has no relationship to what the operator named
    the device. Kept only for logging/uniqueness. `instance_id` + `channel`
    are what actually correlate to a GET /zones device entry (match on
    `instance_id` and `channel`) -- use those, not `device_id`."""
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
