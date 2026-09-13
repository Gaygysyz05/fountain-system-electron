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

export type ValvePatternType = "constant" | "alternate" | "wave" | "cascade" | "pingpong" | "random";

export interface ValvePatternOptions {
  deviceIds: string[]; // order matters for every pattern except "constant"
  startTime: number;
  endTime: number;
  stepInterval: number;
  pattern: ValvePatternType;
  constantOn?: boolean; // for "constant"
  trailLength?: number; // for "cascade" -- how many consecutive valves stay lit at once
  density?: number; // for "random" -- 0-100, chance each valve is on at a given step
  field?: string; // parameter key to toggle -- "on" for valves, "active" for motors
}

function roundTime(t: number): number {
  return Math.round(t * 10) / 10;
}

/** Bounces 0..n-1..0..n-1... instead of wrapping (period 2*(n-1) for n>1) -- the index sequence "pingpong" moves through. */
function pingpongPosition(step: number, n: number): number {
  if (n <= 1) return 0;
  const period = 2 * (n - 1);
  const pos = step % period;
  return pos < n ? pos : period - pos;
}

export function generateValvePattern(opts: ValvePatternOptions): Array<{ time: number; device_id: string; on: boolean }> {
  const out: Array<{ time: number; device_id: string; on: boolean }> = [];
  const n = opts.deviceIds.length;

  if (opts.pattern === "constant") {
    const on = opts.constantOn ?? true;
    out.push(...opts.deviceIds.map((id) => ({ time: roundTime(opts.startTime), device_id: id, on })));
    return out;
  }

  const step = Math.max(0.1, opts.stepInterval);
  const trailLength = Math.max(1, opts.trailLength ?? 3);
  const densityChance = Math.min(1, Math.max(0, (opts.density ?? 50) / 100));

  let stepIndex = 0;
  for (let t = opts.startTime; t <= opts.endTime + 1e-9; t += step, stepIndex++) {
    const time = roundTime(t);
    opts.deviceIds.forEach((id, index) => {
      let on: boolean;
      switch (opts.pattern) {
        case "alternate":
          // Flips which half of the selection is on each step, producing a checkerboard flash.
          on = (index + stepIndex) % 2 === 0;
          break;
        case "wave":
          // Exactly one valve lit at a time, moving down the line and wrapping -- a running chase.
          on = index === stepIndex % n;
          break;
        case "cascade": {
          // Like wave, but a window of `trailLength` consecutive valves stays lit, overlapping into a flowing wave instead of a single point.
          const distanceBehindHead = (index - (stepIndex % n) + n) % n;
          on = distanceBehindHead < trailLength;
          break;
        }
        case "pingpong":
          // Same single-valve chase as wave, but bounces back at each end instead of wrapping around.
          on = index === pingpongPosition(stepIndex, n);
          break;
        case "random":
          // Each valve independently rolls the dice every step -- baked into fixed events now, not re-randomized at playback.
          on = Math.random() < densityChance;
          break;
        default:
          on = false;
      }
      out.push({ time, device_id: id, on });
    });
  }
  return out;
}
