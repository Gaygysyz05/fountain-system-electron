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
  // Shared across the Sidebar and the Devices tab so picking a zone in one affects both (previously each kept its own duplicate selection).
  selectedZoneId: number | null;
  selectZone: (zoneId: number | null) => void;

  loadDrivers: () => Promise<void>;
  loadZones: () => Promise<void>;

  renameZone: (zoneId: number, name: string | null) => Promise<void>;
  deleteZone: (zoneId: number) => Promise<void>;
  /** Returns connected/total so the caller can report whether "Connect All" actually worked, rather than leaving the operator to notice the dots on their own. */
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
  setDeviceModelNode: (zoneId: number, deviceId: string, modelNode: string | null) => Promise<void>;
}

/** Config-time state (infrequent edits) -- refetching GET /zones after every mutation is fine here, unlike zonesStore's high-frequency position/state stream (see zonesStore.ts / lib/livePosition.ts). */
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
        // First load only -- once an operator has picked a zone, a refresh must not silently steal focus back to zone 1.
        selectedZoneId: prev.selectedZoneId === null && zones.length > 0 ? zones[0].zone_id : prev.selectedZoneId,
      }));
    } catch (err) {
      set({ loading: false, error: describeError(err) });
    }
  },

  connectZone: async (zoneId) => {
    await useConnectionStore.getState().sendCommand({ command: "CONNECT_ZONE", zone_id: zoneId });
    await get().loadZones();
    // get() here, not a `zones` a caller may have destructured earlier -- that snapshot predates the loadZones() above.
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

  setDeviceModelNode: afterMutation(
    (zoneId: number, deviceId: string, modelNode: string | null) =>
      useConnectionStore.getState().sendCommand({
        command: "SET_DEVICE_MODEL_NODE",
        zone_id: zoneId,
        device_id: deviceId,
        model_node: modelNode,
      }),
    () => get().loadZones(),
  ),
}));

// Unlike zonesStore, this store has no event stream keeping it live, so a reconnect after a daemon drop would otherwise leave an already-mounted panel showing stale `connected` flags/device lists -- refetch on every transition into "open" to resync.
let previousConnectionStatus: ConnectionStatus | null = null;
const unsubscribeConfigStatus = daemonClient.onStatusChange((status) => {
  if (status === "open" && previousConnectionStatus !== null && previousConnectionStatus !== "open") {
    void useConfigStore.getState().loadDrivers();
    void useConfigStore.getState().loadZones();
  }
  previousConnectionStatus = status;
});

// See zonesStore.ts's matching comment -- daemonClient outlives this module's dev-mode HMR lifecycle, so this dispose prevents stacking a duplicate listener on every edit.
if (import.meta.hot) {
  import.meta.hot.dispose(() => unsubscribeConfigStatus());
}
