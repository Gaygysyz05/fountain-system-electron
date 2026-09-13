import { daemonClient } from "../store/connectionStore";

export interface ZonePosition {
  position: number;
  duration: number;
}

/**
 * Plain mutable registry (not Zustand state) because `zone_status` ticks at ~20Hz per playing zone and piping that through `set()` would re-render every subscriber that much; read it inside rAF/`useFrame` for live values, or use zonesStore's `zones` map for state-transition-only subscriptions.
 */
export const zonePositions = new Map<number, ZonePosition>();

const unsubscribe = daemonClient.onEvent((event) => {
  if (event.type === "zone_status") {
    zonePositions.set(event.zone_id, { position: event.position, duration: event.duration });
  }
});

// daemonClient outlives this module's HMR lifecycle, so without this a reload would stack a duplicate listener (same as zonesStore.ts).
if (import.meta.hot) {
  import.meta.hot.dispose(() => unsubscribe());
}
