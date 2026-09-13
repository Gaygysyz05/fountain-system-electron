/** Guards the property the per-event unit tests in musicGenerator.test.ts can't see: two DIFFERENT
 * tracks must produce visibly different shows. The original mapping failed exactly here -- the valve
 * layer was driven by two constants (a fixed 4-way section split with a fixed rotation, plus cascade
 * pulses forced onto a fixed ~3s grid by withMinSpacing), so every mastered track (whose normalized
 * RMS sits near its own peak almost everywhere) came out structurally identical. These tests compare
 * whole generated streams against each other rather than checking any single event. */
import { describe, expect, it } from "vitest";
import type { AudioAnalysis, EnvelopePoint } from "./audioAnalysis";
import { generateScenarioFromMusic, type MusicGeneratorCategory } from "./musicGenerator";
import type { ScenarioEvent } from "./scenario";

const VALVES = Array.from({ length: 24 }, (_, i) => `V${i + 1}`);
const DURATION = 120;

function envelope(duration: number, shape: (t: number) => number, hop = 0.1): EnvelopePoint[] {
  const out: EnvelopePoint[] = [];
  for (let t = 0; t <= duration + 1e-9; t += hop) {
    out.push({ time: Math.round(t * 100) / 100, value: Math.min(1, Math.max(0, shape(t))) });
  }
  return out;
}

/** Onsets on a regular grid -- a real detector's output is jittery, but regularity here is the point: it isolates "does the GENERATOR react to density/tempo" from "is the detector any good". */
function onsetGrid(duration: number, every: number, offset = 0): number[] {
  const out: number[] = [];
  for (let t = offset; t <= duration; t += every) out.push(Math.round(t * 1000) / 1000);
  return out;
}

interface TrackSpec {
  bassEvery: number;
  trebleEvery: number;
  energy: (t: number) => number;
  bpm?: number; // omitted -> no detectable pulse, exercising the generator's tempo-free fallback
}

function analysisFor(spec: TrackSpec): AudioAnalysis {
  return {
    duration: DURATION,
    sampleRate: 44100,
    onsets: onsetGrid(DURATION, Math.min(spec.bassEvery, spec.trebleEvery)),
    bassOnsets: onsetGrid(DURATION, spec.bassEvery),
    trebleOnsets: onsetGrid(DURATION, spec.trebleEvery, spec.trebleEvery / 2),
    energy: envelope(DURATION, spec.energy),
    bassEnergy: envelope(DURATION, (t) => spec.energy(t) * 0.9),
    trebleEnergy: envelope(DURATION, (t) => spec.energy(t) * 0.5),
    tempo: spec.bpm ? { bpm: spec.bpm, beatPeriod: 60 / spec.bpm, phase: 0, confidence: 0.9 } : null,
  };
}

function valveEventsFor(analysis: AudioAnalysis): ScenarioEvent[] {
  return generateScenarioFromMusic(analysis, {
    categories: new Set<MusicGeneratorCategory>(["valve"]),
    valveDeviceIds: VALVES,
    motorDeviceIds: [],
    lightDeviceIds: [],
  });
}

interface Fingerprint {
  events: number;
  transitionsPerSecond: number;
  /** Median gap between consecutive distinct event times -- the show's visible cadence. */
  medianCadence: number;
  tuples: Set<string>;
}

function fingerprint(events: ScenarioEvent[]): Fingerprint {
  const times = [...new Set(events.map((e) => e.time))].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push(Math.round((times[i] - times[i - 1]) * 1000) / 1000);
  gaps.sort((a, b) => a - b);

  return {
    events: events.length,
    transitionsPerSecond: events.length / DURATION,
    medianCadence: gaps.length > 0 ? gaps[Math.floor(gaps.length / 2)] : 0,
    tuples: new Set(events.map((e) => `${e.device_id}@${e.time}=${e.parameters.on === true ? 1 : 0}`)),
  };
}

/** Most valves open at any single instant within a window. Measures how WIDE the show runs there,
 * without the confound that time-integrated "open share" has: a calm section holding its valves open
 * scores higher than a busy one flickering twice as many, which says nothing about either one's width. */
function peakConcurrentOpen(events: ScenarioEvent[], from: number, to: number): number {
  const ordered = [...events].sort((a, b) => a.time - b.time);
  const state = new Map<string, boolean>();
  let peak = 0;
  for (const e of ordered) {
    if (e.time > to) break;
    state.set(e.device_id, e.parameters.on === true);
    if (e.time < from) continue;
    let open = 0;
    for (const on of state.values()) if (on) open++;
    peak = Math.max(peak, open);
  }
  return peak;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const v of a) if (b.has(v)) shared++;
  return shared / (a.size + b.size - shared || 1);
}

