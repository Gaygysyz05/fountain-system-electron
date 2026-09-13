/** Client-side audio decode (Web Audio API) for the timeline's waveform display, so authoring a scenario's timeline never needs the daemon actually running audio playback -- just serving the raw file bytes (GET /audio). */
export interface WaveformPeaks {
  min: Float32Array;
  max: Float32Array;
}

/** Same decode as decodeAudioPeaks below, but "Choose music" only needs the duration (to set the scenario's duration), not the full peaks array. */
export async function decodeAudioDuration(arrayBuffer: ArrayBuffer): Promise<number> {
  const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const audioContext = new AudioContextCtor();
  try {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    return audioBuffer.duration;
  } finally {
    void audioContext.close();
  }
}

/** One min/max pair per output column, downsampled from raw samples, so the waveform renders at a fixed width regardless of source duration/sample rate. */
export async function decodeAudioPeaks(arrayBuffer: ArrayBuffer, columns: number): Promise<WaveformPeaks> {
  const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const audioContext = new AudioContextCtor();
  try {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    const channelData = audioBuffer.getChannelData(0); // mono downmix: good enough for a visual reference, not a mixer

    const samplesPerColumn = Math.max(1, Math.floor(channelData.length / columns));
    const min = new Float32Array(columns);
    const max = new Float32Array(columns);

    for (let col = 0; col < columns; col++) {
      const start = col * samplesPerColumn;
      const end = Math.min(start + samplesPerColumn, channelData.length);
      let mn = 0;
      let mx = 0;
      for (let i = start; i < end; i++) {
        const v = channelData[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      min[col] = mn;
      max[col] = mx;
    }

    return { min, max };
  } finally {
    void audioContext.close();
  }
}
