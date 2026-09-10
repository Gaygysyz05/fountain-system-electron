import { useEffect, useRef, useState } from "react";
import { restClient } from "../../lib/restClient";
import { decodeAudioPeaks } from "../../lib/waveform";

interface WaveformCanvasProps {
  musicFile: string | null;
  width: number;
  height: number;
}

/**
 * Purely visual reference band under the ruler -- not interactive, doesn't
 * participate in click-to-add-event. Re-decodes whenever musicFile or width
 * changes (width changes when duration changes, since that's what the
 * timeline scales pixels-per-second against).
 */
export function WaveformCanvas({ musicFile, width, height }: WaveformCanvasProps): JSX.Element | null {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setError(null);
    if (!musicFile || width <= 0) return;

    // AbortController, not just a `cancelled` flag -- a flag only stops
    // this effect from ACTING on a superseded run's result, it doesn't
    // stop the fetch/decode itself from running. Picking through several
    // tracks quickly used to leave every earlier fetch (and, if it got far
    // enough, the CPU-heavy peak decode) running to completion in the
    // background for a result that was always going to be thrown away.
    // Passing `signal` to fetch() cancels the network request outright;
    // the explicit aborted checks below additionally skip starting the
    // decode step at all for a fetch that finished right as this effect
    // was already being torn down.
    const controller = new AbortController();
    setLoading(true);

    (async () => {
      const res = await fetch(restClient.audioUrl(musicFile), { signal: controller.signal });
      if (!res.ok) throw new Error(`audio file not found (${res.status})`);
      const buffer = await res.arrayBuffer();
      if (controller.signal.aborted) return;
      const peaks = await decodeAudioPeaks(buffer, Math.max(1, Math.round(width)));
      if (controller.signal.aborted) return;

      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;

      canvas.width = width;
      canvas.height = height;
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "#5a5a5c";
      const mid = height / 2;
      for (let col = 0; col < peaks.min.length; col++) {
        const y1 = mid + peaks.min[col] * mid;
        const y2 = mid + peaks.max[col] * mid;
        ctx.fillRect(col, y1, 1, Math.max(1, y2 - y1));
      }
    })()
      .catch((err: unknown) => {
        if (controller.signal.aborted) return; // superseded, not a real failure
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [musicFile, width, height]);

  if (!musicFile) return null;

  return (
    <div className="pointer-events-none absolute left-0 top-0" style={{ width, height }}>
      <canvas ref={canvasRef} className="opacity-60" />
      {loading && <span className="absolute left-1 top-1 text-[10px] text-text-muted">decoding…</span>}
      {error && <span className="absolute left-1 top-1 text-[10px] text-danger">{error}</span>}
    </div>
  );
}
