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
  // key: `${zone_id}:${instance_id}:${channel}` -- matches a ZoneConfigDto
  // device's (instance_id, channel), NOT its device_id (see
  // DeviceStateEvent's own doc comment for why not). Look this key up with
  // deviceStateKey() below rather than building the string inline.
  devices: Map<string, DeviceStateEvent>;
  connections: Map<string, ConnectionStateEvent>; // key: `${zone_id}:${subsystem}`
  recentErrors: HardwareErrorEvent[];

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

  applyEvent: (event: DaemonEvent) =>
    set((prev) => {
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
          if (existing && existing.state === event.state && existing.scenario_id === event.scenario_id) return {};
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
