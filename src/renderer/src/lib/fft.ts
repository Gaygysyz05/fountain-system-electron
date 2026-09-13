/** In-place iterative radix-2 Cooley-Tukey FFT -- textbook bit-reversal + butterfly stages, no external dependency needed for the frame sizes (1024-4096) audio onset detection uses. `re`/`im` must share a power-of-2 length; pass a zero-filled `im` for a real-valued input. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n !== im.length) throw new Error("fft: re/im length mismatch");
  if (n <= 1) return;
  if ((n & (n - 1)) !== 0) throw new Error(`fft: length ${n} is not a power of 2`);

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < half; k++) {
        const aIdx = i + k;
        const bIdx = aIdx + half;
        const uRe = re[aIdx];
        const uIm = im[aIdx];
        const vRe = re[bIdx] * curRe - im[bIdx] * curIm;
        const vIm = re[bIdx] * curIm + im[bIdx] * curRe;
        re[aIdx] = uRe + vRe;
        im[aIdx] = uIm + vIm;
        re[bIdx] = uRe - vRe;
        im[bIdx] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        const nextIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
        curIm = nextIm;
      }
    }
  }
}

/** `re.length` rounded down to the nearest power of 2 -- fft() requires an exact power of 2, so callers slicing a fixed-size window (always already a power of 2 by construction, e.g. 2048) don't need this; it exists for anything that might hand in an arbitrary length. */
export function previousPowerOfTwo(n: number): number {
  if (n < 1) return 0;
  return 1 << Math.floor(Math.log2(n));
}
