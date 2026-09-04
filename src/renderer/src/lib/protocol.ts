/**
 * Hand-written TypeScript mirror of fountain-daemon/app/protocol.py.
 * Keep these two files in sync manually for now; if the protocol grows past
 * a handful of message types, generate this from the Pydantic schema
 * instead (e.g. via `pydantic.TypeAdapter(...).json_schema()` + a
 * json-schema-to-typescript step) rather than hand-syncing indefinitely.
 */

// Matches app.drivers.base.DeviceCategory exactly. A "nozzle" is not a
// category -- it's two motor devices grouped at authoring time, not
// something the daemon's driver registry or protocol needs to know about.
export type DeviceType = "valve" | "motor" | "light";
export type Subsystem = DeviceType | "daemon";
export type Severity = "info" | "warning" | "critical";
export type ZoneState = "stopped" | "connecting" | "ready" | "playing" | "paused" | "error";

// -- Commands: renderer -> daemon -------------------------------------------

interface CommandBase {
  id?: string; // optional on the way out; the daemon fills a default if omitted
}

export interface ConnectZoneCommand extends CommandBase {
  command: "CONNECT_ZONE";
  zone_id: number;
  device_types?: DeviceType[];
}

export interface DisconnectZoneCommand extends CommandBase {
  command: "DISCONNECT_ZONE";
  zone_id: number;
}

export interface RenameZoneCommand extends CommandBase {
  command: "RENAME_ZONE";
  zone_id: number;
  name: string | null;
}

export interface DeleteZoneCommand extends CommandBase {
  command: "DELETE_ZONE";
  zone_id: number;
}

export interface AddDriverInstanceCommand extends CommandBase {
  command: "ADD_DRIVER_INSTANCE";
  zone_id: number;
  instance_id: string;
  driver_type: string;
  config: Record<string, unknown>;
}

export interface RemoveDriverInstanceCommand extends CommandBase {
  command: "REMOVE_DRIVER_INSTANCE";
  zone_id: number;
  instance_id: string;
}

export interface AddDeviceCommand extends CommandBase {
  command: "ADD_DEVICE";
  zone_id: number;
  device_id: string;
  instance_id: string;
  channel: string;
  nozzle_group?: string | null;
  nozzle_inverter?: 1 | 2 | null;
}

export interface RemoveDeviceCommand extends CommandBase {
  command: "REMOVE_DEVICE";
  zone_id: number;
  device_id: string;
}

export interface PlayScenarioCommand extends CommandBase {
  command: "PLAY_SCENARIO";
  zone_id: number;
  scenario_id: string;
}

export interface StopZoneCommand extends CommandBase {
  command: "STOP_ZONE";
  zone_id: number;
}

export interface PauseZoneCommand extends CommandBase {
  command: "PAUSE_ZONE";
  zone_id: number;
}

export interface SeekZoneCommand extends CommandBase {
  command: "SEEK_ZONE";
  zone_id: number;
  position: number;
}

export interface SetLoopCommand extends CommandBase {
  command: "SET_LOOP";
  zone_id: number;
  enabled: boolean;
}

export interface SetGlobalBrightnessCommand extends CommandBase {
  command: "SET_GLOBAL_BRIGHTNESS";
  zone_id: number;
  value: number;
}

export interface SetGlobalSpeedCommand extends CommandBase {
  command: "SET_GLOBAL_SPEED";
  zone_id: number;
  value: number;
}

export interface EmergencyStopCommand extends CommandBase {
  command: "EMERGENCY_STOP";
  zone_id?: number | null;
}

/** Clears a tripped VFD fault (overcurrent, etc.) so the drive accepts run
 * commands again -- see app/protocol.py's ResetMotorFault. Only meaningful
 * for a motor-category device_id; the daemon Acks(ok=false) otherwise. */
export interface ResetMotorFaultCommand extends CommandBase {
  command: "RESET_MOTOR_FAULT";
  zone_id: number;
  device_id: string;
}

/** Forces an immediate reconnect attempt for one driver instance instead of
 * waiting for its background watchdog's next pass -- see
 * app/protocol.py's ReconnectInstance. The outcome shows up as a
 * ConnectionStateEvent/HardwareErrorEvent like any other connect attempt,
 * not as this command's own ok/error. */
export interface ReconnectInstanceCommand extends CommandBase {
  command: "RECONNECT_INSTANCE";
  zone_id: number;
  instance_id: string;
}

/** Applies parameters to one device right now, bypassing the scenario
 * player -- for testing a device from the Devices tab. Same parameter
 * shape a scenario event for that category would use ({on} for valve,
 * {frequency, active} for motor, {r,g,b} for light). */
export interface SetDeviceStateCommand extends CommandBase {
  command: "SET_DEVICE_STATE";
  zone_id: number;
  device_id: string;
  parameters: Record<string, unknown>;
}

