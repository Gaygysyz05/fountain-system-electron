/** Turns an AudioAnalysis (see audioAnalysis.ts) into a scenario's worth of ScenarioEvents --
 * deterministic, hand-tuned mapping rules, not a model. Output is an ordinary ScenarioFile,
 * reviewable/editable in the Timeline like any hand-authored show; nothing here bypasses that pipeline.
 *
 * The structure that matters (and that an earlier version got wrong badly enough that every track came
 * out looking the same -- see musicGeneratorVariety.test.ts): the SHOW's shape has to come from the
 * music, not from constants. So the track is split into sections at its own energy change-points, each
 * section picks its own valve subset / movement pattern / step rate from its own character (loudness
 * rank within the track, onset density, brightness), phrases inside a section alternate movement with
 * held states so the fountain breathes instead of strobing, and the step rate is derived from the
 * detected tempo. Anything still arbitrary after that (which valve a wave starts on) is drawn from a
 * seed derived FROM THE TRACK, so two different tracks diverge while the same track always regenerates
 * identically. */
import type { AudioAnalysis, EnvelopePoint, TempoEstimate } from "./audioAnalysis";
import { sampleEnvelope } from "./audioAnalysis";
import { generateValvePattern, type ScenarioEvent, type ValvePatternType } from "./scenario";

export type MusicGeneratorCategory = "valve" | "motor" | "light";

export interface MusicGeneratorOptions {
  categories: Set<MusicGeneratorCategory>;
  valveDeviceIds: string[];
  motorDeviceIds: string[];
  lightDeviceIds: string[];
  motorMaxFrequency?: number; // Hz, defaults to a conservative 40 -- tune per site to the drives' actual configured max
  motorSampleInterval?: number; // seconds between motor frequency updates; no point commanding faster than max_ramp_rate_hz_per_sec lets the drive actually follow
  /** Forces this many EQUAL-length sections instead of detecting them from the track's own energy
   * change-points. Mainly for tests and for an operator who wants a predictable block structure. */
  valveSectionCount?: number;
  valvePhraseBeats?: number; // musical length of one phrase (movement/hold unit) within a section; defaults to 8 beats (2 bars in 4/4)
  valveMinToggleHoldSeconds?: number; // a relay physically cannot open/close faster than this -- defaults to 0.5s; see enforceMinHoldTime
  lightFlashColor?: [number, number, number];
}

const DEFAULT_VALVE_MIN_TOGGLE_HOLD_SECONDS = 0.5;
const DEFAULT_PHRASE_BEATS = 8;
/** Stand-in beat when a track has no detectable pulse (ambient, spoken word) -- everything downstream is expressed in beats, so this keeps one code path instead of two. */
const FALLBACK_BEAT_SECONDS = 0.6;
/** Target section length when the energy curve is too flat to reveal real boundaries -- in bars when a tempo is known (so different tempos still get different section counts), else wall-clock. */
const FALLBACK_SECTION_BARS = 16;
const FALLBACK_SECTION_SECONDS = 25;
const MIN_SECTION_SECONDS = 8;
const MAX_SECTIONS = 8;
/** Bass onsets per second at which a section counts as "fully busy" for density-driven decisions. */
const BUSY_DENSITY = 2.0;

let nextId = 0;
function makeId(): string {
  return `gen-${Date.now()}-${nextId++}`;
}

function roundTime(t: number): number {
  return Math.round(t * 10) / 10;
}

/** Valve events are snapped to whole multiples of the relay's own minimum hold: the hardware cannot
 * resolve anything finer (see modbus_valve.py's min_toggle_interval), and keeping every generated
 * moment on that grid also lines the result up with the Timeline's grid rows, so a generated show
 * stays editable cell-by-cell instead of landing between them. */
function snapValveTime(t: number, minHold: number): number {
  return roundTime(Math.round(t / minHold) * minHold);
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Small deterministic PRNG (mulberry32). Everything "arbitrary" in the show is drawn from this rather
 * than Math.random so regenerating the SAME track reproduces the same show exactly (an operator who
 * tweaks a generated scenario and regenerates must not get a different one underneath them), while
 * different tracks -- which seed it differently -- diverge. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hashes the track's own identifying numbers (length, how many onsets of each kind, tempo, where the
 * first bass hits land) into a seed -- so the seed is a property of the MUSIC, not of the clock or of
 * generation order. */
