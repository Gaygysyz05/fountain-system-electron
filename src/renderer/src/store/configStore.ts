import { create } from "zustand";
import { restClient } from "../lib/restClient";
import type { DriverDescriptorDto, ZoneConfigDto } from "../lib/protocol";
import { daemonClient, useConnectionStore } from "./connectionStore";
import type { ConnectionStatus } from "../lib/wsClient";

interface ConfigStore {
  drivers: DriverDescriptorDto[];
  zones: ZoneConfigDto[];
  loading: boolean;
  error: string | null;

  loadDrivers: () => Promise<void>;
  loadZones: () => Promise<void>;

  renameZone: (zoneId: number, name: string | null) => Promise<void>;
  deleteZone: (zoneId: number) => Promise<void>;

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

  loadDrivers: async () => {
    try {
      const drivers = await restClient.getDrivers();
      set({ drivers });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  loadZones: async () => {
    set({ loading: true });
    try {
      const zones = await restClient.getZones();
      set({ zones, loading: false, error: null });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  renameZone: async (zoneId, name) => {
    await useConnectionStore.getState().sendCommand({ command: "RENAME_ZONE", zone_id: zoneId, name });
    await get().loadZones();
  },

  deleteZone: async (zoneId) => {
    await useConnectionStore.getState().sendCommand({ command: "DELETE_ZONE", zone_id: zoneId });
    await get().loadZones();
  },

  addDriverInstance: async (zoneId, instanceId, driverType, config) => {
    await useConnectionStore.getState().sendCommand({
      command: "ADD_DRIVER_INSTANCE",
      zone_id: zoneId,
      instance_id: instanceId,
      driver_type: driverType,
      config,
    });
    await get().loadZones();
  },

  removeDriverInstance: async (zoneId, instanceId) => {
    await useConnectionStore.getState().sendCommand({
      command: "REMOVE_DRIVER_INSTANCE",
      zone_id: zoneId,
      instance_id: instanceId,
    });
    await get().loadZones();
  },

  addDevice: async (zoneId, deviceId, instanceId, channel, nozzleGroup, nozzleInverter) => {
    await useConnectionStore.getState().sendCommand({
      command: "ADD_DEVICE",
      zone_id: zoneId,
      device_id: deviceId,
      instance_id: instanceId,
      channel,
      nozzle_group: nozzleGroup ?? null,
      nozzle_inverter: nozzleInverter ?? null,
    });
    await get().loadZones();
  },

  removeDevice: async (zoneId, deviceId) => {
    await useConnectionStore.getState().sendCommand({
      command: "REMOVE_DEVICE",
      zone_id: zoneId,
      device_id: deviceId,
    });
    await get().loadZones();
  },
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
daemonClient.onStatusChange((status) => {
  if (status === "open" && previousConnectionStatus !== null && previousConnectionStatus !== "open") {
    void useConfigStore.getState().loadDrivers();
    void useConfigStore.getState().loadZones();
  }
  previousConnectionStatus = status;
});
