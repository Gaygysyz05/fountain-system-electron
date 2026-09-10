import { useEffect, useRef } from "react";

/**
 * One shared requestAnimationFrame loop for every live-position readout
 * (LiveProgressBar, LiveTimecode, ScenarioTimelinePlayer's playhead) --
 * each of those used to run its OWN independent rAF chain reading
 * lib/livePosition.ts's `zonePositions` and writing straight to the DOM
 * through a ref, same pattern, one copy per component. On an overview
 * showing every zone at once that's 16 separate per-frame browser
 * callbacks (2 components x 8 zones) instead of one loop calling 16
 * listeners. The shared loop starts lazily on the first subscriber and
 * stops once the last one leaves, so an idle screen with nothing playing
 * doesn't keep rAF spinning for no reason either.
 */
type TickListener = () => void;

const listeners = new Set<TickListener>();
let frame: number | null = null;

function loop(): void {
  for (const listener of listeners) listener();
  frame = requestAnimationFrame(loop);
}

export function useLiveTick(callback: () => void): void {
  // Latest-ref pattern: the subscription itself (below) only ever
  // happens once per mount -- re-subscribing on every render would mean
  // constantly leaving and rejoining the shared listener set, which for
  // the LAST remaining subscriber would cancel and restart the whole
  // shared loop every render. Reading through the ref keeps whatever
  // `callback` closed over (zoneId, pxPerSecond, etc.) current without that.
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    const listener: TickListener = () => callbackRef.current();
    listeners.add(listener);
    if (listeners.size === 1) frame = requestAnimationFrame(loop);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
    };
  }, []);
}