function seedFromAnalysis(analysis: AudioAnalysis): number {
  let h = 2166136261;
  const mix = (value: number): void => {
    h ^= Math.round(value * 1000) | 0;
    h = Math.imul(h, 16777619);
  };
  mix(analysis.duration);
  mix(analysis.onsets.length);
  mix(analysis.bassOnsets.length);
  mix(analysis.trebleOnsets.length);
  mix(analysis.tempo?.bpm ?? 0);
  for (let i = 0; i < Math.min(16, analysis.bassOnsets.length); i++) mix(analysis.bassOnsets[i]);
  return h >>> 0;
}

function countInRange(times: number[], start: number, end: number): number {
  let count = 0;
  for (const t of times) if (t >= start && t < end) count++;
  return count;
}

/** Last event wins for a given (device_id, time) collision -- same semantics as timelineStore's upsertEvents -- so a beat-driven accent correctly overrides the section's own state at the instant they coincide. */
function dedupeEvents(events: ScenarioEvent[]): ScenarioEvent[] {
  const byKey = new Map<string, ScenarioEvent>();
  for (const e of events) byKey.set(`${e.device_id} ${e.time}`, e);
  return [...byKey.values()];
}

/** A relay physically cannot flip state faster than `minHoldSeconds` (a real hardware limit -- see modbus_valve.py's min_toggle_interval -- not a style choice). Per device, drops any event landing sooner than that after the last KEPT one for that device, keeping the later one (same "most recent intent wins" rule as dedupeEvents) -- so an accent and a section change landing close together no longer chatter the relay faster than it can physically move. Must run on an already-deduped list (equal-timestamp collisions resolved first), or which of two same-instant events counts as "first" would depend on array order instead of generation intent. */
export function enforceMinHoldTime(events: ScenarioEvent[], minHoldSeconds: number): ScenarioEvent[] {
  const byDevice = new Map<string, ScenarioEvent[]>();
  for (const e of events) {
    const list = byDevice.get(e.device_id) ?? [];
    list.push(e);
    byDevice.set(e.device_id, list);
  }

  const kept: ScenarioEvent[] = [];
  for (const deviceEvents of byDevice.values()) {
    deviceEvents.sort((a, b) => a.time - b.time);
    let lastKeptTime = -Infinity;
    for (const e of deviceEvents) {
      if (e.time - lastKeptTime >= minHoldSeconds) {
        kept.push(e);
        lastKeptTime = e.time;
      }
    }
  }
  return kept;
}

/** Drops any event that re-states what a device is already doing. Playback is level-triggered (state
 * persists until changed -- see scenario_player.py's _process_events), so a valve told "on" while
 * already on is pure noise: it bloats the file, clutters the Timeline the operator has to read, and
 * eats the per-device minimum-hold budget that a REAL transition right after it needs. Pattern
 * generators emit every device at every step by design, so without this a 24-valve cascade writes 24
 * events per step where only two valves actually changed. */
export function dropRedundantStateEvents(events: ScenarioEvent[], field = "on"): ScenarioEvent[] {
  const byDevice = new Map<string, ScenarioEvent[]>();
  for (const e of events) {
    const list = byDevice.get(e.device_id) ?? [];
    list.push(e);
    byDevice.set(e.device_id, list);
  }

  const kept: ScenarioEvent[] = [];
  for (const deviceEvents of byDevice.values()) {
    deviceEvents.sort((a, b) => a.time - b.time);
    let lastValue: unknown;
    let seen = false;
    for (const e of deviceEvents) {
      const value = e.parameters[field];
      if (seen && value === lastValue) continue; // same state as this device is already in -- nothing to send
      kept.push(e);
      lastValue = value;
      seen = true;
    }
  }
  return kept;
}

/** Rotates `arr` left by `offset` positions -- used to start a wave at a different valve each time instead of always sweeping from index 0, since generateValvePattern always begins its head at whatever sits at index 0 of the array it's given. */
export function rotateArray<T>(arr: T[], offset: number): T[] {
  const n = arr.length;
  if (n === 0) return arr;
  const shift = ((offset % n) + n) % n;
  return [...arr.slice(shift), ...arr.slice(0, shift)];
}

// -- section structure ---------------------------------------------------------

interface Section {
  start: number;
  end: number;
  energy: number; // mean normalized loudness across the section
  bassDensity: number; // bass onsets per second
  trebleDensity: number; // treble onsets per second
  rising: boolean; // louder than the section before it -- a build rather than a plateau
  rank: number; // 0 = quietest section of this track, sections-1 = loudest
}

