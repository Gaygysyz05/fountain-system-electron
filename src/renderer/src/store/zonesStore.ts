import { create } from "zustand";
import type {
  ConnectionStateEvent,
  DaemonEvent,
  DeviceStateEvent,
  HardwareErrorEvent,
  ZoneStatusEvent,
} from "../lib/protocol";
import { daemonClient } from "./connectionStore";

const MAX_RECENT_ERRORS = 50;

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
  devices: Map<string, DeviceStateEvent>;
  connections: Map<string, ConnectionStateEvent>; // key: `${zone_id}:${subsystem}`
  recentErrors: HardwareErrorEvent[];

  applyEvent: (event: DaemonEvent) => void;
}

export const useZonesStore = create<ZonesStore>((set) => ({
  zones: new Map(),
  devices: new Map(),
  connections: new Map(),
  recentErrors: [],

  applyEvent: (event: DaemonEvent) =>
    set((prev) => {
      switch (event.type) {
        case "zone_status": {
          // Re-render only on an actual state transition (stopped -> playing,
          // etc.) -- position ticks ~20Hz per playing zone and is handled
          // entirely outside React state, see lib/livePosition.ts.
          const existing = prev.zones.get(event.zone_id);
          if (existing && existing.state === event.state) return {};
          const zones = new Map(prev.zones);
          zones.set(event.zone_id, event);
          return { zones };
        }
        case "device_event": {
          const devices = new Map(prev.devices);
          devices.set(event.device_id, event);
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
          return {}; // liveness only; see connectionStore for WS status itself
      }
    }),
}));

// Wire the daemon's event stream into this store once, at module load. This
// is the ONLY place `applyEvent` gets called from the live connection --
// components never touch the socket directly, only this store's state.
daemonClient.onEvent((event) => {
  useZonesStore.getState().applyEvent(event);
});
