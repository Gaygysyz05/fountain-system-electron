import { describe, expect, it } from "vitest";
import type { AudioAnalysis } from "./audioAnalysis";
import type { ScenarioEvent } from "./scenario";
import { enforceMinHoldTime, generateScenarioFromMusic, rotateArray } from "./musicGenerator";

function makeAnalysis(overrides: Partial<AudioAnalysis> = {}): AudioAnalysis {
  return {
    duration: 4.0,
    sampleRate: 22050,
    onsets: [],
    bassOnsets: [],
    trebleOnsets: [],
    energy: [{ time: 0, value: 0.5 }],
    bassEnergy: [{ time: 0, value: 0.5 }],
    ...overrides,
  };
}

describe("generateScenarioFromMusic", () => {
  it("produces no events for a category that wasn't selected, even if device ids were provided", () => {
    const analysis = makeAnalysis({ onsets: [1.0], bassOnsets: [1.0], trebleOnsets: [1.0] });
    const events = generateScenarioFromMusic(analysis, {
      categories: new Set(["light"]),
      valveDeviceIds: ["V1"],
      motorDeviceIds: ["M1"],
      lightDeviceIds: ["L1"],
    });

    expect(events.every((e) => e.device_id === "L1")).toBe(true);
    expect(events.length).toBeGreaterThan(0);
  });

  it("produces no events at all for a selected category with no device ids", () => {
    const events = generateScenarioFromMusic(makeAnalysis(), {
      categories: new Set(["valve", "motor", "light"]),
      valveDeviceIds: [],
      motorDeviceIds: [],
      lightDeviceIds: [],
    });
    expect(events).toEqual([]);
  });

  it("motor frequency tracks bassEnergy and active follows the same threshold as frequency > 0", () => {
    const analysis = makeAnalysis({
      duration: 1.0,
      bassEnergy: [
        { time: 0, value: 0 },
        { time: 0.5, value: 1.0 },
      ],
    });
    const events = generateScenarioFromMusic(analysis, {
      categories: new Set(["motor"]),
      valveDeviceIds: [],
      motorDeviceIds: ["Invertor-1"],
      lightDeviceIds: [],
      motorMaxFrequency: 40,
      motorSampleInterval: 0.5,
    });

    const quiet = events.find((e) => e.time === 0);
    const loud = events.find((e) => e.time === 0.5);
    expect(quiet?.parameters).toEqual({ frequency: 0, active: false });
    expect(loud?.parameters).toEqual({ frequency: 40, active: true });
  });

  it("a light flashes near each onset and decays shortly after, round-robinned across multiple lights", () => {
    const analysis = makeAnalysis({ onsets: [1.0, 2.0], trebleOnsets: [], energy: [{ time: 0, value: 1.0 }] });
    const events = generateScenarioFromMusic(analysis, {
      categories: new Set(["light"]),
      valveDeviceIds: [],
      motorDeviceIds: [],
      lightDeviceIds: ["L1", "L2"],
      lightFlashColor: [200, 100, 50],
    });

    // Two onsets round-robinned across two lights -> one flash (+ one decay) each, no light sees both onsets.
    const forL1 = events.filter((e) => e.device_id === "L1");
    const forL2 = events.filter((e) => e.device_id === "L2");
    expect(forL1).toHaveLength(2); // flash + decay
    expect(forL2).toHaveLength(2);

    const flash = forL1.find((e) => e.time === 1.0);
    expect(flash?.parameters).toEqual({ r: 200, g: 100, b: 50 }); // full energy (1.0) -> flashScale 1.0, no attenuation
    const decay = forL1.find((e) => e.time === 1.3);
    expect(decay).toBeTruthy();
    expect((decay?.parameters.r as number) ?? 0).toBeLessThan(200);
  });

  it("valve section baseline opens a count of valves proportional to that section's loudness", () => {
    const analysis = makeAnalysis({
      duration: 2.0,
      bassOnsets: [],
      energy: [
        { time: 0.5, value: 0 }, // sampled at section 0's (t=0..1) midpoint: quiet
        { time: 1.5, value: 1.0 }, // sampled at section 1's (t=1..2) midpoint: loud
      ],
    });
    const events = generateScenarioFromMusic(analysis, {
      categories: new Set(["valve"]),
      valveDeviceIds: ["V1", "V2", "V3", "V4"],
      motorDeviceIds: [],
      lightDeviceIds: [],
      valveSectionCount: 2,
    });

    const quietSection = events.filter((e) => e.time === 0);
    const loudSection = events.filter((e) => e.time === 1.0);
    expect(quietSection.filter((e) => e.parameters.on === true)).toHaveLength(1); // Math.max(1, round(0*4)) = 1
    expect(loudSection.filter((e) => e.parameters.on === true)).toHaveLength(4); // round(1.0*4) = 4
  });

  it("a strong bass onset triggers a cascade pulse across the valve set (reusing generateValvePattern)", () => {
    const analysis = makeAnalysis({ duration: 2.0, bassOnsets: [1.0], energy: [{ time: 0, value: 0 }] });
    const events = generateScenarioFromMusic(analysis, {
      categories: new Set(["valve"]),
      valveDeviceIds: ["V1", "V2", "V3", "V4"],
      motorDeviceIds: [],
      lightDeviceIds: [],
      valveSectionCount: 1,
    });

    // The pulse starts at the onset (t=1.0) and steps every 0.5s (the default minToggleHoldSeconds) -- something beyond the flat section baseline (only at t=0) must exist after it.
    const pulseWindowEvents = events.filter((e) => e.time > 0.9);
    expect(pulseWindowEvents.length).toBeGreaterThan(0);
  });

  it("no two events for the same valve ever land closer together than valveMinToggleHoldSeconds, even across a section baseline and a colliding pulse", () => {
    // A bass onset landing just after a section boundary is exactly the case that used to chatter the relay: the pulse's own opening step could fall well under the default 0.5s hardware minimum after the baseline it's overriding.
    const analysis = makeAnalysis({
      duration: 4.0,
      bassOnsets: [0.2],
      energy: [{ time: 2, value: 0.5 }],
    });
    const events = generateScenarioFromMusic(analysis, {
      categories: new Set(["valve"]),
      valveDeviceIds: ["V1", "V2", "V3", "V4"],
      motorDeviceIds: [],
      lightDeviceIds: [],
      valveSectionCount: 1,
      valveMinToggleHoldSeconds: 0.5,
    });

    const byDevice = new Map<string, ScenarioEvent[]>();
    for (const e of events) {
      const list = byDevice.get(e.device_id) ?? [];
      list.push(e);
      byDevice.set(e.device_id, list);
    }
    for (const deviceEvents of byDevice.values()) {
      const times = deviceEvents.map((e) => e.time).sort((a, b) => a - b);
      for (let i = 1; i < times.length; i++) {
        expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(0.5);
      }
    }
  });

  it("consecutive cascade pulses start at different valves instead of always sweeping from the first one, so a track with many bass onsets eventually uses the whole bank", () => {
    const deviceIds = Array.from({ length: 12 }, (_, i) => `V${i + 1}`);
    // Onsets spaced well past one pulse's own duration (so withMinSpacing keeps all of them) and past the show's short duration otherwise -- just enough onsets to prove the starting point actually moves.
    const analysis = makeAnalysis({ duration: 30, bassOnsets: [1, 6, 11, 16], energy: [{ time: 0, value: 0 }] });
    const events = generateScenarioFromMusic(analysis, {
      categories: new Set(["valve"]),
      valveDeviceIds: deviceIds,
      motorDeviceIds: [],
      lightDeviceIds: [],
      valveSectionCount: 1,
    });

    // Every "on" event's time bucketed by which pulse produced it (grouped by proximity to each onset time) -- the SET of devices that ever turn on must be more than just the first few, proving the pulses didn't all start at V1.
    const devicesEverOn = new Set(events.filter((e) => e.parameters.on === true).map((e) => e.device_id));
    expect(devicesEverOn.size).toBeGreaterThan(deviceIds.length / 2);
  });

  it("dedupes to one event per (device_id, time), keeping the later-generated one", () => {
    // A bass onset landing exactly on a section boundary makes the pulse and the section baseline collide at the same timestamp -- the pulse (generated after the baseline) must win, proving generation order controls the merge the same way timelineStore's upsertEvents does.
    const analysis = makeAnalysis({ duration: 2.0, bassOnsets: [0.0], energy: [{ time: 0, value: 0 }] });
    const events = generateScenarioFromMusic(analysis, {
      categories: new Set(["valve"]),
      valveDeviceIds: ["V1"],
      motorDeviceIds: [],
      lightDeviceIds: [],
      valveSectionCount: 1,
    });

    const atZero = events.filter((e) => e.device_id === "V1" && e.time === 0);
    expect(atZero).toHaveLength(1);
  });
});