/** Finds where the track actually changes character, by looking for jumps in its smoothed loudness
 * (a crude novelty curve: |mean of the next few seconds - mean of the previous few|). A fixed N-way
 * split can't do this -- an intro/build/drop/breakdown lands wherever the music puts it, not at 25%
 * and 50% -- and a fixed split is precisely why every track used to come out with the same skeleton. */
function detectSectionBounds(energy: EnvelopePoint[], duration: number, beatSeconds: number, tempo: TempoEstimate | null): number[] {
  const binSeconds = 1;
  const bins = Math.max(1, Math.floor(duration / binSeconds));
  const level: number[] = [];
  for (let i = 0; i < bins; i++) level.push(sampleEnvelope(energy, i * binSeconds + binSeconds / 2));

  const context = 6; // seconds either side compared against each other
  const novelty = level.map((_, i) => {
    const before = level.slice(Math.max(0, i - context), i);
    const after = level.slice(i, Math.min(level.length, i + context));
    if (before.length < context || after.length < context) return 0; // too close to an edge to judge
    return Math.abs(mean(after) - mean(before));
  });

  const noveltyMean = mean(novelty);
  const spread = Math.sqrt(mean(novelty.map((v) => (v - noveltyMean) ** 2)));
  const threshold = Math.max(0.05, noveltyMean + spread);

  const bounds: number[] = [0];
  for (let i = 1; i < novelty.length - 1; i++) {
    const isPeak = novelty[i] >= novelty[i - 1] && novelty[i] > novelty[i + 1] && novelty[i] >= threshold;
    if (isPeak && i * binSeconds - bounds[bounds.length - 1] >= MIN_SECTION_SECONDS) bounds.push(i * binSeconds);
  }

  // Too flat to reveal anything (steady-loudness dance tracks are the common case): fall back to an
  // even split, but sized in BARS when a tempo is known, so a 90bpm and a 140bpm track still end up
  // with different section counts instead of both getting the same arbitrary number.
  const targetSection = tempo ? FALLBACK_SECTION_BARS * 4 * beatSeconds : FALLBACK_SECTION_SECONDS;
  if (bounds.length < 3 && duration >= MIN_SECTION_SECONDS * 3) {
    const count = clamp(Math.round(duration / targetSection), 3, MAX_SECTIONS);
    return Array.from({ length: count }, (_, i) => (i * duration) / count);
  }
  return bounds.slice(0, MAX_SECTIONS);
}

function buildSections(analysis: AudioAnalysis, bounds: number[]): Section[] {
  const raw = bounds.map((start, i) => {
    const end = i + 1 < bounds.length ? bounds[i + 1] : analysis.duration;
    const span = Math.max(1e-6, end - start);
    const samples: number[] = [];
    for (let t = start; t < end; t += 1) samples.push(sampleEnvelope(analysis.energy, t));
    return {
      start,
      end,
      energy: mean(samples),
      bassDensity: countInRange(analysis.bassOnsets, start, end) / span,
      trebleDensity: countInRange(analysis.trebleOnsets, start, end) / span,
      rising: false,
      rank: 0,
    };
  });

  const byEnergy = [...raw].sort((a, b) => a.energy - b.energy);
  return raw.map((section, i) => ({
    ...section,
    rising: i > 0 && section.energy > raw[i - 1].energy + 0.05,
    rank: byEnergy.indexOf(section),
  }));
}

/** How much of the bank this section runs, from BOTH its loudness rank within the track (so there is
 * always contrast, even on a brick-walled master where every section reads as ~equally loud once the
 * envelope is normalized) and its onset density (which survives normalization, and is what actually
 * separates a sparse ambient passage from a busy one). */
function openFractionFor(section: Section, sectionCount: number): number {
  const rankNorm = sectionCount > 1 ? section.rank / (sectionCount - 1) : clamp(section.energy, 0, 1);
  const activity = clamp(section.bassDensity / BUSY_DENSITY, 0, 1);
  return clamp(0.15 + 0.85 * (0.55 * rankNorm + 0.45 * activity), 0.1, 1);
}

interface Movement {
  pattern: ValvePatternType;
  /** Share of the section's valves lit at once while a cascade sweeps -- what keeps a loud, wide
   * section LOOKING wide while it moves. */
  trailFraction: number;
}

