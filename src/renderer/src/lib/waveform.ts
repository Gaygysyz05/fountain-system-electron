/**
 * Client-side audio decode for the timeline's waveform display -- entirely
 * browser-side (Web Audio API), no daemon involvement beyond serving the
 * raw file bytes (GET /audio). This is the "browser draws" half of the
 * daemon-plays-vs-browser-draws split from the audio architecture
 * discussion: authoring a scenario's timeline never needs the daemon to be
 * running audio playback, only to hand over the file.
 */
export interface WaveformPeaks {
  min: Float32Array;
  max: Float32Array;
}

/** One min/max pair per output column, downsampled from the raw samples --
 * the standard "peaks" representation for rendering a waveform at a fixed
 * pixel width regardless of how long or high-sample-rate the source is. */
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
