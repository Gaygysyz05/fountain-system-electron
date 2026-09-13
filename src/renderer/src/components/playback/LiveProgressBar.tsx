import { useRef } from "react";
import { zonePositions } from "../../lib/livePosition";
import { useLiveTick } from "../../lib/useLiveTick";
import { useConnectionStore } from "../../store/connectionStore";

/** Writes the fill width through a ref instead of React state despite ~20Hz updates (same pattern as LiveTimecode.tsx), driven by the shared rAF loop in lib/useLiveTick.ts. */
export function LiveProgressBar({ zoneId }: { zoneId: number }): JSX.Element {
  const fillRef = useRef<HTMLDivElement>(null);
  // Ordinary React state is fine here (changes rarely, unlike position) -- without it, a dropped WS freezes the bar with no sign to the operator that it's stale.
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
