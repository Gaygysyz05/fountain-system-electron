import type { DeviceDto, DriverInstanceDto } from "../../lib/protocol";

/**
 * One editable column in a DeviceTable (columns = devices/channels, rows =
 * time -- back to component_tables.py's own layout after a brief detour
 * transposing it; a long scenario duration turned out to make time-as-
 * columns just as wide as device-as-columns did with many channels, so
 * there was no real win, and this way matches the reference app exactly).
 * component_tables.py had a separate QTableWidget subclass per device
 * category (FountainValveTableWidget / FountainMotorTableWidget /
 * FountainLightTableWidget) with hand-written layout, click handling, and
 * clipboard code duplicated three times. Here the layout is data
 * (`buildXColumns`) and DeviceTable.tsx's selection, inline-edit,
 * context-menu, and copy/paste logic is written once against `kind`, not
 * against the category -- valves get 1 toggle column each, motors get 2
 * (Hz number + State toggle), lights get 1 color column each, matching the
 * daemon's actual driver parameters (see artnet_light_driver.py -- r/g/b
 * only, no brightness/effect, unlike the original's DMX rig).
 */
export type ColumnKind = "toggle" | "number" | "color";

export interface DeviceColumn {
  key: string;
  deviceId: string;
  field: string; // parameter key this column edits ("on", "active", "frequency"); unused for "color" (writes r/g/b directly)
  label: string; // column header -- just the channel number, kept short (see buildXColumns below); full device_id is the header's title/tooltip
  title: string; // full device_id, for a hover tooltip -- see label
  kind: ColumnKind;
  onLabel?: string; // toggle-only: context menu wording, e.g. "Open (1)"
  offLabel?: string;
  onColor?: "danger" | "success"; // toggle-only: cell color when on -- red for an energized relay/valve (the physical indicator convention), green for a running motor
  min?: number;
  max?: number;
  step?: number;
}

// Column headers are a one-letter category prefix + channel number --
// "V16", "M16" -- matching component_tables.py's "V1", "V2"... exactly,
// short enough not to repeat the instance name on every one of 32+ headers
// (an auto-provisioned board's device_id is "{instance_id}-{channel}"),
// and critically NOT bare numbers: those read identically to the time
// column on the left, indistinguishable at a glance. Which physical board
// a channel belongs to is already the sub-tab you're on
// (DeviceCategoryTabs.tsx) and the connection-summary line above the
// table; the full device_id is still one hover away via the header's
// title attribute for a hand-named device where the id carries real meaning.

export function buildValveColumns(devices: DeviceDto[]): DeviceColumn[] {
  return devices.map((d) => ({
    key: d.device_id,
    deviceId: d.device_id,
    field: "on",
    label: `V${d.channel}`,
    title: d.device_id,
    kind: "toggle",
    onLabel: "Open (1)",
    offLabel: "Closed (0)",
    onColor: "success",
  }));
}

export function buildMotorColumns(devices: DeviceDto[]): DeviceColumn[] {
  const cols: DeviceColumn[] = [];
  for (const d of devices) {
    cols.push({ key: `${d.device_id}:freq`, deviceId: d.device_id, field: "frequency", label: `M${d.channel} Hz`, title: d.device_id, kind: "number", min: 0, max: 50, step: 0.1 });
    cols.push({ key: `${d.device_id}:active`, deviceId: d.device_id, field: "active", label: `M${d.channel} St`, title: d.device_id, kind: "toggle", onLabel: "ON", offLabel: "OFF", onColor: "success" });
  }
  return cols;
}

export function buildLightColumns(devices: DeviceDto[]): DeviceColumn[] {
  return devices.map((d) => ({ key: d.device_id, deviceId: d.device_id, field: "color", label: `L${d.channel}`, title: d.device_id, kind: "color" }));
}

/** One fountain nozzle = two VFD inverters that move together
 * (component_tables_nozzle.py's Inv1/Inv2 model) -- each inverter is
 * still, hardware-wise, just a motor device (same driver, same
 * frequency/active parameters); the pairing is purely an authoring-time
 * grouping label set on the Devices tab (nozzle_group/nozzle_inverter). */
export interface NozzlePair {
  nozzleGroup: string;
  inv1: DeviceDto | null;
  inv2: DeviceDto | null;
}

/** Groups motor-category devices that have a nozzle_group set into pairs,
 * one per distinct nozzle_group, ordered by first appearance. A group
 * missing one inverter (only Inv1 or only Inv2 configured so far) still
 * produces a pair with the other side null -- buildNozzleColumns renders
 * that side as absent rather than crashing on an incomplete pairing. */
export function groupNozzlePairs(devices: DeviceDto[]): NozzlePair[] {
  const order: string[] = [];
  const byGroup = new Map<string, NozzlePair>();
  for (const d of devices) {
    if (!d.nozzle_group) continue;
    if (!byGroup.has(d.nozzle_group)) {
      byGroup.set(d.nozzle_group, { nozzleGroup: d.nozzle_group, inv1: null, inv2: null });
      order.push(d.nozzle_group);
    }
    const pair = byGroup.get(d.nozzle_group)!;
    if (d.nozzle_inverter === 1) pair.inv1 = d;
    else if (d.nozzle_inverter === 2) pair.inv2 = d;
  }
  return order.map((g) => byGroup.get(g)!);
}

/** 4 columns per nozzle -- Inv1 Hz, Inv1 State, Inv2 Hz, Inv2 State -- same
 * field shape as buildMotorColumns per inverter, just grouped and labeled
 * by nozzle instead of by channel (matches
 * FountainNozzleTableWidget.populate_table's 4-columns-per-nozzle layout
 * exactly). A pair missing one inverter (see groupNozzlePairs) simply
 * omits that inverter's two columns rather than rendering an unusable
 * column with no backing device. */
