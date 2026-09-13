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

export interface AudioAnalysis {
  duration: number;
  sampleRate: number;
  onsets: number[]; // full-spectrum onset timestamps (seconds)
  bassOnsets: number[];
  trebleOnsets: number[];
  energy: EnvelopePoint[]; // overall loudness, normalized 0-1, smooth (not onset-gated)
  bassEnergy: EnvelopePoint[]; // bass-band loudness, normalized 0-1, smooth
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

  const frameTimes = Array.from(spec.frameTimes);

  return {
    duration: buffer.duration,
    sampleRate,
    onsets: pickPeaks(fullFlux, spec.frameTimes),
    bassOnsets: pickPeaks(bassFlux, spec.frameTimes),
    trebleOnsets: pickPeaks(trebleFlux, spec.frameTimes),
    energy: normalizeEnvelope(rmsEnvelope(samples, sampleRate)),
    bassEnergy: normalizeEnvelope(frameTimes.map((t, i) => ({ time: t, value: bassEnergyRaw[i] }))),
  };
}
