import { useEffect, type RefObject } from "react";

// React's onWheel is passive by default, so e.preventDefault() there is silently ignored; a native non-passive listener is required to stop the page from scrolling instead.
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