/** Picks the movement vocabulary from the section's character. The point is contrast: quiet sparse
 * passages hold still, builds sweep wide, busy ones flicker, mid ones flow in a narrower chase -- so
 * sections differ from EACH OTHER within one show, and two tracks with different density profiles end
 * up using different vocabularies altogether.
 *
 * Single-valve patterns (wave, pingpong) are reserved for genuinely small banks: on a 24-valve bank
 * they collapse the whole section to one lit valve at a time, which threw away the width the section
 * just decided on and made a loud drop read NARROWER than the quiet intro before it. */
function movementFor(section: Section, subsetSize: number): Movement {
  if (section.bassDensity < 0.35 && section.trebleDensity < 0.8) return { pattern: "constant", trailFraction: 1 };
  if (section.bassDensity >= BUSY_DENSITY || section.trebleDensity >= 3.5) return { pattern: "alternate", trailFraction: 0.5 };
  if (subsetSize <= 6) return { pattern: section.rising ? "pingpong" : "wave", trailFraction: 1 / Math.max(1, subsetSize) };
  if (section.rising) return { pattern: "cascade", trailFraction: 0.6 };
  if (section.bassDensity >= 0.9) return { pattern: "cascade", trailFraction: 0.4 };
  return { pattern: "cascade", trailFraction: 0.25 };
}

/** Beats per movement step, from density -- a busy section steps every beat, a sparse one every four.
 * Rounded to whole multiples of the relay's minimum hold, which is what ultimately decides how fast the
 * fountain can actually move; a 90bpm and a 140bpm track therefore genuinely differ in cadence instead
 * of both landing on the generator's own fixed interval.
 *
 * Floored at TWICE the minimum hold rather than at the minimum itself: a relay is a mechanical part
 * with a finite number of operations in it, and a show that steps every valve at the hardware floor for
 * its whole duration burns through that budget for no visual gain -- water takes its own time to rise
 * and fall, so a sub-second chase doesn't read as any faster in the air. Short accents (which ARE worth
 * the wear) still use the full rate. */
function stepSecondsFor(section: Section, beatSeconds: number, minHold: number): number {
  const beatsPerStep = section.bassDensity >= 1.5 ? 1 : section.bassDensity >= 0.8 ? 2 : 4;
  const ideal = beatSeconds * beatsPerStep;
  // Nearest achievable multiple of the relay grid, then clamped up to the floor -- NOT doubled until
  // it clears the floor, which would collapse two different tempos onto the same cadence.
  return Math.max(minHold * 2, Math.round(ideal / minHold) * minHold);
}

// -- per-category event generation ---------------------------------------------

function motorEvents(analysis: AudioAnalysis, deviceIds: string[], maxFrequency: number, interval: number): ScenarioEvent[] {
  if (deviceIds.length === 0) return [];
  const events: ScenarioEvent[] = [];
  for (let t = 0; t <= analysis.duration + 1e-9; t += interval) {
    const time = roundTime(t);
    const level = sampleEnvelope(analysis.bassEnergy, time);
    const frequency = Math.round(level * maxFrequency * 10) / 10;
    const active = frequency > 1;
    for (const deviceId of deviceIds) {
      events.push({ id: makeId(), time, device_id: deviceId, parameters: { frequency, active } });
    }
  }
  return events;
}

/** Tints the operator's chosen flash colour by the track's own timbre at that instant: bass-dominated
 * moments pull warm, treble-dominated ones pull cool. Identity when the analysis carries no treble
 * envelope, so a caller passing a hand-built analysis still gets exactly the colour it asked for. */
function spectralTint(analysis: AudioAnalysis, time: number, color: [number, number, number]): [number, number, number] {
  if (analysis.trebleEnergy.length === 0 || analysis.bassEnergy.length === 0) return color;
  const bass = sampleEnvelope(analysis.bassEnergy, time);
  const treble = sampleEnvelope(analysis.trebleEnergy, time);
  const total = bass + treble;
  if (total <= 1e-6) return color;
  const brightness = treble / total; // 0 = all bass, 1 = all treble
  const warm = 1 + 0.35 * (0.5 - brightness); // >1 on bass-heavy moments
  const cool = 1 + 0.35 * (brightness - 0.5); // >1 on treble-heavy moments
  const [r, g, b] = color;
  return [clamp(r * warm, 0, 255), clamp(g, 0, 255), clamp(b * cool, 0, 255)];
}

