import { useEffect, type RefObject } from "react";

/**
 * Lets a numeric field be adjusted by scrolling over it, no click/focus
 * needed first -- React's onWheel is passive by default (perf optimization
 * for the common "let the page scroll" case), so e.preventDefault() inside
 * a JSX onWheel handler is silently ignored and the page scrolls out from
 * under the field instead of the value changing. A native, non-passive
 * listener attached directly to the element is the only way around that.
 */
export function useWheelStep(ref: RefObject<HTMLElement>, onStep: (direction: 1 | -1) => void): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    function handleWheel(e: WheelEvent): void {
      e.preventDefault();
      onStep(e.deltaY < 0 ? 1 : -1);
    }

    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [ref, onStep]);
}
