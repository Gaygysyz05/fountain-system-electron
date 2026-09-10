import { useRef } from "react";
import { formatTime } from "../../lib/formatTime";
import { zonePositions } from "../../lib/livePosition";
import { useLiveTick } from "../../lib/useLiveTick";
import { useConnectionStore } from "../../store/connectionStore";

/**
 * Reads `zonePositions` (see lib/livePosition.ts) directly inside the
 * shared rAF loop (lib/useLiveTick.ts) and writes to the DOM through a
 * ref -- no React state, no re-render, even though this updates ~20 times
 * a second while a zone is playing. Same non-blocking pattern as
 * ScenePreview.tsx's useFrame, just driven by rAF instead of the R3F
 * render loop.
 */
export function LiveTimecode({ zoneId, className }: { zoneId: number; className?: string }): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  // See LiveProgressBar.tsx's comment -- same rarely-changing status read,
  // same reason: a frozen timecode after a WS drop looks identical to a
  // genuinely stalled show without this.
  const connected = useConnectionStore((s) => s.status === "open");

  useLiveTick(() => {
    const live = zonePositions.get(zoneId);
    if (ref.current) {
      ref.current.textContent = live ? `${formatTime(live.position)} / ${formatTime(live.duration)}` : "--:-- / --:--";
    }
  });

  return (
    <span
      ref={ref}
      className={`font-mono transition-opacity ${className ?? "text-sm text-text-secondary"} ${connected ? "" : "opacity-40"}`}
      title={connected ? undefined : "Disconnected -- position may be stale"}
    >
      --:-- / --:--
    </span>
  );
}
