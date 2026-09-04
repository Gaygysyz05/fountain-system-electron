import { useEffect, useMemo, useRef, useState } from "react";
import { useConfigStore } from "../../store/configStore";
import { useConnectionStore } from "../../store/connectionStore";
import { deviceStateKey, useZonesStore } from "../../store/zonesStore";
import { ChannelGrid } from "./ChannelGrid";
import { SchemaForm } from "./SchemaForm";
import type { DeviceType, ZoneConfigDto } from "../../lib/protocol";

const CATEGORY_LABEL: Record<DeviceType, string> = { valve: "Valve", motor: "Motor", light: "Light" };

type StatusFilter = "all" | "connected" | "disconnected";

/**
 * The screen this whole driver-registry rework exists to unlock: configure
 * an arbitrary number of zones, each with an arbitrary number of driver
 * instances (physical connections) and devices (channels on them), entirely
 * through the UI -- no code, no fixed zone/device count. See the "universal
 * program" architecture discussion this was built from.
 */
export function DeviceConfigPanel(): JSX.Element {
  const {
    drivers,
    zones,
    loading,
    error,
    loadDrivers,
    loadZones,
    selectedZoneId,
    selectZone,
    connectZone,
    addDriverInstance,
    removeDriverInstance,
    addDevice,
    removeDevice,
  } = useConfigStore();
  const sendCommand = useConnectionStore((s) => s.sendCommand);

  /** Fire-and-forget from the button's point of view -- a failure surfaces
   * through connectionStore.lastError -> StatusBar, the same place every
   * other WS command's failure already shows up, so this doesn't need its
   * own error UI. */
  function resetMotorFault(zoneId: number, deviceId: string): void {
    void sendCommand({ command: "RESET_MOTOR_FAULT", zone_id: zoneId, device_id: deviceId });
  }

  /** Forces an instance's reconnect right now instead of waiting on its
   * background watchdog's next pass -- for right after power-cycling real
   * hardware or fixing a cable. Awaits the daemon's Ack (sendCommand only
   * resolves once that arrives, and _dispatch on the daemon side already
   * awaited the connect attempt itself before sending it) then refetches
   * so the caller can read back the real outcome -- this used to be pure
   * fire-and-forget, leaving the button with nothing to show for having
   * been clicked. */
  async function reconnectInstance(zoneId: number, instanceId: string): Promise<boolean> {
    await sendCommand({ command: "RECONNECT_INSTANCE", zone_id: zoneId, instance_id: instanceId });
    await loadZones();
    // useConfigStore.getState(), not the `zones` destructured above -- that
    // reference is from whichever render created this closure, predating
    // the loadZones() call just above it.
    const instance = useConfigStore
      .getState()
      .zones.find((z) => z.zone_id === zoneId)
      ?.driver_instances.find((i) => i.instance_id === instanceId);
    return instance?.connected ?? false;
  }

  /** Applies device state immediately, bypassing the scenario player --
   * "does this valve actually open" / "does this light actually turn that
   * color" on real hardware, without authoring and playing a scenario. */
  function testDevice(zoneId: number, deviceId: string, parameters: Record<string, unknown>): void {
    void sendCommand({ command: "SET_DEVICE_STATE", zone_id: zoneId, device_id: deviceId, parameters });
  }

  useEffect(() => {
    void loadDrivers();
    void loadZones();
  }, [loadDrivers, loadZones]);

  const selectedZone = zones.find((z) => z.zone_id === selectedZoneId) ?? null;

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  // Whether to show cross-zone search results instead of the single
  // selected zone's editor -- an install with dozens of devices across
  // several zones had no way to just find "that one motor" short of
  // clicking through each zone by hand.
  const searching = searchQuery.trim() !== "" || statusFilter !== "all";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-lg">
      {error && <p className="mb-md text-sm text-danger">{error}</p>}
      {loading && zones.length === 0 && <p className="text-sm text-text-muted">Loading…</p>}

      <div className="mb-md flex items-center gap-sm">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search devices by name, across all zones…"
          className="h-input w-72 rounded-control border border-border bg-bg-surface3 px-sm text-sm text-text-primary focus:border-accent focus:outline-none"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          className="h-input rounded-control border border-border bg-bg-surface3 px-sm text-sm text-text-primary focus:border-accent focus:outline-none"
        >
          <option value="all">Any status</option>
          <option value="connected">Connected only</option>
          <option value="disconnected">Disconnected only</option>
        </select>
      </div>

      {searching ? (
        <DeviceSearchResults
          zones={zones}
          query={searchQuery}
          statusFilter={statusFilter}
          onJumpToZone={(zoneId) => {
            selectZone(zoneId);
            setSearchQuery("");
            setStatusFilter("all");
          }}
        />
      ) : selectedZoneId === null ? (
        <p className="text-sm text-text-muted">Select or create a zone in the sidebar to configure its devices.</p>
      ) : (
        <ZoneEditor
          zoneId={selectedZoneId}
          zone={selectedZone}
          drivers={drivers}
          onAddDriverInstance={addDriverInstance}
          onRemoveDriverInstance={removeDriverInstance}
          onAddDevice={addDevice}
          onRemoveDevice={removeDevice}
          onResetFault={resetMotorFault}
          onReconnectInstance={reconnectInstance}
          onTestDevice={testDevice}
          onConnectAll={() => connectZone(selectedZoneId)}
        />
      )}
    </div>
  );
}

