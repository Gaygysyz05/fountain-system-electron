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

// 3x the daemon's 5s heartbeat (main.py ws_endpoint) -- past normal jitter, but catches a frozen event loop while the WS still reports "open".
const STALE_THRESHOLD_MS = 15_000;

interface ZonesStore {
  // `position`/`duration` here are a snapshot as of the last `state` change, NOT live -- read live position from `zonePositions` (lib/livePosition.ts), never from here.
  zones: Map<number, ZoneStatusEvent>;
  // key: `${zone_id}:${instance_id}:${channel}` -- matches ZoneConfigDto's device key, not device_id; build it via deviceStateKey() below.
  devices: Map<string, DeviceStateEvent>;
  connections: Map<string, ConnectionStateEvent>; // key: `${zone_id}:${subsystem}`
  recentErrors: HardwareErrorEvent[];

  /** Timestamp of the most recent daemon message of any type -- a zone_status tick proves the event loop is alive just as well as a heartbeat, and is usually more recent. */
  lastMessageAt: number;
  /** True once the gap since lastMessageAt exceeds STALE_THRESHOLD_MS while the WS still reports "open" -- a worse failure than a normal reconnect, surfaced distinctly in StatusBar. */
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
          // Skip re-render on position-only ticks (~20Hz per playing zone, handled outside React state via lib/livePosition.ts); re-render on real state/scenario/looping changes only.
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
      // lastMessageAt/stale update on every event type, merged in here rather than repeated per case above.
      return { ...patch, lastMessageAt: Date.now(), stale: false };
    }),
}));

// Reset on connect so a long-closed tab's stale module-load timestamp doesn't read as "stale" before any real message arrives.
const unsubscribeStatus = daemonClient.onStatusChange((status) => {
  if (status === "open") useZonesStore.setState({ lastMessageAt: Date.now(), stale: false });
});

// Polls on one interval rather than resetting a timer per message -- cheaper given messages can arrive at ~20Hz during playback.
const staleCheckInterval = setInterval(() => {
  if (useConnectionStore.getState().status !== "open") return;
  const { lastMessageAt, stale } = useZonesStore.getState();
  const isStale = Date.now() - lastMessageAt > STALE_THRESHOLD_MS;
  if (isStale !== stale) useZonesStore.setState({ stale: isStale });
}, 5000);

// The only place `applyEvent` is called from the live connection -- components never touch the socket directly, only this store's state.
const unsubscribeEvent = daemonClient.onEvent((event) => {
  useZonesStore.getState().applyEvent(event);
});

// Tear down the previous HMR instance's subscriptions first, or each dev-mode reload stacks duplicate listeners on the long-lived `daemonClient` singleton; no-op in production.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribeStatus();
    clearInterval(staleCheckInterval);
    unsubscribeEvent();
  });
}