export type Command =
  | ConnectZoneCommand
  | DisconnectZoneCommand
  | RenameZoneCommand
  | DeleteZoneCommand
  | AddDriverInstanceCommand
  | RemoveDriverInstanceCommand
  | AddDeviceCommand
  | RemoveDeviceCommand
  | PlayScenarioCommand
  | StopZoneCommand
  | PauseZoneCommand
  | SeekZoneCommand
  | SetLoopCommand
  | SetGlobalBrightnessCommand
  | SetGlobalSpeedCommand
  | EmergencyStopCommand
  | ReconnectInstanceCommand
  | SetDeviceStateCommand
  | ResetMotorFaultCommand;

// -- Ack: daemon -> renderer, one per command, correlated by id -------------

export interface Ack {
  type: "ack";
  id: string;
  ok: boolean;
  error: string | null;
}

// -- Events: daemon -> renderer, streamed continuously -----------------------

export interface ZoneStatusEvent {
  type: "zone_status";
  zone_id: number;
  state: ZoneState;
  scenario_id: string | null;
  position: number;
  duration: number;
  is_looping: boolean;
}

export interface DeviceStateEvent {
  type: "device_event";
  zone_id: number;
  /** NOT the operator-facing device_id from GET /zones -- an internal id
   * the daemon's low-level controller fabricates from its own addressing
   * (see app/protocol.py's DeviceStateEvent docstring). Use `instance_id` +
   * `channel` to correlate against a ZoneConfigDto device entry instead. */
  device_id: string;
  instance_id: string;
  channel: string;
  device_type: DeviceType;
  state: Record<string, unknown>;
}

export interface ConnectionStateEvent {
  type: "connection_state";
  zone_id: number;
  subsystem: Subsystem;
  connected: boolean;
  detail: string | null;
}

export interface HardwareErrorEvent {
  type: "hardware_error";
  zone_id: number | null;
  subsystem: Subsystem;
  message: string;
  severity: Severity;
}

export interface HeartbeatEvent {
  type: "heartbeat";
  ts: number;
}

export type DaemonEvent =
  | ZoneStatusEvent
  | DeviceStateEvent
  | ConnectionStateEvent
  | HardwareErrorEvent
  | HeartbeatEvent;

/** Anything the daemon can send on the wire: an Ack, or one of the Event types. */
export type IncomingMessage = Ack | DaemonEvent;

export function isAck(msg: IncomingMessage): msg is Ack {
  return msg.type === "ack";
}

// -- REST: GET /drivers -------------------------------------------------------

/** One entry per registered driver (app/drivers/base.py's DriverDescriptor).
 * `config_schema` is a JSON Schema object -- render the add-device form from
 * it rather than hardcoding fields per driver_type. */
export interface DriverDescriptorDto {
  driver_type: string;
  category: DeviceType;
  display_name: string;
  config_schema: Record<string, unknown>;
}

// -- REST: GET /zones ----------------------------------------------------------

export interface DriverInstanceDto {
  instance_id: string;
  driver_type: string;
  category: DeviceType;
  connected: boolean;
  config: Record<string, unknown>;
}

export interface DeviceDto {
  device_id: string;
  instance_id: string;
  channel: string;
  category: DeviceType;
  // Only meaningful for a motor-category device that's one of a nozzle's
  // two inverters (the reference app's Nozzle model -- see
  // component_tables_nozzle.py). null/undefined for every other device.
  nozzle_group?: string | null;
  nozzle_inverter?: 1 | 2 | null;
}

export interface ZoneConfigDto {
  zone_id: number;
  /** Display label only -- unset zones fall back to "Zone {id}" everywhere. */
  name?: string | null;
  driver_instances: DriverInstanceDto[];
  devices: DeviceDto[];
  /** Current live-control multipliers (0-100), runtime-only on the daemon
   * (never persisted) -- this is how the HMI's brightness/speed sliders
   * learn the real current value on load/reconnect instead of assuming 100. */
  global_brightness: number;
  global_speed: number;
}

// -- REST: GET /scenarios -------------------------------------------------------

export interface ScenarioDto {
  scenario_id: string;
  name: string;
  duration: number;
}

// -- REST: /schedule -----------------------------------------------------------

/** Matches app/persistence.py's ScheduleEntryDto. `time` is "HH:MM" 24h
 * local time; `days` is 0=Monday..6=Sunday, empty = every day. */
export interface ScheduleEntryDto {
  id: string;
  zone_id: number;
  scenario_id: string;
  time: string;
  days: number[];
  enabled: boolean;
  last_fired_date: string | null;
}

export interface ScheduleEntryInput {
  zone_id: number;
  scenario_id: string;
  time: string;
  days: number[];
  enabled: boolean;
}

// -- REST: GET /audit -----------------------------------------------------------

/** Matches app/persistence.py's audit log entry shape -- what command ran,
 * when, and whether it succeeded. There's no operator-identity system on
 * this single shared panel, so this answers "what happened", not "who". */
export interface AuditLogEntryDto {
  ts: string;
  command: string;
  zone_id: number | null;
  ok: boolean;
  error: string | null;
}
