import { create } from "zustand";
import type {
  ConnectionStateEvent,
  DaemonEvent,
  DeviceStateEvent,
  HardwareErrorEvent,
  ZoneStatusEvent,
} from "../lib/protocol";
import { daemonClient, useConnectionStore } from "./connectionStore";

const MAX_RECENT_ERRORS = 50;

// A WS connection can stay technically "open" (TCP socket alive) while the
// daemon's own asyncio event loop is deadlocked underneath it -- no
// scenario progressing, no heartbeat, nothing -- with the HMI still
// confidently showing "Connected" and no way for an operator to tell short
// of noticing the fountain itself has stopped doing anything. The daemon's
// own heartbeat (every 5s, see main.py's ws_endpoint) exists for exactly
// this, but until now nothing on this side actually watched for it going
// quiet -- it was received and thrown away. STALE_THRESHOLD_MS is 3x that
// interval: comfortably past normal jitter, not so long that a real freeze
// goes unnoticed for a full playback cycle.
const STALE_THRESHOLD_MS = 15_000;

interface ZonesStore {
  // Keyed by zone_id / device_id, not by array index -- the whole point of
  // the redesign is that zone/device count is data, not a fixed shape the
  // UI was built around. See the "no hardcoded 6 zones" discussion.
  //
  // IMPORTANT: `position`/`duration` on these objects are a snapshot from
  // the last time `state` changed, NOT live -- this map deliberately does
  // not update on position-only ticks (see the comment in applyEvent below
  // and lib/livePosition.ts). Read live position from `zonePositions`
  // there, never from here.
  zones: Map<number, ZoneStatusEvent>;
  // key: `${zone_id}:${instance_id}:${channel}` -- matches a ZoneConfigDto
  // device's (instance_id, channel), NOT its device_id (see
  // DeviceStateEvent's own doc comment for why not). Look this key up with
  // deviceStateKey() below rather than building the string inline.
  devices: Map<string, DeviceStateEvent>;
  connections: Map<string, ConnectionStateEvent>; // key: `${zone_id}:${subsystem}`
  recentErrors: HardwareErrorEvent[];

  /** Timestamp of the most recently received daemon message, of ANY type --
   * not just heartbeat. A zone_status tick during playback proves the event
   * loop is alive just as well, and is usually far more recent than the
   * last heartbeat anyway. */
  lastMessageAt: number;
  /** True once the gap since lastMessageAt exceeds STALE_THRESHOLD_MS while
   * the WS itself still reports "open" -- see the module-level watcher
   * below. StatusBar surfaces this distinctly from a dropped connection:
   * the operator needs to know "the socket is open but nothing is coming
   * through" is a DIFFERENT, worse failure than a normal reconnect-in-progress. */
  stale: boolean;

  applyEvent: (event: DaemonEvent) => void;
}

export function deviceStateKey(zoneId: number, instanceId: string, channel: string): string {
  return `${zoneId}:${instanceId}:${channel}`;
}

export const useZonesStore = create<ZonesStore>((set) => ({
  zones: new Map(),
  devices: new Map(),
  connections: new Map(),
  recentErrors: [],
  lastMessageAt: Date.now(),
  stale: false,

  applyEvent: (event: DaemonEvent) =>
    set((prev) => {
      const patch = ((): Partial<ZonesStore> => {
      switch (event.type) {
        case "zone_status": {
          // Re-render on an actual state transition (stopped -> playing,
          // etc.) OR a scenario switch that doesn't change state (Play
          // pressed with a different scenario picked while already
          // playing -- stays "playing" throughout, only scenario_id
          // changes) -- but not on position ticks, which is why this
          // isn't just `existing !== event`. Position ticks ~20Hz per
          // playing zone and are handled entirely outside React state,
          // see lib/livePosition.ts.
          const existing = prev.zones.get(event.zone_id);
          if (
            existing &&
            existing.state === event.state &&
            existing.scenario_id === event.scenario_id &&
            existing.is_looping === event.is_looping
          ) {
            return {};
          }
          const zones = new Map(prev.zones);
          zones.set(event.zone_id, event);
          return { zones };
        }
        case "device_event": {
          const devices = new Map(prev.devices);
          devices.set(deviceStateKey(event.zone_id, event.instance_id, event.channel), event);
          return { devices };
        }
        case "connection_state": {
          const connections = new Map(prev.connections);
          connections.set(`${event.zone_id}:${event.subsystem}`, event);
          return { connections };
        }
        case "hardware_error": {
          const recentErrors = [event, ...prev.recentErrors].slice(0, MAX_RECENT_ERRORS);
          return { recentErrors };
        }
        case "heartbeat":
          return {};
      }
      })();
      // lastMessageAt/stale update on every event, of every type -- merged
      // in here rather than repeated in each case above.
      return { ...patch, lastMessageAt: Date.now(), stale: false };
    }),
}));

// Reset the clock the instant a connection actually opens -- otherwise a
// long-closed tab's stale module-load-time timestamp would read as
// "stale" for the first STALE_THRESHOLD_MS after reconnecting, before a
// single real message has even had a chance to arrive.
const unsubscribeStatus = daemonClient.onStatusChange((status) => {
  if (status === "open") useZonesStore.setState({ lastMessageAt: Date.now(), stale: false });
});

// Polls rather than a per-message timer reset (cheaper: one setInterval
// for the app's whole lifetime instead of clearTimeout/setTimeout on every
// single incoming message, some of which arrive at ~20Hz during playback).
const staleCheckInterval = setInterval(() => {
  if (useConnectionStore.getState().status !== "open") return;
  const { lastMessageAt, stale } = useZonesStore.getState();
  const isStale = Date.now() - lastMessageAt > STALE_THRESHOLD_MS;
  if (isStale !== stale) useZonesStore.setState({ stale: isStale });
}, 5000);

// Wire the daemon's event stream into this store once, at module load. This
// is the ONLY place `applyEvent` gets called from the live connection --
// components never touch the socket directly, only this store's state.
const unsubscribeEvent = daemonClient.onEvent((event) => {
  useZonesStore.getState().applyEvent(event);
});

// Vite's dev-mode HMR re-runs this module's top-level code on every edit
// to it (or anything that transitively invalidates up to here) -- but
// `daemonClient` is a long-lived singleton that outlives this module's own
// HMR lifecycle, so without tearing the PREVIOUS instance's subscriptions
// down first, each reload stacks one more duplicate status listener,
// interval, and event listener on top of the last. import.meta.hot is
// undefined in a production build, so this is a no-op there.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribeStatus();
    clearInterval(staleCheckInterval);
    unsubscribeEvent();
  });
}
