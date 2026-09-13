/** Classical DSP onset/energy analysis of a decoded audio track -- spectral-flux onset detection (Dixon 2006), no ML model involved. Feeds musicGenerator.ts's auto-choreography; kept independent of Web Audio's AnalyserNode (which only runs live during playback) by working directly off the decoded PCM samples, so a multi-minute track analyzes in one pass instead of in real time. */
import { fft } from "./fft";

export const FFT_SIZE = 2048;
export const HOP_SIZE = 512;

const BASS_RANGE_HZ: [number, number] = [20, 200];
const TREBLE_RANGE_HZ: [number, number] = [3000, 10000];

export interface EnvelopePoint {
  time: number;
  value: number;
}

export interface Spectrogram {
  frameTimes: Float64Array;
  magnitudes: Float64Array[]; // one per frame, length fftSize/2
  sampleRate: number;
  fftSize: number;
}

/** A track's underlying pulse. `phase` is where the first beat sits, so beats are at phase + k*beatPeriod; `confidence` is how tightly the onsets actually cluster on that grid (0 = no discernible pulse, ~1 = machine-precise), letting callers fall back to time-based timing rather than trusting a tempo read off an ambient track that hasn't got one. */
export interface TempoEstimate {
  bpm: number;
  beatPeriod: number;
  phase: number;
  confidence: number;
}

export interface AudioAnalysis {
  duration: number;
  sampleRate: number;
  onsets: number[]; // full-spectrum onset timestamps (seconds)
  bassOnsets: number[];
  trebleOnsets: number[];
  energy: EnvelopePoint[]; // overall loudness, normalized 0-1, smooth (not onset-gated)
  bassEnergy: EnvelopePoint[]; // bass-band loudness, normalized 0-1, smooth
  trebleEnergy: EnvelopePoint[]; // treble-band loudness, normalized 0-1 -- against bassEnergy this is the track's brightness/timbre balance over time
  tempo: TempoEstimate | null; // null when no pulse is detectable (ambient, spoken word, too few onsets)
}

function hannWindow(size: number): Float64Array {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  return w;
}

