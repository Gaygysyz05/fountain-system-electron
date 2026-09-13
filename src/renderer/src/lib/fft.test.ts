import { describe, expect, it } from "vitest";
import { fft, previousPowerOfTwo } from "./fft";

function magnitude(re: Float64Array, im: Float64Array): Float64Array {
  const out = new Float64Array(re.length);
  for (let i = 0; i < re.length; i++) out[i] = Math.hypot(re[i], im[i]);
  return out;
}

describe("fft", () => {
  it("rejects mismatched or non-power-of-2 lengths instead of silently producing garbage", () => {
    expect(() => fft(new Float64Array(8), new Float64Array(4))).toThrow(/length mismatch/);
    expect(() => fft(new Float64Array(6), new Float64Array(6))).toThrow(/not a power of 2/);
  });

  it("a DC (constant) signal transforms to all its energy in bin 0", () => {
    const n = 64;
    const re = new Float64Array(n).fill(1);
    const im = new Float64Array(n);
    fft(re, im);
    const mag = magnitude(re, im);
    expect(mag[0]).toBeCloseTo(n, 6);
    for (let i = 1; i < n; i++) expect(mag[i]).toBeCloseTo(0, 6);
  });

  it("an impulse (single sample = 1) transforms to a flat spectrum", () => {
    const n = 64;
    const re = new Float64Array(n);
    re[0] = 1;
    const im = new Float64Array(n);
    fft(re, im);
    const mag = magnitude(re, im);
    for (let i = 0; i < n; i++) expect(mag[i]).toBeCloseTo(1, 6);
  });

  it("a pure sinusoid at bin k produces peaks only at bin k and its mirror n-k", () => {
    const n = 64;
    const k = 5;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * k * i) / n);
    fft(re, im);
    const mag = magnitude(re, im);

    expect(mag[k]).toBeGreaterThan(n / 4);
    expect(mag[n - k]).toBeGreaterThan(n / 4);
    for (let i = 0; i < n; i++) {
      if (i === k || i === n - k) continue;
      expect(mag[i]).toBeLessThan(1e-6);
    }
  });
});

describe("previousPowerOfTwo", () => {
  it("rounds down to the nearest power of 2", () => {
    expect(previousPowerOfTwo(1)).toBe(1);
    expect(previousPowerOfTwo(2)).toBe(2);
    expect(previousPowerOfTwo(5)).toBe(4);
    expect(previousPowerOfTwo(2048)).toBe(2048);
    expect(previousPowerOfTwo(2049)).toBe(2048);
  });

  it("returns 0 for a non-positive input", () => {
    expect(previousPowerOfTwo(0)).toBe(0);
    expect(previousPowerOfTwo(-5)).toBe(0);
  });
});
