import type { DeviceType } from "./protocol";

/** Matches component_tables.py 1:1 (the reference app being modernized); `events` (device_id + time + parameters) is deliberately the only authoring structure -- no Scene/Cue preset library, since the reference app has none. */

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

/** Empty/missing `deviceIds` falls back to every device currently in the zone (old/new scenarios); deliberately NOT derived from `events`, since under "state persists until changed" semantics a device can legitimately belong with zero events. */
export function resolveDeviceIds(deviceIds: string[], allZoneDeviceIds: string[]): string[] {
  return deviceIds.length > 0 ? deviceIds : allZoneDeviceIds;
}

/** Shaped to match exactly what each driver's apply_state() expects (see fountain-daemon/app/drivers/*.py). */
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

/** One-line human-readable summary of a device's state, for at-a-glance scanning without opening an editor. */
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
// Only "constant" (bulk on/off) and "alternate" (flip-every-step flash) are implemented; component_tables.py's Wave/Cascade patterns were not carried over.

export type ValvePatternType = "constant" | "alternate";

export interface ValvePatternOptions {
  deviceIds: string[]; // order matters for "alternate"
  startTime: number;
  endTime: number;
  stepInterval: number;
  pattern: ValvePatternType;
  constantOn?: boolean; // for "constant"
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

  // Flips which half of deviceIds is on each step, producing a checkerboard flash across the selection.
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
