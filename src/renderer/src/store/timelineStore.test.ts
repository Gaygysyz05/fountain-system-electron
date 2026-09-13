import { describe, expect, it, vi } from "vitest";
import { useTimelineStore } from "./timelineStore";
import { restClient } from "../lib/restClient";
import type { ScenarioEvent, ScenarioFile } from "../lib/scenario";

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

describe("loadGeneratedScenario", () => {
  it("replaces the editor with the generated file, marks it dirty (unsaved), and clears undo history", () => {
    seedEvents([{ id: "a", time: 1, device_id: "V1", parameters: { on: true } }]);
    useTimelineStore.getState().commitChannelSpans("V1", "on", [{ start: 2, end: 5 }]); // populate `past` so we can check it gets cleared
    useTimelineStore.setState({ scenarioId: "old-scenario" });

    const generated: ScenarioFile = {
      name: "song.mp3 (generated)",
      duration: 180,
      music_file: "C:\\music\\song.mp3",
      events: [{ id: "gen-1", time: 0.5, device_id: "L1", parameters: { r: 255, g: 200, b: 120 } }],
      deviceIds: [],
      zoneId: 1,
    };
    useTimelineStore.getState().loadGeneratedScenario(generated);

    const state = useTimelineStore.getState();
    expect(state.scenarioId).toBe(""); // a generated show is unsaved until the operator explicitly saves it
    expect(state.file).toEqual(generated);
    expect(state.dirty).toBe(true);
    expect(state.past).toEqual([]);
    expect(state.future).toEqual([]);
  });
});

describe("saveScenario / loadScenario race guards (_generation)", () => {
  it("a save superseded by a newer load does not stomp the newer scenario's scenarioId/dirty", async () => {
    seedEvents([]);
    useTimelineStore.setState({ scenarioId: "old-scenario", dirty: true });

    let resolveSave!: () => void;
    const savePromise = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    const saveSpy = vi.spyOn(restClient, "saveScenario").mockReturnValue(savePromise);
    const getSpy = vi.spyOn(restClient, "getScenarioFull").mockResolvedValue({
      name: "other", duration: 10, music_file: null, events: [], device_ids: [], zone_id: 2,
    });

    const saveResult = useTimelineStore.getState().saveScenario("old-scenario"); // starts, network call not yet resolved

    // While that save is still in flight, the operator loads a completely different scenario.
    await useTimelineStore.getState().loadScenario("other-scenario");
    expect(useTimelineStore.getState().scenarioId).toBe("other-scenario");

    // NOW the stale save resolves.
    resolveSave();
    expect(await saveResult).toBe(true); // the disk write itself genuinely did succeed

    // ...but it must not have reverted the store back to the old scenario it was saving.
    expect(useTimelineStore.getState().scenarioId).toBe("other-scenario");
    expect(useTimelineStore.getState().dirty).toBe(false); // from the load, not left dirty:true by a skipped save commit

    saveSpy.mockRestore();
    getSpy.mockRestore();
  });

  it("an earlier load's late response does not overwrite a later load's result", async () => {
    let resolveFirst!: (value: Awaited<ReturnType<typeof restClient.getScenarioFull>>) => void;
    const firstResponse = new Promise<Awaited<ReturnType<typeof restClient.getScenarioFull>>>((resolve) => {
      resolveFirst = resolve;
    });
    const getSpy = vi.spyOn(restClient, "getScenarioFull");
    getSpy.mockReturnValueOnce(firstResponse);

    const firstLoad = useTimelineStore.getState().loadScenario("scenario-a"); // starts, network call not yet resolved

    getSpy.mockResolvedValueOnce({ name: "b", duration: 20, music_file: null, events: [], device_ids: [], zone_id: null });
    await useTimelineStore.getState().loadScenario("scenario-b"); // starts AND resolves before "a" does
    expect(useTimelineStore.getState().scenarioId).toBe("scenario-b");

    // The slow first load ("a") finally resolves now, well after "b" already won.
    resolveFirst({ name: "a", duration: 10, music_file: null, events: [], device_ids: [], zone_id: null });
    await firstLoad;

    // Must still show "b" -- "a"'s late response must not have overwritten it just because it resolved last.
    expect(useTimelineStore.getState().scenarioId).toBe("scenario-b");
    expect(useTimelineStore.getState().file.duration).toBe(20);

    getSpy.mockRestore();
  });
});
