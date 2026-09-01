import type { DeviceType } from "./protocol";

/**
 * Grid = the primary editor: dense per-device, per-time-step editing,
 * matching component_tables.py 1:1 (the reference PyQt6 app this HMI is
 * modernizing) -- a separate spreadsheet per device category, one column
 * per device, one row per time step, click-to-toggle + inline edit + bulk
 * ops + pattern generators. An earlier version of this editor also had a
 * Scene/Cue preset-library concept (named snapshots placed on a cue sheet);
 * that doesn't exist in the reference app at all and has been removed --
 * `events` (device_id + time + parameters) is the only authoring structure
 * now, same as what the daemon has always played directly.
 */

export interface ScenarioEvent {
  id: string;
  time: number;
  device_id: string;
  parameters: Record<string, unknown>;
}

export interface ScenarioFile {
  name: string;
  duration: number;
  music_file: string | null;
  events: ScenarioEvent[];
  deviceIds: string[]; // which zone devices this scenario's editor tabs show -- see resolveDeviceIds
}

/** Resolves which zone devices the editor tabs should show for a scenario.
 * Empty/missing `deviceIds` -- an old scenario saved before this field
 * existed, or a brand new one before the picker has been used -- resolves
 * to every device currently in the zone, matching what the editor showed
 * unconditionally before this feature existed. Evaluated live against the
 * CURRENT zone device list (not a snapshot), so a device added to the zone
 * after a scenario was last saved still shows up in it. Deliberately NOT
 * derived from which devices appear in `events`: under "state persists
 * until changed" semantics a device that's always off may have zero
 * events yet still legitimately belong to the scenario. */
export function resolveDeviceIds(deviceIds: string[], allZoneDeviceIds: string[]): string[] {
  return deviceIds.length > 0 ? deviceIds : allZoneDeviceIds;
}

/** What a freshly-added device state should default to, shaped to match
 * exactly what each driver's apply_state() expects (see
 * fountain-daemon/app/drivers/*.py). */
export function defaultParametersFor(category: DeviceType): Record<string, unknown> {
  switch (category) {
    case "valve":
      return { on: false };
    case "motor":
      return { frequency: 0, active: false };
    case "light":
      return { r: 255, g: 255, b: 255 };
  }
}

/** One-line human-readable summary of a device's state -- used anywhere a
 * value needs to be scanned at a glance without opening an editor. */
export function summarizeState(category: DeviceType, parameters: Record<string, unknown>): string {
  switch (category) {
    case "valve":
      return parameters.on ? "On" : "Off";
    case "motor": {
      const active = Boolean(parameters.active);
      const frequency = Number(parameters.frequency ?? 0);
      return active ? `${frequency.toFixed(1)} Hz` : "Off";
    }
    case "light": {
      const r = Number(parameters.r ?? 0);
      const g = Number(parameters.g ?? 0);
      const b = Number(parameters.b ?? 0);
      return `rgb(${r}, ${g}, ${b})`;
    }
  }
}

// -- valve pattern generators ---------------------------------------------
//
// Directly answers "open only even valves, close odd" (a one-off bulk
// assignment -- select the channels, pick On/Off, Apply) and "make some
// kind of animation" (Wave: a chase across channels; Alternate: a flashing
// pattern that flips every step) -- the wave/alternating pattern
// generators the original codebase had (component_tables.py) and the very
// first audit flagged as "worth keeping" but this project never got around
// to building until now. (component_tables.py also had a Cascade pattern --
// exactly one channel on at a time, rotating through the selection -- but
// nothing here ever surfaced it as a real, guided option, only as a
// same-named right-click item with no parameters of its own; dropped
// rather than kept half-wired.)

export type ValvePatternType = "constant" | "wave" | "alternate";

export interface ValvePatternOptions {
  deviceIds: string[]; // order matters for wave/alternate
  startTime: number;
  endTime: number;
  stepInterval: number;
  pattern: ValvePatternType;
  constantOn?: boolean; // for "constant"
  waveDelay?: number; // for "wave": seconds between each channel's activation
  onDuration?: number; // for "wave": how long each channel stays on
  field?: string; // parameter key to toggle -- "on" for valves, "active" for motors
}

function roundTime(t: number): number {
  return Math.round(t * 10) / 10;
}

export function generateValvePattern(opts: ValvePatternOptions): Array<{ time: number; device_id: string; on: boolean }> {
  const out: Array<{ time: number; device_id: string; on: boolean }> = [];

  if (opts.pattern === "constant") {
    const on = opts.constantOn ?? true;
    out.push(...opts.deviceIds.map((id) => ({ time: roundTime(opts.startTime), device_id: id, on })));
    return out;
  }

  if (opts.pattern === "wave") {
    const delay = Math.max(0.1, opts.waveDelay ?? 0.5);
    const onDuration = Math.max(0.1, opts.onDuration ?? delay);
    opts.deviceIds.forEach((id, index) => {
      const onAt = roundTime(opts.startTime + index * delay);
      const offAt = roundTime(onAt + onDuration);
      if (onAt <= opts.endTime) out.push({ time: onAt, device_id: id, on: true });
      if (offAt <= opts.endTime) out.push({ time: offAt, device_id: id, on: false });
    });
    return out;
  }

  // "alternate": flips which half of deviceIds is on every step, producing a
  // checkerboard flash across the selected channels for the whole range.
  const step = Math.max(0.1, opts.stepInterval);
  let stepIndex = 0;
  for (let t = opts.startTime; t <= opts.endTime + 1e-9; t += step, stepIndex++) {
    const time = roundTime(t);
    opts.deviceIds.forEach((id, index) => {
      out.push({ time, device_id: id, on: (index + stepIndex) % 2 === 0 });
    });
  }
  return out;
}