/**
 * Cross-zone results, shown instead of ZoneEditor while a search/filter is
 * active. Deliberately read-only + "jump to zone" rather than replaying
 * every InstanceCard action (Test/Reconnect/Remove/...) in a second,
 * flattened context -- those already work fine once you're actually in the
 * right zone, which is the one thing this view exists to get you to
 * quickly across a multi-zone install.
 */
function DeviceSearchResults(props: {
  zones: ZoneConfigDto[];
  query: string;
  statusFilter: StatusFilter;
  onJumpToZone: (zoneId: number) => void;
}): JSX.Element {
  const q = props.query.trim().toLowerCase();

  const results = useMemo(() => {
    const rows: Array<{
      zoneId: number;
      zoneLabel: string;
      device: import("../../lib/protocol").DeviceDto;
      instance: import("../../lib/protocol").DriverInstanceDto;
    }> = [];
    for (const zone of props.zones) {
      const zoneLabel = zone.name?.trim() || `Zone ${zone.zone_id}`;
      const instanceById = new Map(zone.driver_instances.map((i) => [i.instance_id, i]));
      for (const device of zone.devices) {
        const instance = instanceById.get(device.instance_id);
        if (!instance) continue;
        if (q && !device.device_id.toLowerCase().includes(q)) continue;
        if (props.statusFilter === "connected" && !instance.connected) continue;
        if (props.statusFilter === "disconnected" && instance.connected) continue;
        rows.push({ zoneId: zone.zone_id, zoneLabel, device, instance });
      }
    }
    return rows;
  }, [props.zones, q, props.statusFilter]);

  return (
    <div className="flex flex-col gap-xs">
      <p className="text-xs text-text-muted">
        {results.length} device{results.length === 1 ? "" : "s"} found across {props.zones.length} zone{props.zones.length === 1 ? "" : "s"}
      </p>
      {results.length === 0 ? (
        <p className="text-sm text-text-muted">No devices match.</p>
      ) : (
        <ul className="flex flex-col gap-xs">
          {results.map(({ zoneId, zoneLabel, device, instance }) => (
            <li
              key={`${zoneId}:${device.device_id}`}
              className="flex flex-wrap items-center justify-between gap-x-md gap-y-1 rounded-panel border border-border bg-bg-surface1 px-md py-sm text-sm"
            >
              <div className="flex flex-wrap items-center gap-sm">
                <span className={`h-2 w-2 shrink-0 rounded-full ${instance.connected ? "bg-success" : "bg-danger"}`} />
                <span className="font-medium text-text-primary">{device.device_id}</span>
                <span className="text-xs text-text-muted">
                  {CATEGORY_LABEL[device.category]} · {zoneLabel} · {instance.instance_id}
                </span>
              </div>
              <button
                onClick={() => props.onJumpToZone(zoneId)}
                className="text-xs text-accent hover:text-accent-hover"
              >
                Go to zone →
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ZoneEditor(props: {
  zoneId: number;
  zone: import("../../lib/protocol").ZoneConfigDto | null;
  drivers: import("../../lib/protocol").DriverDescriptorDto[];
  onAddDriverInstance: (zoneId: number, instanceId: string, driverType: string, config: Record<string, unknown>) => Promise<void>;
  onRemoveDriverInstance: (zoneId: number, instanceId: string) => Promise<void>;
  onAddDevice: (zoneId: number, deviceId: string, instanceId: string, channel: string, nozzleGroup?: string, nozzleInverter?: 1 | 2) => Promise<void>;
  onRemoveDevice: (zoneId: number, deviceId: string) => Promise<void>;
  onResetFault: (zoneId: number, deviceId: string) => void;
  onReconnectInstance: (zoneId: number, instanceId: string) => Promise<boolean>;
  onTestDevice: (zoneId: number, deviceId: string, parameters: Record<string, unknown>) => void;
  onConnectAll: () => Promise<{ connected: number; total: number }>;
}): JSX.Element {
  const [showAddInstance, setShowAddInstance] = useState(false);
  const [connectingAll, setConnectingAll] = useState(false);
  const [connectAllResult, setConnectAllResult] = useState<string | null>(null);

  const instances = props.zone?.driver_instances ?? [];
  const devices = props.zone?.devices ?? [];

  async function handleConnectAll(): Promise<void> {
    setConnectingAll(true);
    setConnectAllResult(null);
    const { connected, total } = await props.onConnectAll();
    setConnectingAll(false);
    setConnectAllResult(connected === total ? `Connected ${connected}/${total}` : `Only ${connected}/${total} connected`);
    setTimeout(() => setConnectAllResult(null), 5000);
  }

  return (
    <div className="flex flex-col gap-lg">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium text-text-primary">{props.zone?.name?.trim() || `Zone ${props.zoneId}`}</h2>
        <div className="flex items-center gap-sm">
          {connectAllResult && <span className="text-xs text-text-secondary">{connectAllResult}</span>}
          {instances.length > 1 && (
            <button
              onClick={() => void handleConnectAll()}
              disabled={connectingAll}
              title="(Re)connect every driver instance in this zone at once, instead of one at a time"
              className="h-control rounded-control border border-border bg-bg-surface3 px-md text-sm text-text-primary hover:bg-bg-surface2 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {connectingAll ? "Connecting…" : "Connect All"}
            </button>
          )}
          <button
            onClick={() => setShowAddInstance((v) => !v)}
            className="h-control rounded-control bg-primary px-md text-sm text-text-primary hover:bg-primary-hover"
          >
            + Driver instance
          </button>
        </div>
      </div>

      {showAddInstance && (
        <AddDriverInstanceForm
          drivers={props.drivers}
          onSubmit={async (instanceId, driverType, config) => {
            await props.onAddDriverInstance(props.zoneId, instanceId, driverType, config);
            setShowAddInstance(false);
          }}
          onCancel={() => setShowAddInstance(false)}
        />
      )}

      {instances.length === 0 && !showAddInstance && (
        <p className="text-sm text-text-muted">No driver instances yet -- add one to start wiring up devices.</p>
      )}

      {instances.map((instance) => (
        <InstanceCard
          key={instance.instance_id}
          zoneId={props.zoneId}
          instance={instance}
          devices={devices.filter((d) => d.instance_id === instance.instance_id)}
          onRemoveInstance={() => props.onRemoveDriverInstance(props.zoneId, instance.instance_id)}
          onAddDevice={(deviceId, channel, nozzleGroup, nozzleInverter) =>
            props.onAddDevice(props.zoneId, deviceId, instance.instance_id, channel, nozzleGroup, nozzleInverter)
          }
          onRemoveDevice={(deviceId) => props.onRemoveDevice(props.zoneId, deviceId)}
          onResetFault={(deviceId) => props.onResetFault(props.zoneId, deviceId)}
          onReconnect={() => props.onReconnectInstance(props.zoneId, instance.instance_id)}
          onTestDevice={(deviceId, parameters) => props.onTestDevice(props.zoneId, deviceId, parameters)}
        />
      ))}
    </div>
  );
}

function AddDriverInstanceForm(props: {
  drivers: import("../../lib/protocol").DriverDescriptorDto[];
  onSubmit: (instanceId: string, driverType: string, config: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}): JSX.Element {
  const [instanceId, setInstanceId] = useState("");
  const [driverType, setDriverType] = useState(props.drivers[0]?.driver_type ?? "");

  const selectedDriver = useMemo(() => props.drivers.find((d) => d.driver_type === driverType), [props.drivers, driverType]);

  return (
    <div className="rounded-panel border border-border bg-bg-surface2 p-md">
      <div className="mb-sm flex flex-col gap-sm">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-text-secondary">Instance ID</span>
          <input
            type="text"
            value={instanceId}
            onChange={(e) => setInstanceId(e.target.value)}
            placeholder="e.g. relay_bank_a"
            className="h-input rounded-control border border-border bg-bg-surface3 px-sm text-sm text-text-primary focus:border-accent focus:outline-none"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-text-secondary">Driver</span>
          <select
            value={driverType}
            onChange={(e) => setDriverType(e.target.value)}
            className="h-input rounded-control border border-border bg-bg-surface3 px-sm text-sm text-text-primary focus:border-accent focus:outline-none"
          >
            {props.drivers.map((d) => (
              <option key={d.driver_type} value={d.driver_type}>
                {d.display_name} ({CATEGORY_LABEL[d.category]})
              </option>
            ))}
          </select>
        </label>
      </div>

      {selectedDriver && (
        <SchemaForm
          schema={selectedDriver.config_schema}
          submitLabel="Add instance"
          onSubmit={(config) => {
            if (!instanceId.trim()) return;
            void props.onSubmit(instanceId.trim(), driverType, config);
          }}
        />
      )}

      <button onClick={props.onCancel} className="mt-sm text-xs text-text-muted hover:text-text-secondary">
        Cancel
      </button>
    </div>
  );
}

function InstanceCard(props: {
  zoneId: number;
  instance: import("../../lib/protocol").DriverInstanceDto;
  devices: import("../../lib/protocol").DeviceDto[];
  onRemoveInstance: () => void;
  onAddDevice: (deviceId: string, channel: string, nozzleGroup?: string, nozzleInverter?: 1 | 2) => void;
  onRemoveDevice: (deviceId: string) => void;
  onResetFault: (deviceId: string) => void;
  onReconnect: () => Promise<boolean>;
  onTestDevice: (deviceId: string, parameters: Record<string, unknown>) => void;
}): JSX.Element {
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectResult, setReconnectResult] = useState<string | null>(null);

  async function handleReconnect(): Promise<void> {
    setReconnecting(true);
    setReconnectResult(null);
    const connected = await props.onReconnect();
    setReconnecting(false);
    setReconnectResult(connected ? "Connected" : "Failed to connect");
    setTimeout(() => setReconnectResult(null), 5000);
  }

  const [showAddDevice, setShowAddDevice] = useState(false);
  const [showAddNozzle, setShowAddNozzle] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // Hidden by default -- 32 channel chips is real weight to render/scan
  // just to confirm a board exists; showing them is an explicit "I need to
  // check/exclude a channel right now" action, not the default view.
  const [channelsHidden, setChannelsHidden] = useState(true);
  // device_id -> currently test-running at some Hz (for the toggle label).
  const [motorTesting, setMotorTesting] = useState<Set<string>>(new Set());
  const [deviceId, setDeviceId] = useState("");
  const [channel, setChannel] = useState("");
  // Only meaningful for motor devices -- one nozzle = two inverters moving
  // together (component_tables_nozzle.py). Left blank, a motor stays a
  // plain standalone motor and shows in the Motors tab as usual.
  const [nozzleGroup, setNozzleGroup] = useState("");
  const [nozzleInverter, setNozzleInverter] = useState<1 | 2>(1);

  // Editing an EXISTING device's Nozzle grouping -- ADD_DEVICE is
  // idempotent on the daemon (re-adding the same device_id just overwrites
  // its channel/nozzle info, see zone_runtime.py's add_device), so "edit"
  // is really "re-submit with the same id" -- no separate EDIT_DEVICE
  // command needed. Scoped to nozzle fields only (device_id/channel stay
  // fixed): a fountain nozzle sometimes only has one inverter wired up,
  // and until now the only way to fix a wrongly-grouped motor was to
  // remove and re-add it from scratch.
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null);
  const [editNozzleGroup, setEditNozzleGroup] = useState("");
  const [editNozzleInverter, setEditNozzleInverter] = useState<1 | 2>(1);

  function startEditingNozzle(d: import("../../lib/protocol").DeviceDto): void {
    setEditingDeviceId(d.device_id);
    setEditNozzleGroup(d.nozzle_group ?? "");
    setEditNozzleInverter((d.nozzle_inverter as 1 | 2 | undefined) ?? 1);
  }

  // A driver that declares total_channels (currently just the relay board)
  // auto-provisions every one of its channels the moment the instance is
  // added -- see zone_runtime.py's add_driver_instance. That's ONE physical
  // device with N fixed outputs, not N devices, so it gets the compact
  // channel grid below instead of a full-width row (with its own Remove
  // button) per channel and instead of the manual "add one device" form,
  // which doesn't apply here -- there's no channel 33 to type in.
  const totalChannels = Number(props.instance.config.total_channels ?? 0);
  const isFixedBank = totalChannels > 0;

  // For a VFD gateway, "channel" IS the inverter's Modbus slave/unit ID
  // (modbus_motor_driver.py); for the Art-Net node it's the universe number
  // (artnet_light_driver.py) -- calling either one "Channel" in the UI hides
  // what the value actually means and, for the motor, that it must be
  // unique on the shared bus.
  const isMotor = props.instance.category === "motor";
  const isLight = props.instance.category === "light";
  const channelLabel = isMotor ? "Slave ID" : isLight ? "Universe" : "Channel";
  const channelWord = isMotor ? "slave ID" : isLight ? "universe" : "channel";

  // The only light driver registered today (artnet_rgb_light) is the Node8
  // (CR061SA): a fixed 8-output Art-Net node addressed as universes 0-7 --
  // see register_channel in artnet_light_driver.py, the daemon-side source
  // of truth for this range. Checked here too so a bad value is rejected
  // instantly instead of round-tripping to the daemon first.
  const NODE8_MAX_UNIVERSE = 7;

  const [addDeviceError, setAddDeviceError] = useState<string | null>(null);

  function channelInUse(value: string, excludeDeviceId?: string): boolean {
    return props.devices.some((d) => d.channel === value && d.device_id !== excludeDeviceId);
  }

  function validateChannel(value: string): string | null {
    if (channelInUse(value)) return `${channelLabel} ${value} is already used by another device on this instance.`;
    if (isLight) {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > NODE8_MAX_UNIVERSE) {
        return `Universe must be a whole number from 0 to ${NODE8_MAX_UNIVERSE} on a Node8.`;
      }
    }
    return null;
  }

  /** The next free channel value -- so opening the form starts from a
   * usable suggestion (which the field stays free to overwrite) instead of
   * making you scan the existing rows above to work out what's unused.
   * Universes start at 0 (the Node8's own numbering); slave IDs start at 1
   * (0 is the Modbus broadcast address, not a real unit). */
  function suggestNextChannel(): string {
    const used = new Set(props.devices.map((d) => d.channel));
    const start = isLight ? 0 : 1;
    const end = isLight ? NODE8_MAX_UNIVERSE : start + 999;
    for (let n = start; n <= end; n++) {
      if (!used.has(String(n))) return String(n);
    }
    return String(start);
  }

  function openAddDevice(): void {
    const suggested = suggestNextChannel();
    setChannel(suggested);
    setDeviceId(`${props.instance.instance_id}-${suggested}`);
    setAddDeviceError(null);
    setShowAddDevice(true);
  }

  function toggleMotorTest(deviceId: string): void {
    const nowTesting = !motorTesting.has(deviceId);
    setMotorTesting((prev) => {
      const next = new Set(prev);
      if (nowTesting) next.add(deviceId);
      else next.delete(deviceId);
      return next;
    });
    props.onTestDevice(deviceId, nowTesting ? { active: true, frequency: 10 } : { active: false, frequency: 0 });
  }

  return (
    <div className="rounded-panel border border-border bg-bg-surface1">
      <div className="flex flex-wrap items-center justify-between gap-x-md gap-y-1 border-b border-border px-md py-sm">
        <div className="flex flex-wrap items-center gap-sm">
          <span
            // Art-Net is UDP -- amber, not green/red, because "connected"
            // here can only ever mean "opened a local socket and is
            // sending", never "the Node8 actually answered". The label
            // next to it says so out loud too, not just on hover -- a
            // hover-only tooltip turned out invisible enough that this got
            // asked about twice.
            className={`h-2 w-2 rounded-full ${
              props.instance.driver_type === "artnet_rgb_light"
                ? props.instance.connected
                  ? "bg-warning"
                  : "bg-danger"
                : props.instance.connected
                  ? "bg-success"
                  : "bg-danger"
            }`}
          />
          <span className="text-sm font-medium text-text-primary">{props.instance.instance_id}</span>
          {props.instance.driver_type === "artnet_rgb_light" && (
            <span
              className="text-xs text-warning"
              title="Art-Net (UDP) has no delivery confirmation in the protocol -- this can only ever mean the daemon is sending packets, not that the fixture actually received them"
            >
              {props.instance.connected ? "sending, unconfirmed" : "not sending"}
            </span>
          )}
          <span className="text-xs text-text-muted">
            {props.instance.driver_type} · {CATEGORY_LABEL[props.instance.category]}
            {props.instance.config.slave_id != null && <> · Slave ID {String(props.instance.config.slave_id)}</>}
          </span>
        </div>
        <div className="flex items-center gap-md">
          {reconnectResult && <span className="text-xs text-text-secondary">{reconnectResult}</span>}
          <button
            onClick={() => void handleReconnect()}
            disabled={reconnecting}
            title="Force an immediate reconnect attempt instead of waiting for the background watchdog's next pass"
            className="text-xs text-accent hover:text-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {reconnecting ? "Connecting…" : "Reconnect"}
          </button>
          <button onClick={props.onRemoveInstance} className="text-xs text-danger hover:text-danger-hover">
            Remove
          </button>
        </div>
      </div>

      <div className="p-md">
        {isFixedBank ? (
          <div className="flex flex-col gap-xs">
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-muted">Channels 1–{totalChannels}</span>
              <button
                onClick={() => setChannelsHidden((v) => !v)}
                className="text-xs text-text-secondary hover:text-text-primary"
              >
                {channelsHidden ? "Show channels" : "Hide"}
              </button>
            </div>
            {!channelsHidden && (
              <>
                <span className="text-xs text-text-muted">
                  Click a channel to include it in scenarios (e.g. exclude a dead relay) or bring it back. This
                  never touches the real relay -- use "Test a channel" below for that.
                </span>
                <ChannelGrid
                  items={Array.from({ length: totalChannels }, (_, i) => {
                    const channel = String(i + 1);
                    const device = props.devices.find((d) => d.channel === channel);
                    return {
                      channel,
                      active: Boolean(device),
                      title: device ? device.device_id : `channel ${channel} — excluded from scenarios`,
                    };
                  })}
                  onToggle={(channel) => {
                    const device = props.devices.find((d) => d.channel === channel);
                    if (device) props.onRemoveDevice(device.device_id);
                    else props.onAddDevice(`${props.instance.instance_id}-${channel}`, channel);
                  }}
                />
                {props.devices.length > 0 && <ValveTestControl devices={props.devices} onTestDevice={props.onTestDevice} />}
              </>
            )}
          </div>
        ) : (
          <>
            {props.devices.length === 0 && <p className="text-sm text-text-muted">No devices on this instance yet.</p>}

            {props.devices.length > 6 && (
              <button
                onClick={() => setExpanded((v) => !v)}
                className="mb-xs flex items-center gap-xs text-sm text-text-secondary hover:text-text-primary"
              >
                <span className="text-text-muted">{expanded ? "▾" : "▸"}</span>
                {props.devices.length} devices
              </button>
            )}

            {(props.devices.length <= 6 || expanded) && (
              <ul className="flex flex-col gap-xs">
                {props.devices.map((d) =>
                  editingDeviceId === d.device_id ? (
                    <li key={d.device_id} className="flex items-end gap-xs rounded-control border border-border bg-bg-surface2 p-xs">
                      <span className="pb-1 text-xs text-text-muted">
                        {d.device_id} — {channelWord} {d.channel}
                      </span>
                      <label className="flex flex-col gap-1 text-xs">
                        <span className="text-text-muted">Nozzle ID (blank = plain motor)</span>
                        <input
                          value={editNozzleGroup}
                          onChange={(e) => setEditNozzleGroup(e.target.value)}
                          placeholder="e.g. N1"
                          className="h-input w-24 rounded-control border border-border bg-bg-surface3 px-sm text-sm text-text-primary focus:border-accent focus:outline-none"
                        />
                      </label>
                      {editNozzleGroup.trim() && (
                        <label className="flex flex-col gap-1 text-xs">
                          <span className="text-text-muted">Inverter</span>
                          <select
                            value={editNozzleInverter}
                            onChange={(e) => setEditNozzleInverter(Number(e.target.value) as 1 | 2)}
                            className="h-input rounded-control border border-border bg-bg-surface3 px-sm text-sm text-text-primary focus:border-accent focus:outline-none"
                          >
                            <option value={1}>1</option>
                            <option value={2}>2</option>
                          </select>
                        </label>
                      )}
                      <button
                        onClick={() => {
                          const group = editNozzleGroup.trim();
                          props.onAddDevice(d.device_id, d.channel, group || undefined, group ? editNozzleInverter : undefined);
                          setEditingDeviceId(null);
                        }}
                        className="h-input rounded-control bg-primary px-sm text-sm text-text-primary hover:bg-primary-hover"
                      >
                        Save
                      </button>
                      <button onClick={() => setEditingDeviceId(null)} className="h-input text-xs text-text-muted hover:text-text-secondary">
                        Cancel
                      </button>
                    </li>
                  ) : (
                    <li key={d.device_id} className="flex flex-wrap items-center justify-between gap-x-md gap-y-1 text-sm">
                      <span className="text-text-secondary">
                        {d.device_id} <span className="text-text-muted">— {channelWord} {d.channel}</span>
                        {d.nozzle_group != null && (
                          <span className="text-text-muted"> · Nozzle {d.nozzle_group} Inv{d.nozzle_inverter}</span>
                        )}
                        {props.instance.category === "motor" && <MotorLiveState zoneId={props.zoneId} instanceId={props.instance.instance_id} channel={d.channel} />}
                      </span>
                      <span className="flex flex-wrap items-center gap-sm">
                        {props.instance.category === "motor" && (
                          <>
                            <button
                              onClick={() => startEditingNozzle(d)}
                              title="Change or remove this device's Nozzle grouping"
                              className="text-xs text-accent hover:text-accent-hover"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => toggleMotorTest(d.device_id)}
                              title="Run this motor at 10Hz right now, bypassing any scenario, to verify it actually spins"
                              className={`text-xs ${motorTesting.has(d.device_id) ? "font-medium text-warning" : "text-accent hover:text-accent-hover"}`}
                            >
                              {motorTesting.has(d.device_id) ? "Stop Test" : "Test 10Hz"}
                            </button>
                            <button
                              onClick={() => props.onResetFault(d.device_id)}
                              title="Clear a tripped VFD fault (overcurrent, etc.) so it accepts run commands again"
                              className="text-xs text-warning hover:text-warning-hover"
                            >
                              Reset Fault
                            </button>
                          </>
                        )}
                        {props.instance.category === "light" && <LightTestControl onTest={(params) => props.onTestDevice(d.device_id, params)} />}
                        <button onClick={() => props.onRemoveDevice(d.device_id)} className="text-xs text-danger hover:text-danger-hover">
                          Remove
                        </button>
                      </span>
                    </li>
                  ),
                )}
              </ul>
            )}
          </>
        )}

        {!isFixedBank && (
          <div className="mt-sm flex flex-col gap-sm">
            {showAddDevice && (
              <div className="flex flex-col gap-xs">
                <div className="flex items-end gap-xs">
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-text-muted">Device ID</span>
                    <input
                      value={deviceId}
                      onChange={(e) => setDeviceId(e.target.value)}
                      className="h-input rounded-control border border-border bg-bg-surface3 px-sm text-sm text-text-primary focus:border-accent focus:outline-none"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-text-muted">{channelLabel}</span>
                    <input
                      value={channel}
                      onChange={(e) => setChannel(e.target.value)}
                      className="h-input w-20 rounded-control border border-border bg-bg-surface3 px-sm text-sm text-text-primary focus:border-accent focus:outline-none"
                    />
                  </label>
                  {isMotor && (
                    <>
                      <label className="flex flex-col gap-1 text-xs">
                        <span className="text-text-muted">Nozzle ID (optional)</span>
                        <input
                          value={nozzleGroup}
                          onChange={(e) => setNozzleGroup(e.target.value)}
                          placeholder="e.g. N1"
                          className="h-input w-24 rounded-control border border-border bg-bg-surface3 px-sm text-sm text-text-primary focus:border-accent focus:outline-none"
                        />
                      </label>
                      {nozzleGroup.trim() && (
                        <label className="flex flex-col gap-1 text-xs">
                          <span className="text-text-muted">Inverter</span>
                          <select
                            value={nozzleInverter}
                            onChange={(e) => setNozzleInverter(Number(e.target.value) as 1 | 2)}
                            className="h-input rounded-control border border-border bg-bg-surface3 px-sm text-sm text-text-primary focus:border-accent focus:outline-none"
                          >
                            <option value={1}>1</option>
                            <option value={2}>2</option>
                          </select>
                        </label>
                      )}
                    </>
                  )}
                  <button
                    onClick={() => {
                      if (!deviceId.trim() || !channel.trim()) return;
                      const validationError = validateChannel(channel.trim());
                      if (validationError) {
                        setAddDeviceError(validationError);
                        return;
                      }
                      setAddDeviceError(null);
                      const group = nozzleGroup.trim();
                      props.onAddDevice(deviceId.trim(), channel.trim(), group || undefined, group ? nozzleInverter : undefined);
                      setDeviceId("");
                      setChannel("");
                      setNozzleGroup("");
                      setNozzleInverter(1);
                      setShowAddDevice(false);
                    }}
                    className="h-input rounded-control bg-primary px-sm text-sm text-text-primary hover:bg-primary-hover"
                  >
                    Add
                  </button>
                  <button
                    onClick={() => {
                      setShowAddDevice(false);
                      setAddDeviceError(null);
                    }}
                    className="h-input text-xs text-text-muted hover:text-text-secondary"
                  >
                    Cancel
                  </button>
                </div>
                {addDeviceError && <span className="text-xs text-danger">{addDeviceError}</span>}
              </div>
            )}

            {isMotor && showAddNozzle && (
              <AddNozzleForm devices={props.devices} onAddDevice={props.onAddDevice} onCancel={() => setShowAddNozzle(false)} />
            )}

            <div className="flex gap-md">
              {!showAddDevice && (
                <button onClick={openAddDevice} className="text-xs text-accent hover:text-accent-hover">
                  + Add device
                </button>
              )}
              {isMotor && !showAddNozzle && (
                <button
                  onClick={() => setShowAddNozzle(true)}
                  title="Add both inverters of one nozzle together, sharing a single Nozzle ID"
                  className="text-xs text-accent hover:text-accent-hover"
                >
                  + Add nozzle
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Firing a real relay used to share its click target with "include this
 * channel in scenarios" -- a whole-instance "Test mode" toggle changed
 * what clicking a channel chip DID, and forgetting it was still on meant
 * a click meant to configure channels instead fired the real relay. This
 * is a fully separate, explicit action instead: pick a channel, press
 * Test -- same one-button-per-action shape as a motor's "Test 10Hz" or a
 * light's "Test color", and the channel grid above always means the same
 * thing regardless of what's going on down here.
 */
function ValveTestControl(props: {
  devices: import("../../lib/protocol").DeviceDto[];
  onTestDevice: (deviceId: string, parameters: Record<string, unknown>) => void;
}): JSX.Element {
  const sorted = useMemo(() => [...props.devices].sort((a, b) => Number(a.channel) - Number(b.channel)), [props.devices]);
  const [selectedDeviceId, setSelectedDeviceId] = useState(sorted[0]?.device_id ?? "");
  const [testingDeviceId, setTestingDeviceId] = useState<string | null>(null);
  const testingDeviceIdRef = useRef<string | null>(null);
  testingDeviceIdRef.current = testingDeviceId;

  // A test left running must not survive navigating away from this card
  // (switching zones, removing the instance) -- same reasoning as the old
  // exitValveTestMode, just scoped to the one channel this control can
  // ever have open instead of a whole Set of them.
  useEffect(() => {
    return () => {
      if (testingDeviceIdRef.current) props.onTestDevice(testingDeviceIdRef.current, { on: false });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount-only, reads the ref for the latest value
  }, []);

  function toggle(): void {
    if (!selectedDeviceId) return;
    if (testingDeviceId === selectedDeviceId) {
      props.onTestDevice(selectedDeviceId, { on: false });
      setTestingDeviceId(null);
    } else {
      if (testingDeviceId) props.onTestDevice(testingDeviceId, { on: false }); // switching channels -- close the previous one first
      props.onTestDevice(selectedDeviceId, { on: true });
      setTestingDeviceId(selectedDeviceId);
    }
  }

  return (
    <div className="flex items-center gap-xs border-t border-border pt-xs">
      <span className="text-xs text-text-muted">Test a channel:</span>
      <select
        value={selectedDeviceId}
        onChange={(e) => {
          if (testingDeviceId) props.onTestDevice(testingDeviceId, { on: false }); // switching selection closes whatever was open
          setTestingDeviceId(null);
          setSelectedDeviceId(e.target.value);
        }}
        className="h-input rounded-control border border-border bg-bg-surface3 px-sm text-xs text-text-primary focus:border-accent focus:outline-none"
      >
        {sorted.map((d) => (
          <option key={d.device_id} value={d.device_id}>
            Channel {d.channel} — {d.device_id}
          </option>
        ))}
      </select>
      <button
        onClick={toggle}
        title="Opens/closes the real relay for this one channel right now, bypassing any scenario"
        className={`text-xs ${testingDeviceId === selectedDeviceId ? "font-medium text-warning" : "text-accent hover:text-accent-hover"}`}
      >
        {testingDeviceId === selectedDeviceId ? "Close" : "Open"}
      </button>
    </div>
  );
}

/** Live frequency/running state for one motor device, from the daemon's
 * device_event stream -- previously nothing on this tab showed whether a
 * given inverter was actually running or what frequency it was doing,
 * only the whole gateway's connected/disconnected dot next to the
 * instance header. Renders nothing until the first event for this exact
 * (instance_id, channel) arrives -- right after connect, or the next time
 * a scenario/test actually changes it. */
function MotorLiveState({ zoneId, instanceId, channel }: { zoneId: number; instanceId: string; channel: string }): JSX.Element | null {
  const live = useZonesStore((s) => s.devices.get(deviceStateKey(zoneId, instanceId, channel)));
  if (!live) return null;

  const frequency = typeof live.state.frequency === "number" ? live.state.frequency : null;
  const running =
    typeof live.state.is_running === "boolean" ? live.state.is_running
    : typeof live.state.active === "boolean" ? live.state.active
    : null;

  return (
    <span className={running ? "text-success" : "text-text-muted"}>
      {" · "}
      {running === true ? "running" : running === false ? "stopped" : "—"}
      {frequency !== null && ` ${frequency.toFixed(1)}Hz`}
    </span>
  );
}

/** A color swatch that opens the native color picker and applies whatever's
 * picked to the real light immediately -- "does this light actually turn
 * that color" verification, same native-picker pattern as the Timeline
 * grid's own color cells. Plus a one-click Off, since a light left on from
 * testing isn't as risky as a valve or motor but still shouldn't require
 * hunting through devices to find and re-close. */
function LightTestControl({ onTest }: { onTest: (parameters: Record<string, unknown>) => void }): JSX.Element {
  const colorInputRef = useRef<HTMLInputElement>(null);

  function handleColorChange(hex: string): void {
    const n = parseInt(hex.slice(1), 16);
    onTest({ r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 });
  }

  return (
    <span className="flex items-center gap-xs">
      <input ref={colorInputRef} type="color" className="absolute h-0 w-0 opacity-0" onChange={(e) => handleColorChange(e.target.value)} />
      <button
        onClick={() => colorInputRef.current?.click()}
        title="Set this light to a test color right now, bypassing any scenario"
        className="text-xs text-accent hover:text-accent-hover"
      >
        Test color
      </button>
      <button
        onClick={() => onTest({ r: 0, g: 0, b: 0 })}
        title="Turn this light off"
        className="text-xs text-text-muted hover:text-text-secondary"
      >
        Off
      </button>
    </span>
  );
}

/**
 * One nozzle = two inverters that must share a single Nozzle ID -- typing
 * that ID (and a name) twice, once per device, is exactly how "Mollanepes
 * Gul" / "Molannepes Gul 2" happened: a typo in the second half silently
 * created two unrelated half-nozzles instead of one pair. This form takes
 * the name and Nozzle ID once and derives both device IDs from it, so the
 * two halves can't drift apart.
 */
function AddNozzleForm(props: {
  devices: import("../../lib/protocol").DeviceDto[];
  onAddDevice: (deviceId: string, channel: string, nozzleGroup?: string, nozzleInverter?: 1 | 2) => void;
  onCancel: () => void;
}): JSX.Element {
  // Pre-fill Nozzle ID and both Slave IDs with the next free values -- same
  // reasoning as InstanceCard's suggestNextChannel, computed once from
  // whatever's already on this instance when the form opens (not
  // re-derived on every keystroke, so picking a used ID as your OWN typed
  // value doesn't get silently overwritten).
  const [freeSlave1, freeSlave2] = useMemo(() => {
    const used = new Set(props.devices.map((d) => d.channel));
    const free: string[] = [];
    for (let n = 1; free.length < 2; n++) {
      const s = String(n);
      if (!used.has(s)) free.push(s);
    }
    return free;
  }, [props.devices]);

  const [name, setName] = useState("");
  const [nozzleId, setNozzleId] = useState(() => {
    const usedGroups = new Set(props.devices.map((d) => d.nozzle_group).filter((g): g is string => g != null));
    for (let n = 1; ; n++) if (!usedGroups.has(String(n))) return String(n);
  });
  const [slave1, setSlave1] = useState(freeSlave1);
  const [slave2, setSlave2] = useState(freeSlave2);
  const [error, setError] = useState<string | null>(null);

  function submit(): void {
    const n = name.trim();
    const nid = nozzleId.trim();
    const s1 = slave1.trim();
    const s2 = slave2.trim();
    if (!n || !nid || !s1 || !s2) {
      setError("Fill in name, Nozzle ID and both Slave IDs.");
      return;
    }
    if (s1 === s2) {
      setError("The two inverters need different Slave IDs.");
      return;
    }
    const taken = props.devices.find((d) => d.channel === s1 || d.channel === s2);
    if (taken) {
      setError(`Slave ID ${taken.channel} is already used by ${taken.device_id} on this instance.`);
      return;
    }
    const id1 = `${n} Inv1`;
    const id2 = `${n} Inv2`;
    const idClash = props.devices.find((d) => d.device_id === id1 || d.device_id === id2);
    if (idClash) {
      setError(`A device named "${idClash.device_id}" already exists -- pick a different name.`);
      return;
    }

    props.onAddDevice(id1, s1, nid, 1);
    props.onAddDevice(id2, s2, nid, 2);
    setName("");
    setNozzleId("");
    setSlave1("");
    setSlave2("");
    setError(null);
    props.onCancel();
  }

  return (
    <div className="flex flex-col gap-xs rounded-control border border-border bg-bg-surface2 p-sm">
      <div className="flex flex-wrap items-end gap-xs">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-text-muted">Nozzle name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Gul"
            className="h-input rounded-control border border-border bg-bg-surface3 px-sm text-sm text-text-primary focus:border-accent focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-text-muted">Nozzle ID</span>
          <input
            value={nozzleId}
            onChange={(e) => setNozzleId(e.target.value)}
            placeholder="e.g. N1"
            className="h-input w-20 rounded-control border border-border bg-bg-surface3 px-sm text-sm text-text-primary focus:border-accent focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-text-muted">Inverter 1 Slave ID</span>
          <input
            value={slave1}
            onChange={(e) => setSlave1(e.target.value)}
            className="h-input w-24 rounded-control border border-border bg-bg-surface3 px-sm text-sm text-text-primary focus:border-accent focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-text-muted">Inverter 2 Slave ID</span>
          <input
            value={slave2}
            onChange={(e) => setSlave2(e.target.value)}
            className="h-input w-24 rounded-control border border-border bg-bg-surface3 px-sm text-sm text-text-primary focus:border-accent focus:outline-none"
          />
        </label>
        <button onClick={submit} className="h-input rounded-control bg-primary px-sm text-sm text-text-primary hover:bg-primary-hover">
          Add nozzle
        </button>
        <button onClick={props.onCancel} className="h-input text-xs text-text-muted hover:text-text-secondary">
          Cancel
        </button>
      </div>
      <span className="text-xs text-text-muted">
        Creates "{name.trim() || "Name"} Inv1" and "{name.trim() || "Name"} Inv2" together, sharing one Nozzle ID.
      </span>
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
}
