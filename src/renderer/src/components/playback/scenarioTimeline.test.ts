import { describe, expect, it } from "vitest";
import { buildColorSpans, buildFrequencyMarkers, buildToggleSpans, pickTickStepSeconds, type WireEvent } from "./scenarioTimeline";

describe("buildToggleSpans", () => {
  it("fills a gap before the first event with the device's default (off)", () => {
    const events: WireEvent[] = [{ time: 5, device_id: "v1", parameters: { on: true } }];
    const spans = buildToggleSpans("v1", "on", "valve", events, 10);
    expect(spans).toEqual([
      { start: 0, end: 5, on: false },
      { start: 5, end: 10, on: true },
    ]);
  });

  it("merges adjacent events that re-assert the same value into one span, no seams", () => {
    // The grid editor's bulk-fill tools can write one explicit event per
    // time step even when the value didn't actually change -- this is the
    // exact case that used to render as several abutting same-color tiles
    // with visible seams between them (see the ScenarioTimelinePlayer
    // Light-row screenshot bug from the piano-roll redesign).
    const events: WireEvent[] = [
      { time: 0, device_id: "v1", parameters: { on: true } },
      { time: 1, device_id: "v1", parameters: { on: true } },
      { time: 2, device_id: "v1", parameters: { on: true } },
      { time: 3, device_id: "v1", parameters: { on: false } },
    ];
    const spans = buildToggleSpans("v1", "on", "valve", events, 5);
    expect(spans).toEqual([
      { start: 0, end: 3, on: true },
      { start: 3, end: 5, on: false },
    ]);
  });

  it("ignores events for other devices", () => {
    const events: WireEvent[] = [
      { time: 1, device_id: "v2", parameters: { on: true } },
      { time: 2, device_id: "v1", parameters: { on: true } },
    ];
    const spans = buildToggleSpans("v1", "on", "valve", events, 4);
    expect(spans).toEqual([
      { start: 0, end: 2, on: false },
      { start: 2, end: 4, on: true },
    ]);
  });

  it("sorts out-of-order events by time before building spans", () => {
    const events: WireEvent[] = [
      { time: 3, device_id: "v1", parameters: { on: false } },
      { time: 1, device_id: "v1", parameters: { on: true } },
    ];
    const spans = buildToggleSpans("v1", "on", "valve", events, 5);
    expect(spans).toEqual([
      { start: 0, end: 1, on: false },
      { start: 1, end: 3, on: true },
      { start: 3, end: 5, on: false },
    ]);
  });

  it("produces one span covering the whole duration when nothing ever changes", () => {
    const spans = buildToggleSpans("v1", "on", "valve", [], 10);
    expect(spans).toEqual([{ start: 0, end: 10, on: false }]);
  });

  it("a motor's `active` field defaults off the same way a valve's `on` does", () => {
    const events: WireEvent[] = [{ time: 2, device_id: "m1", parameters: { active: true, frequency: 30 } }];
    const spans = buildToggleSpans("m1", "active", "motor", events, 6);
    expect(spans).toEqual([
      { start: 0, end: 2, on: false },
      { start: 2, end: 6, on: true },
    ]);
  });
});

describe("buildColorSpans", () => {
  it("defaults to white before the first color event", () => {
    const events: WireEvent[] = [{ time: 4, device_id: "l1", parameters: { r: 255, g: 0, b: 0 } }];
    const spans = buildColorSpans("l1", events, 8);
    expect(spans).toEqual([
      { start: 0, end: 4, hex: "#ffffff" },
      { start: 4, end: 8, hex: "#ff0000" },
    ]);
  });

  it("merges consecutive events that resolve to the same hex", () => {
    const events: WireEvent[] = [
      { time: 0, device_id: "l1", parameters: { r: 0, g: 255, b: 0 } },
      { time: 1, device_id: "l1", parameters: { r: 0, g: 255, b: 0 } },
      { time: 2, device_id: "l1", parameters: { r: 0, g: 0, b: 255 } },
    ];
    const spans = buildColorSpans("l1", events, 3);
    expect(spans).toEqual([
      { start: 0, end: 2, hex: "#00ff00" },
      { start: 2, end: 3, hex: "#0000ff" },
    ]);
  });
});

describe("buildFrequencyMarkers", () => {
  it("emits a marker only when frequency actually changes beyond noise", () => {
    const events: WireEvent[] = [
      { time: 0, device_id: "m1", parameters: { frequency: 30, active: true } },
      { time: 1, device_id: "m1", parameters: { frequency: 30.01, active: true } }, // within tolerance
      { time: 2, device_id: "m1", parameters: { frequency: 45, active: true } },
      { time: 3, device_id: "m1", parameters: { active: true } }, // no frequency field at all
    ];
    const markers = buildFrequencyMarkers("m1", events);
    expect(markers).toEqual([
      { time: 0, hz: 30 },
      { time: 2, hz: 45 },
    ]);
  });
});

describe("pickTickStepSeconds", () => {
  it("picks the smallest round step whose spacing clears the minimum label width", () => {
    expect(pickTickStepSeconds(100)).toBe(1); // 100px/s * 1s = 100px >= 50px
    expect(pickTickStepSeconds(10)).toBe(5); // 10*1=10, 10*2=20, 10*5=50 >= 50
    expect(pickTickStepSeconds(1)).toBe(60); // first candidate clearing 50px at 1px/s
  });

  it("falls back to the largest candidate when nothing else clears the minimum", () => {
    expect(pickTickStepSeconds(0.001)).toBe(600);
  });
});
