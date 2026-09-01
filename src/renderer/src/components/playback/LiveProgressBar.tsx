import { useEffect, useRef } from "react";
import { zonePositions } from "../../lib/livePosition";
import { useConnectionStore } from "../../store/connectionStore";

/**
 * Scenario position as a fill bar. Same non-blocking rAF pattern as
 * LiveTimecode.tsx -- reads `zonePositions` directly and writes the fill
 * width through a ref, no React state, even though this updates ~20 times a
 * second while a zone is playing.
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

  useEffect(() => {
    let frame: number;
    const tick = (): void => {
      const live = zonePositions.get(zoneId);
      const pct = live && live.duration > 0 ? Math.min(100, (live.position / live.duration) * 100) : 0;
      if (fillRef.current) fillRef.current.style.width = `${pct}%`;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [zoneId]);

  return (
    <div
      className={`h-1.5 w-full overflow-hidden rounded-full bg-bg-surface3 transition-opacity ${connected ? "" : "opacity-40"}`}
      title={connected ? undefined : "Disconnected -- position may be stale"}
    >
      <div ref={fillRef} className="h-full w-0 rounded-full bg-accent" />
    </div>
  );
}
