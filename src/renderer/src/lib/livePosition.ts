import { daemonClient } from "../store/connectionStore";

export interface ZonePosition {
  position: number;
  duration: number;
}

/**
 * `zone_status` events arrive on every scheduler tick (~20Hz per playing
 * zone -- see fountain-daemon's ZoneScenarioPlayer). That's fine for a
 * transport readout or a 3D preview to animate against, but piping every
 * tick through Zustand `set()` would re-render every subscribed component
 * 20x/sec for a number nobody reading "is this zone playing?" cares about.
 *
 * This is a plain mutable registry, updated directly on every event, with no
 * React/Zustand involved. Consumers that need the *live* number (a timecode
 * label, the 3D preview's animation) read it inside `requestAnimationFrame`
 * / R3F's `useFrame` -- i.e. already on their own render loop -- instead of
 * subscribing to it as state. Consumers that only need *state transitions*
 * (idle -> playing -> stopped) should use zonesStore's `zones` map instead,
 * which intentionally does NOT update on position-only ticks.
 */
export const zonePositions = new Map<number, ZonePosition>();

const unsubscribe = daemonClient.onEvent((event) => {
  if (event.type === "zone_status") {
    zonePositions.set(event.zone_id, { position: event.position, duration: event.duration });
  }
});

// Same dev-mode HMR concern as zonesStore.ts's matching comment --
// daemonClient outlives this module's own HMR lifecycle, so a reload
// without this would stack one more duplicate event listener on every edit.
if (import.meta.hot) {
  import.meta.hot.dispose(() => unsubscribe());
}