export function computeSpectrogram(samples: Float32Array, sampleRate: number, fftSize = FFT_SIZE, hopSize = HOP_SIZE): Spectrogram {
  const window = hannWindow(fftSize);
  const numFrames = Math.max(0, Math.floor((samples.length - fftSize) / hopSize) + 1);
  const frameTimes = new Float64Array(numFrames);
  const magnitudes: Float64Array[] = new Array(numFrames);

  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);

  for (let f = 0; f < numFrames; f++) {
    const start = f * hopSize;
    for (let i = 0; i < fftSize; i++) {
      re[i] = samples[start + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    const mag = new Float64Array(fftSize / 2);
    for (let i = 0; i < fftSize / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
    magnitudes[f] = mag;
    frameTimes[f] = start / sampleRate;
  }

  return { frameTimes, magnitudes, sampleRate, fftSize };
}

/** [lo, hi] bin indices (inclusive) covering a frequency range, for restricting flux/energy sums to one band. */
export function binRangeForFrequencies(loHz: number, hiHz: number, sampleRate: number, fftSize: number): [number, number] {
  const binHz = sampleRate / fftSize;
  const lo = Math.max(0, Math.floor(loHz / binHz));
  const hi = Math.min(fftSize / 2 - 1, Math.ceil(hiHz / binHz));
  return [lo, hi];
}

/** Positive-only sum of per-bin magnitude increases between consecutive frames, restricted to [lo, hi] -- the classic "spectral flux" onset-strength signal: rising energy in a band reads as an attack, a decay reads as nothing (an onset is a sudden LOUDER moment, not just any change). */
export function bandFlux(magnitudes: Float64Array[], lo: number, hi: number): Float64Array {
  const flux = new Float64Array(magnitudes.length);
  for (let f = 1; f < magnitudes.length; f++) {
    let sum = 0;
    const prev = magnitudes[f - 1];
    const cur = magnitudes[f];
    for (let i = lo; i <= hi; i++) {
      const diff = cur[i] - prev[i];
      if (diff > 0) sum += diff;
    }
    flux[f] = sum;
  }
  return flux;
}

export function bandEnergy(magnitudes: Float64Array[], lo: number, hi: number): Float64Array {
  const energy = new Float64Array(magnitudes.length);
  for (let f = 0; f < magnitudes.length; f++) {
    let sum = 0;
    const cur = magnitudes[f];
    for (let i = lo; i <= hi; i++) sum += cur[i];
    energy[f] = sum;
  }
  return energy;
}

export interface PeakPickOptions {
  medianWindow?: number; // frames either side used for the local adaptive threshold
  multiplier?: number; // a frame must exceed localMean * multiplier to count as an onset
  minSpacingSeconds?: number; // suppresses a second peak too close to the last one (avoids double-triggering on one transient)
}

/** Adaptive-threshold local-maxima peak picking over an onset-strength envelope -- a fixed global threshold would misfire on a track with a loud chorus and a quiet verse; comparing each frame to its own local neighborhood adapts to that automatically. */
export function pickPeaks(envelope: Float64Array, frameTimes: Float64Array, opts: PeakPickOptions = {}): number[] {
  const halfWindow = Math.floor((opts.medianWindow ?? 16) / 2);
  const multiplier = opts.multiplier ?? 1.5;
  const minSpacing = opts.minSpacingSeconds ?? 0.1;

  const peaks: number[] = [];
  let lastPeakTime = -Infinity;

  for (let i = 1; i < envelope.length - 1; i++) {
    const start = Math.max(0, i - halfWindow);
    const end = Math.min(envelope.length, i + halfWindow + 1);
    let sum = 0;
    for (let j = start; j < end; j++) sum += envelope[j];
    const localMean = sum / (end - start);

    const isLocalMax = envelope[i] > envelope[i - 1] && envelope[i] >= envelope[i + 1];
    const aboveThreshold = envelope[i] > localMean * multiplier && envelope[i] > 1e-6;

    if (isLocalMax && aboveThreshold) {
      const time = frameTimes[i];
      if (time - lastPeakTime >= minSpacing) {
        peaks.push(time);
        lastPeakTime = time;
      }
    }
  }
  return peaks;
}

/** Short-window RMS loudness over time -- unlike flux/onsets (spiky, only fires on transients), this is the smooth "how loud is this SECTION" signal the generator uses for continuous mapping (motor speed, base brightness, how many valves are open). */
export function rmsEnvelope(samples: Float32Array, sampleRate: number, windowSeconds = 0.1, hopSeconds = 0.05): EnvelopePoint[] {
  const windowSize = Math.max(1, Math.floor(windowSeconds * sampleRate));
  const hopSize = Math.max(1, Math.floor(hopSeconds * sampleRate));
  const out: EnvelopePoint[] = [];
  for (let start = 0; start + windowSize <= samples.length; start += hopSize) {
    let sumSquares = 0;
    for (let i = 0; i < windowSize; i++) {
      const v = samples[start + i];
      sumSquares += v * v;
    }
    out.push({ time: start / sampleRate, value: Math.sqrt(sumSquares / windowSize) });
  }
  return out;
}

function maxValue(env: EnvelopePoint[]): number {
  let max = 1e-9;
  for (const e of env) if (e.value > max) max = e.value;
  return max;
}

/** Rescales to 0-1 against the track's own peak -- callers (musicGenerator.ts) map straight onto device parameter ranges and must never see raw FFT-magnitude-scale numbers, which vary with track loudness/FFT size and mean nothing on their own. */
export function normalizeEnvelope(env: EnvelopePoint[]): EnvelopePoint[] {
  const max = maxValue(env);
  return env.map((e) => ({ time: e.time, value: e.value / max }));
}

/** Binary-searches a time-sorted envelope for the value at (or just past) `t` -- O(log n) so the generator can sample it once per event without rescanning from the start each time. */
export function sampleEnvelope(env: EnvelopePoint[], t: number): number {
  if (env.length === 0) return 0;
  let lo = 0;
  let hi = env.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (env[mid].time < t) lo = mid + 1;
    else hi = mid;
  }
  return env[lo].value;
}

const TEMPO_MIN_BPM = 60;
const TEMPO_MAX_BPM = 180;
const TEMPO_STEP_BPM = 0.5;
const TEMPO_MIN_ONSETS = 8;
const TEMPO_MIN_CONFIDENCE = 0.15;

/** Estimates the beat grid by scoring every candidate tempo on how tightly the onsets cluster around
 * ITS period, phase-invariantly: each onset becomes a unit vector at angle 2*pi*(t/period), and the
 * length of their mean is the classic circular concentration (Rayleigh) -- 1 when every onset lands
 * on the same point of the beat, ~0 when they're scattered. The winning candidate's mean ANGLE then
 * hands back the phase for free, so no separate beat-tracking pass is needed. Ties go to the slowest
 * candidate (the loop only replaces on a strict improvement), which keeps the usual octave ambiguity
 * -- a perfect grid at P is equally perfect at P/2 -- resolving to the human-countable reading rather
 * than to double time. */
export function estimateTempo(onsetTimes: number[], minBpm = TEMPO_MIN_BPM, maxBpm = TEMPO_MAX_BPM): TempoEstimate | null {
  if (onsetTimes.length < TEMPO_MIN_ONSETS) return null;

  let best: TempoEstimate | null = null;
  for (let bpm = minBpm; bpm <= maxBpm + 1e-9; bpm += TEMPO_STEP_BPM) {
    const beatPeriod = 60 / bpm;
    let re = 0;
    let im = 0;
    for (const t of onsetTimes) {
      const angle = 2 * Math.PI * (t / beatPeriod);
      re += Math.cos(angle);
      im += Math.sin(angle);
    }
    const confidence = Math.hypot(re, im) / onsetTimes.length;
    if (!best || confidence > best.confidence) {
      const fraction = (((Math.atan2(im, re) / (2 * Math.PI)) % 1) + 1) % 1;
      best = { bpm, beatPeriod, phase: fraction * beatPeriod, confidence };
    }
  }

  // A track with no real pulse still produces SOME winner; below this it's noise, and a caller acting
  // on it would be worse off than knowing there's no tempo at all.
  return best && best.confidence >= TEMPO_MIN_CONFIDENCE ? best : null;
}

/** Beat timestamps across `duration` for an estimated tempo -- the grid the generator quantizes to. */
export function beatGrid(duration: number, tempo: TempoEstimate): number[] {
  const out: number[] = [];
  const first = tempo.phase % tempo.beatPeriod;
  for (let t = first; t <= duration + 1e-9; t += tempo.beatPeriod) out.push(Math.round(t * 1000) / 1000);
  return out;
}

export function analyzeAudioBuffer(buffer: AudioBuffer): AudioAnalysis {
  const samples = buffer.getChannelData(0); // mono downmix: onset timing/energy don't need stereo detail
  const sampleRate = buffer.sampleRate;

  const spec = computeSpectrogram(samples, sampleRate);
  const [bassLo, bassHi] = binRangeForFrequencies(BASS_RANGE_HZ[0], BASS_RANGE_HZ[1], sampleRate, spec.fftSize);
  const [trebleLo, trebleHi] = binRangeForFrequencies(TREBLE_RANGE_HZ[0], TREBLE_RANGE_HZ[1], sampleRate, spec.fftSize);

  const fullFlux = bandFlux(spec.magnitudes, 0, (spec.magnitudes[0]?.length ?? 1) - 1);
  const bassFlux = bandFlux(spec.magnitudes, bassLo, bassHi);
  const trebleFlux = bandFlux(spec.magnitudes, trebleLo, trebleHi);
  const bassEnergyRaw = bandEnergy(spec.magnitudes, bassLo, bassHi);
  const trebleEnergyRaw = bandEnergy(spec.magnitudes, trebleLo, trebleHi);

  const frameTimes = Array.from(spec.frameTimes);
  const onsets = pickPeaks(fullFlux, spec.frameTimes);

  return {
    duration: buffer.duration,
    sampleRate,
    onsets,
    bassOnsets: pickPeaks(bassFlux, spec.frameTimes),
    trebleOnsets: pickPeaks(trebleFlux, spec.frameTimes),
    energy: normalizeEnvelope(rmsEnvelope(samples, sampleRate)),
    bassEnergy: normalizeEnvelope(frameTimes.map((t, i) => ({ time: t, value: bassEnergyRaw[i] }))),
    trebleEnergy: normalizeEnvelope(frameTimes.map((t, i) => ({ time: t, value: trebleEnergyRaw[i] }))),
    tempo: estimateTempo(onsets),
  };
}