function lightEvents(analysis: AudioAnalysis, deviceIds: string[], flashColor: [number, number, number], beatSeconds: number): ScenarioEvent[] {
  if (deviceIds.length === 0) return [];
  const events: ScenarioEvent[] = [];
  const hits = [...new Set([...analysis.trebleOnsets, ...analysis.onsets])].sort((a, b) => a - b);
  // Decay tied to the beat when there is one -- a flash that outlives its own beat reads as a colour
  // change rather than a hit, and at 150bpm that happens at a fixed 0.25s.
  const decaySeconds = analysis.tempo ? clamp(beatSeconds * 0.5, 0.15, 0.6) : 0.25;

  deviceIds.forEach((deviceId, deviceIndex) => {
    // Round-robins the hit list across lights instead of flashing every light on every hit -- reads as movement across the fountain, not a single strobe.
    for (let i = deviceIndex; i < hits.length; i += deviceIds.length) {
      const time = roundTime(hits[i]);
      const level = sampleEnvelope(analysis.energy, time);
      const [r, g, b] = spectralTint(analysis, time, flashColor);
      const flashScale = 0.4 + 0.6 * level; // never fully dark on a hit, still scales with how loud that section is
      events.push({
        id: makeId(),
        time,
        device_id: deviceId,
        parameters: { r: Math.round(r * flashScale), g: Math.round(g * flashScale), b: Math.round(b * flashScale) },
      });

      // Decays back toward a dim base shortly after -- without this the flash colour would just hold until the NEXT hit (which this device might not see for seconds, since hits are round-robinned across lights), reading as a colour change rather than a flash.
      const decayTime = roundTime(Math.min(analysis.duration, time + decaySeconds));
      const dimScale = 0.15 + 0.25 * level;
      events.push({
        id: makeId(),
        time: decayTime,
        device_id: deviceId,
        parameters: { r: Math.round(r * dimScale), g: Math.round(g * dimScale), b: Math.round(b * dimScale) },
      });
    }
  });
  return events;
}

interface ValveOptions {
  sectionCount?: number;
  phraseBeats: number;
  minHold: number;
}