// Three tracks that a real mastering chain would all leave sitting near their own peak loudness --
// the case the old mapping collapsed on -- but which are obviously different music: a steady dense
// four-on-the-floor, a slower sparser groove, and a busy bright one.
const DENSE_STEADY: TrackSpec = { bassEvery: 0.5, trebleEvery: 0.25, energy: () => 0.9 };
const SLOW_SPARSE: TrackSpec = { bassEvery: 1.6, trebleEvery: 1.6, energy: () => 0.85 };
const BRIGHT_BUSY: TrackSpec = { bassEvery: 0.8, trebleEvery: 0.2, energy: () => 0.95 };
// ...plus one with real dynamics, and one that is genuinely quiet and empty.
const DYNAMIC: TrackSpec = {
  bassEvery: 0.7,
  trebleEvery: 0.9,
  energy: (t) => (t < 30 ? 0.2 : t < 80 ? 0.95 : 0.35),
};
const AMBIENT: TrackSpec = { bassEvery: 6, trebleEvery: 5, energy: () => 0.25 };

describe("generated shows differ from one track to another", () => {
  it("three equally-loud but musically different tracks do not produce near-identical valve streams", () => {
    const a = fingerprint(valveEventsFor(analysisFor(DENSE_STEADY)));
    const b = fingerprint(valveEventsFor(analysisFor(SLOW_SPARSE)));
    const c = fingerprint(valveEventsFor(analysisFor(BRIGHT_BUSY)));

    // Reported on failure so a regression shows HOW similar things got, not just that they were.
    const overlaps = {
      denseVsSparse: jaccard(a.tuples, b.tuples),
      denseVsBright: jaccard(a.tuples, c.tuples),
      sparseVsBright: jaccard(b.tuples, c.tuples),
    };
    expect(overlaps.denseVsSparse).toBeLessThan(0.5);
    expect(overlaps.denseVsBright).toBeLessThan(0.5);
    expect(overlaps.sparseVsBright).toBeLessThan(0.5);
  });

  it("a sparser, slower track moves the valves at a visibly slower cadence than a dense one", () => {
    const dense = fingerprint(valveEventsFor(analysisFor(DENSE_STEADY)));
    const sparse = fingerprint(valveEventsFor(analysisFor(SLOW_SPARSE)));

    // Not an exact ratio -- just that onset density genuinely reaches the output instead of every
    // track landing on the same internally-fixed cadence.
    expect(sparse.transitionsPerSecond).toBeLessThan(dense.transitionsPerSecond * 0.8);
  });

  it("a quiet, sparse track produces a far calmer show than a busy one", () => {
    const busy = fingerprint(valveEventsFor(analysisFor(BRIGHT_BUSY)));
    const ambient = fingerprint(valveEventsFor(analysisFor(AMBIENT)));

    // Deliberately not a fullness comparison: a calm section HOLDING valves open is legitimately
    // "fuller" at any instant than a busy one flickering through them, so movement -- not open time --
    // is what has to separate an ambient track from a dance track.
    expect(ambient.transitionsPerSecond).toBeLessThan(busy.transitionsPerSecond * 0.5);
  });

  it("a track with real dynamics is not choreographed uniformly across its own quiet and loud halves", () => {
    const events = valveEventsFor(analysisFor(DYNAMIC));
    const inWindow = (from: number, to: number): ScenarioEvent[] => events.filter((e) => e.time >= from && e.time < to);

    // DYNAMIC is quiet for 0-30s, loud for 30-80s: the loud stretch must be busier per second...
    const quietRate = inWindow(0, 30).length / 30;
    const loudRate = inWindow(30, 80).length / 50;
    expect(loudRate).toBeGreaterThan(quietRate * 1.3);

    // ...and run wider, rather than just moving the same handful of valves faster.
    expect(peakConcurrentOpen(events, 30, 80)).toBeGreaterThan(peakConcurrentOpen(events, 0, 30));
  });

  it("is deterministic -- regenerating from the same analysis gives byte-identical events", () => {
    const analysis = analysisFor(DYNAMIC);
    const first = fingerprint(valveEventsFor(analysis));
    const second = fingerprint(valveEventsFor(analysis));

    expect(second.events).toBe(first.events);
    expect(jaccard(first.tuples, second.tuples)).toBe(1);
  });

  it("two tracks alike in everything but tempo still get different shows", () => {
    // Same onsets, same loudness, same everything the old mapping looked at -- only the detected
    // pulse differs, which has to reach phrase lengths, section lengths and step cadence.
    const slow = fingerprint(valveEventsFor(analysisFor({ ...DENSE_STEADY, bpm: 90 })));
    const fast = fingerprint(valveEventsFor(analysisFor({ ...DENSE_STEADY, bpm: 140 })));

    expect(jaccard(slow.tuples, fast.tuples)).toBeLessThan(0.5);
  });

  it("tempo sets the step cadence wherever the relay's own floor isn't already the binding limit", () => {
    // On a busy track both tempos land on the hardware floor and legitimately share a cadence, so
    // this checks a sparser one, where the beat -- not the relay -- is what decides the step rate.
    const slow = fingerprint(valveEventsFor(analysisFor({ ...SLOW_SPARSE, bpm: 90 })));
    const fast = fingerprint(valveEventsFor(analysisFor({ ...SLOW_SPARSE, bpm: 140 })));

    expect(slow.medianCadence).toBeGreaterThan(fast.medianCadence);
  });
});
