import { describe, expect, it } from "vitest";
import {
  getColorHex,
  getContrastTextClass,
  groupDevicesByInstance,
  groupNozzlePairs,
  parseClipboardToken,
  toClipboardToken,
  type DeviceColumn,
} from "./deviceColumns";
import type { DeviceDto, DriverInstanceDto } from "../../lib/protocol";

function device(overrides: Partial<DeviceDto>): DeviceDto {
  return { device_id: "d1", instance_id: "i1", channel: "1", category: "valve", ...overrides };
}

function instance(overrides: Partial<DriverInstanceDto>): DriverInstanceDto {
  return { instance_id: "i1", driver_type: "modbus_relay_valve", category: "valve", connected: true, config: {}, ...overrides };
}

describe("getColorHex", () => {
  it("converts r/g/b to a hex string, clamping out-of-range and missing channels", () => {
    expect(getColorHex({ r: 255, g: 0, b: 128 })).toBe("#ff0080");
    expect(getColorHex({ r: 300, g: -10 })).toBe("#ff0000"); // clamped, b defaults to 0
    expect(getColorHex(undefined)).toBe("#000000");
  });
});

describe("getContrastTextClass", () => {
  it("picks black text on a bright background and white text on a dark one", () => {
    expect(getContrastTextClass("#ffffff")).toBe("text-black");
    expect(getContrastTextClass("#000000")).toBe("text-white");
    expect(getContrastTextClass("#ffff00")).toBe("text-black"); // bright yellow
  });
});

describe("clipboard token round-trip", () => {
  const toggleCol: DeviceColumn = { key: "d1", deviceId: "d1", field: "on", label: "V1", title: "d1", kind: "toggle" };
  const numberCol: DeviceColumn = { key: "d1:freq", deviceId: "d1", field: "frequency", label: "M1 Hz", title: "d1", kind: "number", min: 0, max: 50 };
  const colorCol: DeviceColumn = { key: "d1", deviceId: "d1", field: "color", label: "L1", title: "d1", kind: "color" };

  it("toggle: writes and parses 1/0", () => {
    expect(toClipboardToken({ on: true }, toggleCol)).toBe("1");
    expect(toClipboardToken({ on: false }, toggleCol)).toBe("0");
    expect(parseClipboardToken("1", toggleCol)).toEqual({ on: true });
    expect(parseClipboardToken("ON", toggleCol)).toEqual({ on: true });
    expect(parseClipboardToken("0", toggleCol)).toEqual({ on: false });
  });

  it("number: clamps a pasted value to the column's min/max", () => {
    expect(toClipboardToken({ frequency: 30 }, numberCol)).toBe("30");
    expect(parseClipboardToken("999", numberCol)).toEqual({ frequency: 50 });
    expect(parseClipboardToken("-5", numberCol)).toEqual({ frequency: 0 });
    expect(parseClipboardToken("not a number", numberCol)).toBeNull();
  });

  it("color: round-trips a hex string through r/g/b and rejects malformed input", () => {
    const token = toClipboardToken({ r: 255, g: 128, b: 0 }, colorCol);
    expect(token).toBe("#ff8000");
    expect(parseClipboardToken(token, colorCol)).toEqual({ r: 255, g: 128, b: 0 });
    expect(parseClipboardToken("not-a-color", colorCol)).toBeNull();
  });
});

describe("groupNozzlePairs", () => {
  it("pairs inverter 1 and 2 devices by nozzle_group, ordered by first appearance", () => {
    const devices = [
      device({ device_id: "m1", nozzle_group: "N1", nozzle_inverter: 1 }),
      device({ device_id: "m2", nozzle_group: "N2", nozzle_inverter: 1 }),
      device({ device_id: "m3", nozzle_group: "N1", nozzle_inverter: 2 }),
      device({ device_id: "other", nozzle_group: undefined }), // not part of any nozzle
    ];
    const pairs = groupNozzlePairs(devices);
    expect(pairs).toEqual([
      { nozzleGroup: "N1", inv1: devices[0], inv2: devices[2] },
      { nozzleGroup: "N2", inv1: devices[1], inv2: null },
    ]);
  });
});

describe("groupDevicesByInstance", () => {
  it("groups devices under their instance, in the instance list's order", () => {
    const i1 = instance({ instance_id: "i1" });
    const i2 = instance({ instance_id: "i2" });
    const d1 = device({ device_id: "d1", instance_id: "i2" });
    const d2 = device({ device_id: "d2", instance_id: "i1" });
    const d3 = device({ device_id: "d3", instance_id: "i1" });

    const groups = groupDevicesByInstance([d1, d2, d3], [i1, i2]);
    expect(groups).toEqual([
      { instance: i1, devices: [d2, d3] },
      { instance: i2, devices: [d1] },
    ]);
  });

  it("omits an instance with no devices, and falls back to an unassigned group for an unknown instance_id", () => {
    const i1 = instance({ instance_id: "i1" });
    const i2 = instance({ instance_id: "i2" }); // configured, but nothing wired to it yet
    const orphan = device({ device_id: "orphan", instance_id: "deleted-instance" });

    const groups = groupDevicesByInstance([orphan], [i1, i2]);
    expect(groups).toEqual([{ instance: null, devices: [orphan] }]);
  });
});