export function buildNozzleColumns(pairs: NozzlePair[]): DeviceColumn[] {
  const cols: DeviceColumn[] = [];
  for (const { nozzleGroup, inv1, inv2 } of pairs) {
    if (inv1) {
      cols.push({ key: `${inv1.device_id}:freq`, deviceId: inv1.device_id, field: "frequency", label: `${nozzleGroup} Inv1 Hz`, title: inv1.device_id, kind: "number", min: 0, max: 50, step: 0.1 });
      cols.push({ key: `${inv1.device_id}:active`, deviceId: inv1.device_id, field: "active", label: `${nozzleGroup} Inv1 St`, title: inv1.device_id, kind: "toggle", onLabel: "ON", offLabel: "OFF", onColor: "success" });
    }
    if (inv2) {
      cols.push({ key: `${inv2.device_id}:freq`, deviceId: inv2.device_id, field: "frequency", label: `${nozzleGroup} Inv2 Hz`, title: inv2.device_id, kind: "number", min: 0, max: 50, step: 0.1 });
      cols.push({ key: `${inv2.device_id}:active`, deviceId: inv2.device_id, field: "active", label: `${nozzleGroup} Inv2 St`, title: inv2.device_id, kind: "toggle", onLabel: "ON", offLabel: "OFF", onColor: "success" });
    }
  }
  return cols;
}

export function isOn(params: Record<string, unknown> | undefined, col: DeviceColumn): boolean {
  return Boolean(params?.[col.field]);
}

export function getNumber(params: Record<string, unknown> | undefined, col: DeviceColumn): number {
  return Number(params?.[col.field] ?? 0);
}

export function getColorHex(params: Record<string, unknown> | undefined): string {
  const c = (n: unknown) => Math.max(0, Math.min(255, Math.round(Number(n ?? 0)))).toString(16).padStart(2, "0");
  return `#${c(params?.r)}${c(params?.g)}${c(params?.b)}`;
}

/** A color cell's hex label is printed on top of its own color as the
 * background -- fine for a mid/dark output color, but a hardcoded white
 * label goes invisible on a light one (white, yellow, ...), which is a
 * perfectly normal thing to set on a light channel. Standard perceived-
 * brightness weighting (green reads brighter to the eye than red or blue at
 * the same numeric value) picks readable text either way. */
export function getContrastTextClass(hex: string): "text-white" | "text-black" {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  return brightness > 140 ? "text-black" : "text-white";
}

/** Clipboard cell text -- tab/newline table format, same convention
 * component_tables.py used (AppConstants.VALVE_OPEN/CLOSED = "1"/"0"). */
export function toClipboardToken(params: Record<string, unknown> | undefined, col: DeviceColumn): string {
  switch (col.kind) {
    case "toggle":
      return isOn(params, col) ? "1" : "0";
    case "number":
      return String(getNumber(params, col));
    case "color":
      return getColorHex(params);
  }
}

/** Parses one pasted cell's text into a parameter patch for `col`, or null
 * if the text doesn't fit this column's kind (silently skipped, matching
 * the original's try/except ValueError: pass in _paste_cell_value). */
export function parseClipboardToken(text: string, col: DeviceColumn): Record<string, unknown> | null {
  const trimmed = text.trim();
  switch (col.kind) {
    case "toggle": {
      const on = trimmed === "1" || trimmed.toUpperCase() === "ON" || trimmed.toUpperCase() === "TRUE";
      return { [col.field]: on };
    }
    case "number": {
      const n = parseFloat(trimmed);
      if (Number.isNaN(n)) return null;
      const clamped = Math.max(col.min ?? -Infinity, Math.min(col.max ?? Infinity, n));
      return { [col.field]: clamped };
    }
    case "color": {
      if (!/^#[0-9a-fA-F]{6}$/.test(trimmed)) return null;
      return { r: parseInt(trimmed.slice(1, 3), 16), g: parseInt(trimmed.slice(3, 5), 16), b: parseInt(trimmed.slice(5, 7), 16) };
    }
  }
}

/** Groups `devices` by which driver instance (physical board) they belong
 * to, in the order `instances` lists them -- used to split a category into
 * per-board sub-tabs so two relay boards' channel 1s don't sit side by
 * side indistinguishably (DeviceCategoryTabs.tsx). Any device whose
 * instance_id isn't in `instances` falls into an "unassigned" group at the
 * end (shouldn't happen in practice -- REMOVE_DRIVER_INSTANCE cascades to
 * remove its devices server-side, see zone_runtime.py's
 * remove_driver_instance -- but stay defensive rather than dropping them). */
export function groupDevicesByInstance(
  devices: DeviceDto[],
  instances: DriverInstanceDto[],
): Array<{ instance: DriverInstanceDto | null; devices: DeviceDto[] }> {
  const byInstance = new Map<string, DeviceDto[]>();
  for (const d of devices) {
    const list = byInstance.get(d.instance_id) ?? [];
    list.push(d);
    byInstance.set(d.instance_id, list);
  }

  const groups: Array<{ instance: DriverInstanceDto | null; devices: DeviceDto[] }> = [];
  for (const instance of instances) {
    const list = byInstance.get(instance.instance_id);
    if (list && list.length > 0) {
      groups.push({ instance, devices: list });
      byInstance.delete(instance.instance_id);
    }
  }
  for (const [, list] of byInstance) {
    groups.push({ instance: null, devices: list });
  }
  return groups;
}
