import { useRef } from "react";
import { zonePositions } from "../../lib/livePosition";
import { useLiveTick } from "../../lib/useLiveTick";
import { useConnectionStore } from "../../store/connectionStore";

/**
 * Scenario position as a fill bar. Same non-blocking pattern as
 * LiveTimecode.tsx -- reads `zonePositions` directly and writes the fill
 * width through a ref, no React state, even though this updates ~20 times a
 * second while a zone is playing. Driven by the shared rAF loop in
 * lib/useLiveTick.ts, not its own -- see that file's comment.
 */
export function LiveProgressBar({ zoneId }: { zoneId: number }): JSX.Element {
  const fillRef = useRef<HTMLDivElement>(null);
  // Connection status changes rarely (a handful of times per session, not
  // 20Hz) -- fine as ordinary React state, unlike the position itself
  // below. Without this, a dropped WS just freezes the bar at its last
  // value with nothing telling the operator it's no longer live -- there's
  // no interpolation here to drift, but a frozen bar looks identical to a
  // genuinely stalled show.
  const connected = useConnectionStore((s) => s.status === "open");

  useLiveTick(() => {
    const live = zonePositions.get(zoneId);
    const pct = live && live.duration > 0 ? Math.min(100, (live.position / live.duration) * 100) : 0;
    if (fillRef.current) fillRef.current.style.width = `${pct}%`;
  });

  return (
    <div
      className={`h-1.5 w-full overflow-hidden rounded-full bg-bg-surface3 transition-opacity ${connected ? "" : "opacity-40"}`}
      title={connected ? undefined : "Disconnected -- position may be stale"}
    >
      <div ref={fillRef} className="h-full w-0 rounded-full bg-accent" />
    </div>
  );
}
