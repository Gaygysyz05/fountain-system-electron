import { create } from "zustand";
import { describeError } from "../lib/errors";
import { restClient } from "../lib/restClient";
import { afterMutation } from "../lib/storeHelpers";
import type { DriverDescriptorDto, ZoneConfigDto } from "../lib/protocol";
import { daemonClient, useConnectionStore } from "./connectionStore";
import type { ConnectionStatus } from "../lib/wsClient";

interface ConfigStore {
  drivers: DriverDescriptorDto[];
  zones: ZoneConfigDto[];
  loading: boolean;
  error: string | null;
  // Shared across the Sidebar and the Devices tab -- previously the Devices
  // tab kept its own separate zone list + selection, duplicating the
  // Sidebar's (same zones, side by side, picking one didn't affect the
  // other). One selection, one place it lives.
  selectedZoneId: number | null;
  selectZone: (zoneId: number | null) => void;

  loadDrivers: () => Promise<void>;
  loadZones: () => Promise<void>;

  renameZone: (zoneId: number, name: string | null) => Promise<void>;
  deleteZone: (zoneId: number) => Promise<void>;
  /** Resolves with how many of the zone's driver instances ended up
   * connected -- the button that calls this used to be pure
   * fire-and-forget, with nothing telling the operator whether "Connect
   * All" actually did anything until they noticed the dots on their own. */
  connectZone: (zoneId: number) => Promise<{ connected: number; total: number }>;

  addDriverInstance: (zoneId: number, instanceId: string, driverType: string, config: Record<string, unknown>) => Promise<void>;
  removeDriverInstance: (zoneId: number, instanceId: string) => Promise<void>;
  addDevice: (
    zoneId: number,
    deviceId: string,
    instanceId: string,
    channel: string,
    nozzleGroup?: string,
    nozzleInverter?: 1 | 2,
  ) => Promise<void>;
  removeDevice: (zoneId: number, deviceId: string) => Promise<void>;
}

/**
 * This is config-time state (add/remove a device, a handful of times per
 * setup session), not the high-frequency runtime state in zonesStore --
 * re-fetching GET /zones after every mutation is simple and correct here,
 * unlike the position/state stream, which genuinely needed the split
 * documented in zonesStore.ts / lib/livePosition.ts.
 */
export const useConfigStore = create<ConfigStore>((set, get) => ({
  drivers: [],
  zones: [],
  loading: false,
  error: null,
  selectedZoneId: null,
  selectZone: (zoneId) => set({ selectedZoneId: zoneId }),

  loadDrivers: async () => {
    try {
      const drivers = await restClient.getDrivers();
      set({ drivers });
    } catch (err) {
      set({ error: describeError(err) });
    }
  },

  loadZones: async () => {
    set({ loading: true });
    try {
      const zones = await restClient.getZones();
      set((prev) => ({
        zones,
        loading: false,
        error: null,
        // First load only -- once an operator has picked a zone, a
        // background refresh must not silently steal focus back to zone 1.
        selectedZoneId: prev.selectedZoneId === null && zones.length > 0 ? zones[0].zone_id : prev.selectedZoneId,
      }));
    } catch (err) {
      set({ loading: false, error: describeError(err) });
    }
  },

  connectZone: async (zoneId) => {
    await useConnectionStore.getState().sendCommand({ command: "CONNECT_ZONE", zone_id: zoneId });
    await get().loadZones();
    // get() here, not the `zones` a caller may have destructured earlier --
    // that snapshot predates the loadZones() above and would report last
    // attempt's result, not this one's.
    const instances = get().zones.find((z) => z.zone_id === zoneId)?.driver_instances ?? [];
    return { connected: instances.filter((i) => i.connected).length, total: instances.length };
  },

  renameZone: afterMutation(
    (zoneId: number, name: string | null) =>
      useConnectionStore.getState().sendCommand({ command: "RENAME_ZONE", zone_id: zoneId, name }),
    () => get().loadZones(),
  ),

  deleteZone: async (zoneId) => {
    await useConnectionStore.getState().sendCommand({ command: "DELETE_ZONE", zone_id: zoneId });
    if (get().selectedZoneId === zoneId) set({ selectedZoneId: null });
    await get().loadZones();
  },

  addDriverInstance: afterMutation(
    (zoneId: number, instanceId: string, driverType: string, config: Record<string, unknown>) =>
      useConnectionStore.getState().sendCommand({
        command: "ADD_DRIVER_INSTANCE",
        zone_id: zoneId,
        instance_id: instanceId,
        driver_type: driverType,
        config,
      }),
    () => get().loadZones(),
  ),

  removeDriverInstance: afterMutation(
    (zoneId: number, instanceId: string) =>
      useConnectionStore.getState().sendCommand({
        command: "REMOVE_DRIVER_INSTANCE",
        zone_id: zoneId,
        instance_id: instanceId,
      }),
    () => get().loadZones(),
  ),

  addDevice: afterMutation(
    (zoneId: number, deviceId: string, instanceId: string, channel: string, nozzleGroup?: string, nozzleInverter?: 1 | 2) =>
      useConnectionStore.getState().sendCommand({
        command: "ADD_DEVICE",
        zone_id: zoneId,
        device_id: deviceId,
        instance_id: instanceId,
        channel,
        nozzle_group: nozzleGroup ?? null,
        nozzle_inverter: nozzleInverter ?? null,
      }),
    () => get().loadZones(),
  ),

  removeDevice: afterMutation(
    (zoneId: number, deviceId: string) =>
      useConnectionStore.getState().sendCommand({ command: "REMOVE_DEVICE", zone_id: zoneId, device_id: deviceId }),
    () => get().loadZones(),
  ),
}));

// Unlike zonesStore, this one has no event stream keeping it live -- it only
// ever changes via an explicit fetch. Every screen that reads it already
// fetches once on mount, but that snapshot goes stale exactly when it
// matters most: a dropped/restarted daemon connection reconnecting while a
// panel is already mounted (e.g. Devices tab open across a daemon restart)
// left driver `connected` flags, device lists and global_brightness/speed
// frozen at their pre-drop values with nothing to refresh them -- an
// operator could see a driver instance shown "connected" that no longer is.
// Refetch on every transition INTO "open" (first connect included -- a
// harmless extra fetch alongside whichever panel's own mount-time load
// happens to be racing it) keeps this resynced the same way zonesStore's
// event stream keeps itself live.
let previousConnectionStatus: ConnectionStatus | null = null;
const unsubscribeConfigStatus = daemonClient.onStatusChange((status) => {
  if (status === "open" && previousConnectionStatus !== null && previousConnectionStatus !== "open") {
    void useConfigStore.getState().loadDrivers();
    void useConfigStore.getState().loadZones();
  }
  previousConnectionStatus = status;
});

// See zonesStore.ts's matching comment -- daemonClient outlives this
// module's own dev-mode HMR lifecycle, so a reload without this would
// stack one more duplicate refetch-on-reconnect listener on every edit.
if (import.meta.hot) {
  import.meta.hot.dispose(() => unsubscribeConfigStatus());
}