function valveEvents(analysis: AudioAnalysis, deviceIds: string[], opts: ValveOptions): ScenarioEvent[] {
  if (deviceIds.length === 0) return [];
  const n = deviceIds.length;
  const { minHold, phraseBeats } = opts;
  const beatSeconds = analysis.tempo?.beatPeriod ?? FALLBACK_BEAT_SECONDS;
  const random = mulberry32(seedFromAnalysis(analysis));
  const events: ScenarioEvent[] = [];

  const bounds = opts.sectionCount
    ? Array.from({ length: opts.sectionCount }, (_, i) => (i * analysis.duration) / opts.sectionCount!)
    : detectSectionBounds(analysis.energy, analysis.duration, beatSeconds, analysis.tempo);
  const sections = buildSections(analysis, bounds);

  const emit = (time: number, deviceId: string, on: boolean): void => {
    events.push({ id: makeId(), time: snapValveTime(time, minHold), device_id: deviceId, parameters: { on } });
  };

  for (const section of sections) {
    const openCount = clamp(Math.round(openFractionFor(section, sections.length) * n), 1, n);
    // Which valves this section runs -- rotated by a track-seeded amount so consecutive sections (and
    // the same section index across two different tracks) don't keep reusing the same low-indexed block.
    const subset = rotateArray(deviceIds, Math.floor(random() * n)).slice(0, openCount);
    const inSubset = new Set(subset);
    const movement = movementFor(section, subset.length);
    const stepSeconds = stepSecondsFor(section, beatSeconds, minHold);
    const phraseSeconds = Math.max(stepSeconds * 2, phraseBeats * beatSeconds);

    // Every section announces itself at full width first, then starts moving -- an operator watching
    // should be able to see the show change gear at a section boundary.
    for (const deviceId of deviceIds) emit(section.start, deviceId, inSubset.has(deviceId));

    // Louder sections spend more of their phrases moving; quiet ones mostly hold, which is what makes
    // a quiet passage read as calm instead of as "same strobe, fewer valves".
    const motionChance = 0.3 + 0.55 * (sections.length > 1 ? section.rank / (sections.length - 1) : clamp(section.energy, 0, 1));

    for (let phraseStart = section.start; phraseStart < section.end - 1e-9; phraseStart += phraseSeconds) {
      const phraseEnd = Math.min(section.end, phraseStart + phraseSeconds);
      const moving = movement.pattern !== "constant" && random() < motionChance;
      if (!moving) {
        for (const deviceId of deviceIds) emit(phraseStart, deviceId, inSubset.has(deviceId));
        continue;
      }

      // Starts one step IN, so the section/phrase boundary state above stays visible for a moment
      // before the movement takes over.
      const steps = generateValvePattern({
        deviceIds: subset,
        startTime: phraseStart + stepSeconds,
        endTime: phraseEnd,
        stepInterval: stepSeconds,
        pattern: movement.pattern,
        trailLength: clamp(Math.round(subset.length * movement.trailFraction), 1, Math.max(1, subset.length - 1)),
      });
      for (const deviceId of deviceIds) if (!inSubset.has(deviceId)) emit(phraseStart, deviceId, false);
      for (const step of steps) emit(step.time, step.device_id, step.on);
    }
  }

  // Accents: a sweep across the whole bank on the hits that genuinely stand out, punctuating the
  // section's own movement. Selected against the track's loudness RANGE rather than a percentile of
  // it -- most music spends long stretches on a plateau, and a percentile lands exactly ON that
  // plateau, which either admits every onset (an accent carpet, the metronome problem again) or
  // none. A track with no dynamic contrast at all has nothing that stands out by definition, so it
  // gets a single opening accent rather than a stream of meaningless ones.
  const accentCandidates = analysis.bassOnsets.map((time) => ({ time, level: sampleEnvelope(analysis.energy, time) }));
  if (accentCandidates.length > 0) {
    const levels = accentCandidates.map((c) => c.level);
    const lowest = Math.min(...levels);
    const highest = Math.max(...levels);
    const hasContrast = highest - lowest >= 0.1;
    const threshold = lowest + 0.66 * (highest - lowest);
    const accentSteps = 4;
    const accentSpacing = Math.max(accentSteps * minHold, phraseBeats * beatSeconds);

    const chosen: number[] = [];
    let lastAccent = -Infinity;
    for (const candidate of accentCandidates) {
      if (!hasContrast || candidate.level < threshold) continue;
      if (candidate.time - lastAccent < accentSpacing) continue;
      lastAccent = candidate.time;
      chosen.push(candidate.time);
      if (chosen.length >= 200) break; // a pathological onset list must not blow the scenario up
    }
    if (chosen.length === 0) {
      // Nothing stood out (a flat master, or a track with a single hit): still mark the loudest
      // moment, so a show always has at least one punctuation point rather than none at all.
      const strongest = accentCandidates.reduce((best, c) => (c.level > best.level ? c : best), accentCandidates[0]);
      chosen.push(strongest.time);
    }

    for (const time of chosen) {
      const start = snapValveTime(time, minHold);
      const sweep = generateValvePattern({
        deviceIds: rotateArray(deviceIds, Math.floor(random() * n)),
        startTime: start,
        endTime: start + accentSteps * minHold,
        stepInterval: minHold,
        pattern: "cascade",
        trailLength: clamp(Math.round(n / 4), 2, 6),
      });
      for (const step of sweep) if (step.time <= analysis.duration) emit(step.time, step.device_id, step.on);
    }
  }

  // Order matters: resolve same-instant collisions, drop no-op restatements, enforce the hardware's
  // minimum hold, then drop anything the enforcement itself turned into a no-op (an on/off/on where
  // the middle event was too soon to survive collapses to a single on).
  const deduped = dedupeEvents(events);
  const meaningful = dropRedundantStateEvents(deduped);
  return dropRedundantStateEvents(enforceMinHoldTime(meaningful, minHold));
}

export function generateScenarioFromMusic(analysis: AudioAnalysis, options: MusicGeneratorOptions): ScenarioEvent[] {
  const beatSeconds = analysis.tempo?.beatPeriod ?? FALLBACK_BEAT_SECONDS;
  const events: ScenarioEvent[] = [];
  if (options.categories.has("motor")) {
    events.push(...motorEvents(analysis, options.motorDeviceIds, options.motorMaxFrequency ?? 40, options.motorSampleInterval ?? 0.5));
  }
  if (options.categories.has("light")) {
    events.push(...lightEvents(analysis, options.lightDeviceIds, options.lightFlashColor ?? [255, 200, 120], beatSeconds));
  }
  if (options.categories.has("valve")) {
    events.push(...valveEvents(analysis, options.valveDeviceIds, {
      sectionCount: options.valveSectionCount,
      phraseBeats: options.valvePhraseBeats ?? DEFAULT_PHRASE_BEATS,
      minHold: options.valveMinToggleHoldSeconds ?? DEFAULT_VALVE_MIN_TOGGLE_HOLD_SECONDS,
    }));
  }
  return dedupeEvents(events);
}
