import { describe, expect, it } from "vitest";
import { generateValvePattern } from "./scenario";

const DEVICES = ["V1", "V2", "V3", "V4"];

function onAt(events: Array<{ time: number; device_id: string; on: boolean }>, time: number): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const e of events) if (e.time === time) out[e.device_id] = e.on;
  return out;
}

describe("generateValvePattern", () => {
  it("constant sets every selected device once, at startTime", () => {
    const events = generateValvePattern({ deviceIds: DEVICES, startTime: 2, endTime: 10, stepInterval: 1, pattern: "constant", constantOn: true });
    expect(events).toHaveLength(4);
    expect(events.every((e) => e.time === 2 && e.on === true)).toBe(true);
  });

  it("alternate flips which half of the selection is on each step", () => {
    const events = generateValvePattern({ deviceIds: DEVICES, startTime: 0, endTime: 1, stepInterval: 1, pattern: "alternate" });
    expect(onAt(events, 0)).toEqual({ V1: true, V2: false, V3: true, V4: false });
    expect(onAt(events, 1)).toEqual({ V1: false, V2: true, V3: false, V4: true });
  });

  it("wave lights exactly one valve at a time, advancing and wrapping", () => {
    const events = generateValvePattern({ deviceIds: DEVICES, startTime: 0, endTime: 4, stepInterval: 1, pattern: "wave" });
    expect(onAt(events, 0)).toEqual({ V1: true, V2: false, V3: false, V4: false });
    expect(onAt(events, 3)).toEqual({ V1: false, V2: false, V3: false, V4: true });
    expect(onAt(events, 4)).toEqual({ V1: true, V2: false, V3: false, V4: false }); // wraps back to V1
  });

  it("cascade keeps a sliding window of trailLength valves lit at once", () => {
    const events = generateValvePattern({ deviceIds: DEVICES, startTime: 0, endTime: 1, stepInterval: 1, pattern: "cascade", trailLength: 2 });
    expect(onAt(events, 0)).toEqual({ V1: true, V2: true, V3: false, V4: false });
    expect(onAt(events, 1)).toEqual({ V1: false, V2: true, V3: true, V4: false });
  });

  it("pingpong bounces at the ends instead of wrapping", () => {
    const events = generateValvePattern({ deviceIds: DEVICES, startTime: 0, endTime: 5, stepInterval: 1, pattern: "pingpong" });
    expect(onAt(events, 3)).toEqual({ V1: false, V2: false, V3: false, V4: true }); // reaches the far end...
    expect(onAt(events, 4)).toEqual({ V1: false, V2: false, V3: true, V4: false }); // ...and bounces back
    expect(onAt(events, 5)).toEqual({ V1: false, V2: true, V3: false, V4: false });
  });

  it("random at density 0 or 100 is deterministic (avoids a flaky test on real randomness)", () => {
    const allOn = generateValvePattern({ deviceIds: DEVICES, startTime: 0, endTime: 1, stepInterval: 1, pattern: "random", density: 100 });
    expect(allOn.every((e) => e.on === true)).toBe(true);

    const allOff = generateValvePattern({ deviceIds: DEVICES, startTime: 0, endTime: 1, stepInterval: 1, pattern: "random", density: 0 });
    expect(allOff.every((e) => e.on === false)).toBe(true);
  });
});
