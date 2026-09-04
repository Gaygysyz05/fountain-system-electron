import { describe, expect, it } from "vitest";
import { useTimelineStore } from "./timelineStore";
import type { ScenarioEvent } from "../lib/scenario";

function seedEvents(events: ScenarioEvent[]): void {
  useTimelineStore.setState((s) => ({ file: { ...s.file, events, duration: 20 } }));
}

function eventsFor(deviceId: string): ScenarioEvent[] {
  return useTimelineStore
    .getState()
    .file.events.filter((e) => e.device_id === deviceId)
    .sort((a, b) => a.time - b.time);
}

describe("commitChannelSpans", () => {
  it("writes a fresh on/off boundary pair for a brand new span", () => {
    seedEvents([]);
    useTimelineStore.getState().commitChannelSpans("V1", "on", [{ start: 2, end: 5 }]);
    expect(eventsFor("V1").map((e) => [e.time, e.parameters.on])).toEqual([
      [2, true],
      [5, false],
    ]);
  });

  it("removes a boundary that no longer exists after the edit, not just adds the new one", () => {
    // Starts as one span [2,5]; the edit shrinks it to [2,3.5] -- the old
    // off@5 must be REMOVED, not left behind as a stale event (this is
    // exactly the "double naложение" class of bug: an old boundary from a
    // previously wider/different span corrupting the replay).
    seedEvents([
      { id: "a", time: 2, device_id: "V1", parameters: { on: true } },
      { id: "b", time: 5, device_id: "V1", parameters: { on: false } },
    ]);
    useTimelineStore.getState().commitChannelSpans("V1", "on", [{ start: 2, end: 3.5 }]);
    expect(eventsFor("V1").map((e) => [e.time, e.parameters.on])).toEqual([
      [2, true],
      [3.5, false],
    ]);
  });

  it("merges two spans that end up touching exactly into one continuous ON period", () => {
    // [2,5] and [5,8] share a boundary at t=5 -- the desired replay is ONE
    // continuous on-period from 2 to 8, not an on/off blip at the seam.
    seedEvents([]);
    useTimelineStore.getState().commitChannelSpans("V1", "on", [
      { start: 2, end: 5 },
      { start: 5, end: 8 },
    ]);
    expect(eventsFor("V1").map((e) => [e.time, e.parameters.on])).toEqual([
      [2, true],
      [8, false],
    ]);
  });

  it("preserves an unrelated parameter already sitting at a reused boundary time", () => {
    // A motor's "active" boundary lands on the same instant as a frequency
    // value set some other way (grid, pattern tool) -- committing the span
    // must not silently drop it.
    seedEvents([{ id: "a", time: 2, device_id: "M1", parameters: { frequency: 30 } }]);
    useTimelineStore.getState().commitChannelSpans("M1", "active", [{ start: 2, end: 6 }]);
    const at2 = eventsFor("M1").find((e) => e.time === 2);
    expect(at2?.parameters).toEqual({ frequency: 30, active: true });
  });

  it("deleting every span clears both of its boundary events", () => {
    seedEvents([
      { id: "a", time: 2, device_id: "V1", parameters: { on: true } },
      { id: "b", time: 5, device_id: "V1", parameters: { on: false } },
    ]);
    useTimelineStore.getState().commitChannelSpans("V1", "on", []);
    expect(eventsFor("V1")).toEqual([]);
  });

  it("leaves other devices' events untouched", () => {
    seedEvents([{ id: "a", time: 1, device_id: "V2", parameters: { on: true } }]);
    useTimelineStore.getState().commitChannelSpans("V1", "on", [{ start: 2, end: 5 }]);
    expect(eventsFor("V2")).toHaveLength(1);
  });
});