describe("enforceMinHoldTime", () => {
  function evt(deviceId: string, time: number): ScenarioEvent {
    return { id: `${deviceId}-${time}`, time, device_id: deviceId, parameters: { on: true } };
  }

  it("drops an event landing sooner than minHoldSeconds after the previous KEPT one for that device", () => {
    const kept = enforceMinHoldTime([evt("V1", 0), evt("V1", 0.2), evt("V1", 0.6)], 0.5);
    // 0.2 is only 0.2s after 0 (dropped); 0.6 is 0.6s after the last KEPT event (0), which is >= 0.5, so it survives.
    expect(kept.map((e) => e.time)).toEqual([0, 0.6]);
  });

  it("is independent per device -- one device's drops never affect another's", () => {
    const kept = enforceMinHoldTime([evt("V1", 0), evt("V1", 0.1), evt("V2", 0), evt("V2", 0.05)], 0.5);
    expect(kept.filter((e) => e.device_id === "V1")).toHaveLength(1);
    expect(kept.filter((e) => e.device_id === "V2")).toHaveLength(1);
  });

  it("keeps events that are already spaced far enough apart, unchanged", () => {
    const kept = enforceMinHoldTime([evt("V1", 0), evt("V1", 1), evt("V1", 2)], 0.5);
    expect(kept.map((e) => e.time)).toEqual([0, 1, 2]);
  });

  it("does not require input already sorted by time", () => {
    const kept = enforceMinHoldTime([evt("V1", 2), evt("V1", 0), evt("V1", 0.1)], 0.5);
    expect(kept.map((e) => e.time)).toEqual([0, 2]);
  });
});

describe("rotateArray", () => {
  it("shifts elements left by offset, wrapping around", () => {
    expect(rotateArray([1, 2, 3, 4, 5], 2)).toEqual([3, 4, 5, 1, 2]);
  });

  it("treats an offset equal to the array length as a no-op", () => {
    expect(rotateArray(["a", "b", "c"], 3)).toEqual(["a", "b", "c"]);
  });

  it("wraps a negative offset correctly instead of producing empty slices", () => {
    expect(rotateArray([1, 2, 3, 4], -1)).toEqual([4, 1, 2, 3]);
  });

  it("returns an empty array unchanged rather than dividing by zero", () => {
    expect(rotateArray([], 5)).toEqual([]);
  });
});
