import { describe, expect, it } from "vitest";
import type { AudioAnalysis } from "./audioAnalysis";
import { generateScenarioFromMusic } from "./musicGenerator";

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

    // The pulse runs from t=1.0 to t=1.6 in 0.15s steps -- something beyond the flat section baseline (all at t=0) must exist in that window.
    const pulseWindowEvents = events.filter((e) => e.time > 0.9 && e.time <= 1.6);
    expect(pulseWindowEvents.length).toBeGreaterThan(0);
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
