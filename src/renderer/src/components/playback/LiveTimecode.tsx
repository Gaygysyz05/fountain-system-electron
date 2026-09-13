import { useRef } from "react";
import { formatTime } from "../../lib/formatTime";
import { zonePositions } from "../../lib/livePosition";
import { useLiveTick } from "../../lib/useLiveTick";
import { useConnectionStore } from "../../store/connectionStore";

// Writes to the DOM via ref instead of React state to avoid re-rendering at the ~20/s rAF tick rate (same pattern as ScenePreview.tsx's useFrame).
export function LiveTimecode({ zoneId, className }: { zoneId: number; className?: string }): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  // Without this, a frozen timecode after a WS drop looks identical to a genuinely stalled show.
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
