import { useEffect, useRef } from "react";

/**
 * One shared requestAnimationFrame loop for every live-position readout, instead of each consumer running its own rAF chain; starts lazily on the first subscriber and stops once the last one leaves.
 */
type TickListener = () => void;

const listeners = new Set<TickListener>();
let frame: number | null = null;

function loop(): void {
  for (const listener of listeners) listener();
  frame = requestAnimationFrame(loop);
}

export function useLiveTick(callback: () => void): void {
  // Latest-ref pattern: subscribe once per mount, not every render, so the last remaining subscriber doesn't cancel/restart the shared loop each time; the ref keeps `callback` current instead.
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
