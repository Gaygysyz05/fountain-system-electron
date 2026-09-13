import type { DeviceDto, DriverInstanceDto } from "../../lib/protocol";

/** Columns are data (`buildXColumns`) so DeviceTable.tsx's selection/edit/copy logic is written once per `kind` instead of duplicated per device category as in the original's QTableWidget subclasses; per-kind column counts (valve 1, motor 2, light 1) match the daemon's actual driver params -- no brightness/effect on lights, unlike the original's DMX rig. */
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

// Headers are letter-prefix + channel ("V16") rather than a bare number so they can't be mistaken at a glance for the time column on the left.

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

/** Each inverter is hardware-wise just a motor device; the Inv1/Inv2 pairing is purely an authoring-time label set on the Devices tab (nozzle_group/nozzle_inverter). */
export interface NozzlePair {
  nozzleGroup: string;
  inv1: DeviceDto | null;
  inv2: DeviceDto | null;
}

/** A group missing one inverter still produces a pair with the other side null, so buildNozzleColumns can render it absent instead of crashing on an incomplete pairing. */
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

/** A pair missing one inverter (see groupNozzlePairs) simply omits that inverter's two columns rather than rendering an unusable column with no backing device. */
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

/** Uses perceived-brightness weighting (not a plain average) so a hardcoded white label stays readable on light channel colors like white or yellow. */
export function getContrastTextClass(hex: string): "text-white" | "text-black" {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  return brightness > 140 ? "text-black" : "text-white";
}

/** Clipboard cell text uses "1"/"0" for toggles, matching AppConstants.VALVE_OPEN/CLOSED from the original app. */
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

/** Returns null for unparseable text so the caller can silently skip it, matching the original's try/except ValueError: pass. */
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

/** A device whose instance_id isn't in `instances` falls into an "unassigned" group at the end -- shouldn't happen since the server cascades instance removal to its devices (zone_runtime.py), but stay defensive rather than dropping them. */
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
