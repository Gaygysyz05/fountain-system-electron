import { describe, expect, it } from "vitest";
import {
  binRangeForFrequencies,
  computeSpectrogram,
  bandFlux,
  normalizeEnvelope,
  pickPeaks,
  rmsEnvelope,
  sampleEnvelope,
  analyzeAudioBuffer,
} from "./audioAnalysis";

describe("binRangeForFrequencies", () => {
  it("maps a frequency range to the covering bin indices", () => {
    // sampleRate=44100, fftSize=2048 -> bin width = 44100/2048 ≈ 21.53Hz
    const [lo, hi] = binRangeForFrequencies(100, 200, 44100, 2048);
    expect(lo).toBe(Math.floor(100 / (44100 / 2048)));
    expect(hi).toBe(Math.ceil(200 / (44100 / 2048)));
    expect(lo).toBeLessThanOrEqual(hi);
  });

  it("clamps to the valid bin range instead of overflowing", () => {
    const [lo, hi] = binRangeForFrequencies(0, 1_000_000, 44100, 2048);
    expect(lo).toBe(0);
    expect(hi).toBe(2048 / 2 - 1);
  });
});

describe("pickPeaks", () => {
  it("finds isolated spikes above the local background and ignores the background itself", () => {
    const envelope = new Float64Array(40).fill(0.01);
    envelope[10] = 1.0;
    envelope[25] = 1.0;
    const frameTimes = Float64Array.from({ length: 40 }, (_, i) => i * 0.1);

    const peaks = pickPeaks(envelope, frameTimes);
    expect(peaks).toEqual([1.0, 2.5]);
  });

  it("suppresses a second peak that lands too close to the previous one", () => {
    const envelope = new Float64Array(20).fill(0.01);
    envelope[5] = 1.0;
    envelope[6] = 0.9; // would be its own local max relative to envelope[7], but is right next to the real peak
    const frameTimes = Float64Array.from({ length: 20 }, (_, i) => i * 0.05);

    const peaks = pickPeaks(envelope, frameTimes, { minSpacingSeconds: 0.2 });
    expect(peaks).toEqual([0.25]);
  });
});

describe("rmsEnvelope / normalizeEnvelope / sampleEnvelope", () => {
  it("rmsEnvelope reports a constant-amplitude sine's loudness as roughly amplitude/sqrt(2), independent of window phase", () => {
    const sampleRate = 8000;
    const amplitude = 0.5;
    const samples = new Float32Array(sampleRate); // 1 second
    for (let i = 0; i < samples.length; i++) samples[i] = amplitude * Math.sin((2 * Math.PI * 200 * i) / sampleRate);

    const env = rmsEnvelope(samples, sampleRate, 0.1, 0.1);
    for (const point of env) expect(point.value).toBeCloseTo(amplitude / Math.SQRT2, 2);
  });

  it("normalizeEnvelope rescales so the loudest point becomes 1", () => {
    const env = [
      { time: 0, value: 2 },
      { time: 1, value: 8 },
      { time: 2, value: 4 },
    ];
    const normalized = normalizeEnvelope(env);
    expect(normalized.map((p) => p.value)).toEqual([0.25, 1, 0.5]);
  });

  it("sampleEnvelope returns the nearest-at-or-after value for an arbitrary time", () => {
    const env = [
      { time: 0, value: 10 },
      { time: 1, value: 20 },
      { time: 2, value: 30 },
    ];
    expect(sampleEnvelope(env, 0)).toBe(10);
    expect(sampleEnvelope(env, 0.9)).toBe(20);
    expect(sampleEnvelope(env, 2)).toBe(30);
    expect(sampleEnvelope([], 5)).toBe(0);
  });
});

/** A synthetic "click track": a quiet 300Hz background tone with four short, loud broadband bursts (two unrelated sine components, so energy rises across more than one FFT bin like a real percussive hit) at known times -- proves the spectral-flux pipeline finds real transients, not just that its pieces compute correctly in isolation. Deterministic (no Math.random()) so this can never be flaky. */
function makeClickTrack(sampleRate: number, duration: number, clickTimes: number[]): Float32Array {
  const n = Math.floor(duration * sampleRate);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = 0.02 * Math.sin((2 * Math.PI * 300 * i) / sampleRate);

  const clickSamples = Math.floor(0.03 * sampleRate);
  for (const t of clickTimes) {
    const start = Math.floor(t * sampleRate);
    for (let i = 0; i < clickSamples && start + i < n; i++) {
      const x = start + i;
      samples[x] += 0.8 * Math.sin((2 * Math.PI * 1200 * x) / sampleRate) + 0.8 * Math.sin((2 * Math.PI * 3700 * x) / sampleRate);
    }
  }
  return samples;
}

function fakeAudioBuffer(samples: Float32Array, sampleRate: number): AudioBuffer {
  return {
    sampleRate,
    duration: samples.length / sampleRate,
    getChannelData: () => samples,
  } as unknown as AudioBuffer;
}

describe("end-to-end onset detection on a synthetic click track", () => {
  it("computeSpectrogram + bandFlux + pickPeaks find onsets close to the injected click times", () => {
    const sampleRate = 22050;
    const clickTimes = [0.5, 1.5, 2.5, 3.5];
    const samples = makeClickTrack(sampleRate, 4.0, clickTimes);

    const spec = computeSpectrogram(samples, sampleRate);
    const flux = bandFlux(spec.magnitudes, 0, spec.magnitudes[0].length - 1);
    const detected = pickPeaks(flux, spec.frameTimes);

    expect(detected.length).toBeGreaterThanOrEqual(clickTimes.length);
    for (const expected of clickTimes) {
      const closest = detected.reduce((best, d) => (Math.abs(d - expected) < Math.abs(best - expected) ? d : best));
      expect(Math.abs(closest - expected)).toBeLessThan(0.1);
    }
  });

  it("analyzeAudioBuffer's full pipeline reports onsets near the same click times, plus normalized 0-1 energy envelopes", () => {
    const sampleRate = 22050;
    const clickTimes = [0.5, 1.5, 2.5, 3.5];
    const samples = makeClickTrack(sampleRate, 4.0, clickTimes);

    const analysis = analyzeAudioBuffer(fakeAudioBuffer(samples, sampleRate));

    expect(analysis.duration).toBeCloseTo(4.0, 1);
    expect(analysis.onsets.length).toBeGreaterThanOrEqual(clickTimes.length);
    for (const expected of clickTimes) {
      const closest = analysis.onsets.reduce((best, d) => (Math.abs(d - expected) < Math.abs(best - expected) ? d : best));
      expect(Math.abs(closest - expected)).toBeLessThan(0.1);
    }

    for (const point of [...analysis.energy, ...analysis.bassEnergy]) {
      expect(point.value).toBeGreaterThanOrEqual(0);
      expect(point.value).toBeLessThanOrEqual(1);
    }
  });

  it("does not throw or produce NaN onsets for a buffer shorter than one FFT frame", () => {
    const sampleRate = 22050;
    const samples = new Float32Array(100); // far fewer samples than FFT_SIZE -- computeSpectrogram produces zero frames
    const analysis = analyzeAudioBuffer(fakeAudioBuffer(samples, sampleRate));

    expect(analysis.onsets).toEqual([]);
    expect(Number.isNaN(analysis.duration)).toBe(false);
  });
});
