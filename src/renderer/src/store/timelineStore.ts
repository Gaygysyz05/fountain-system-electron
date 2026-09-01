import { create } from "zustand";
import { describeError } from "../lib/errors";
import { restClient } from "../lib/restClient";
import { generateValvePattern, type ScenarioEvent, type ScenarioFile, type ValvePatternOptions } from "../lib/scenario";

function emptyFile(deviceIds: string[] = []): ScenarioFile {
  return { name: "New Scenario", duration: 30, music_file: null, events: [], deviceIds };
}

const HISTORY_LIMIT = 50;

interface TimelineStore {
  scenarioId: string;
  file: ScenarioFile;
  dirty: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  setError: (message: string | null) => void;

  // -- undo/redo: scoped to `file.events` (the device grid), which is where
  // every high-frequency edit -- click, inline number, pattern, paste --
  // happens. Snapshot-based (whole `events` array per step) rather than
  // component_tables.py's per-field QUndoStack commands -- simpler, still
  // correct, and unlike the original, a paste of 50 cells is one undo step
  // instead of bypassing undo entirely.
  past: ScenarioEvent[][];
  future: ScenarioEvent[][];
  undo: () => void;
  redo: () => void;

  newScenario: (deviceIds: string[]) => void;
  loadScenario: (scenarioId: string) => Promise<void>;
  /** Resolves true on success, false on failure -- callers use this instead
   * of racing the store's `error` field to decide whether to chain a
   * follow-up action (e.g. refreshing the scenario list) or show feedback. */
  saveScenario: (scenarioId: string) => Promise<boolean>;

  setName: (name: string) => void;
  setDuration: (duration: number) => void;
  setMusicFile: (path: string) => void;
  setDeviceIds: (deviceIds: string[]) => void;

  // -- grid: the primary editor, one event per (device_id, time) ----------
  setGridEvent: (deviceId: string, time: number, parameters: Record<string, unknown>) => void;
  removeGridEvent: (deviceId: string, time: number) => void;
  setGridEventsBulk: (entries: Array<{ deviceId: string; time: number; parameters: Record<string, unknown> }>) => void;
  removeGridEventsBulk: (entries: Array<{ deviceId: string; time: number }>) => void;
  applyValvePattern: (options: ValvePatternOptions) => void;
}

/** Upserts `entries` into an events array, returning a new array. Shared by
 * every grid-mutating action so single-cell and bulk edits behave the same. */
function upsertEvents(
  events: ScenarioEvent[],
  entries: Array<{ deviceId: string; time: number; parameters: Record<string, unknown> }>,
): ScenarioEvent[] {
  const next = [...events];
  for (const { deviceId, time, parameters } of entries) {
    const idx = next.findIndex((e) => e.device_id === deviceId && e.time === time);
    if (idx >= 0) next[idx] = { ...next[idx], parameters };
    else next.push({ id: crypto.randomUUID(), time, device_id: deviceId, parameters });
  }
  return next;
}

/**
 * Grid (events) is the authoring surface -- see lib/scenario.ts's top
 * comment. Round-trips through data/scenarios/*.json on the daemon via
 * restClient.saveScenario.
 */
export const useTimelineStore = create<TimelineStore>((set, get) => ({
  scenarioId: "",
  file: emptyFile(),
  dirty: false,
  loading: false,
  saving: false,
  error: null,
  setError: (message) => set({ error: message }),

  past: [],
  future: [],

  undo: () =>
    set((s) => {
      if (s.past.length === 0) return s;
      const previous = s.past[s.past.length - 1];
      return {
        file: { ...s.file, events: previous },
        past: s.past.slice(0, -1),
        future: [s.file.events, ...s.future].slice(0, HISTORY_LIMIT),
        dirty: true,
      };
    }),

  redo: () =>
    set((s) => {
      if (s.future.length === 0) return s;
      const next = s.future[0];
      return {
        file: { ...s.file, events: next },
        future: s.future.slice(1),
        past: [...s.past, s.file.events].slice(-HISTORY_LIMIT),
        dirty: true,
      };
    }),

  newScenario: (deviceIds) => set({ scenarioId: "", file: emptyFile(deviceIds), dirty: false, error: null, past: [], future: [] }),

  loadScenario: async (scenarioId: string) => {
    set({ loading: true, error: null });
    try {
      const data = await restClient.getScenarioFull(scenarioId);
      set({
        scenarioId,
        file: {
          name: data.name ?? scenarioId,
          duration: data.duration,
          music_file: data.music_file ?? null,
          events: data.events.map((e) => ({ ...e, id: crypto.randomUUID() })),
          deviceIds: data.device_ids ?? [],
        },
        dirty: false,
        loading: false,
        past: [],
        future: [],
      });
    } catch (err) {
      set({ loading: false, error: describeError(err) });
    }
  },

  saveScenario: async (scenarioId: string) => {
    set({ error: null, saving: true });
    try {
      await restClient.saveScenario(scenarioId, get().file);
      set({ scenarioId, dirty: false, saving: false });
      return true;
    } catch (err) {
      set({ error: describeError(err), saving: false });
      return false;
    }
  },

  setName: (name) => set((s) => ({ file: { ...s.file, name }, dirty: true })),
  setDuration: (duration) => set((s) => ({ file: { ...s.file, duration: Math.max(0, duration) }, dirty: true })),
  setMusicFile: (path) => set((s) => ({ file: { ...s.file, music_file: path || null }, dirty: true })),
  setDeviceIds: (deviceIds) => set((s) => ({ file: { ...s.file, deviceIds }, dirty: true })),

  setGridEvent: (deviceId, time, parameters) =>
    set((s) => ({
      file: { ...s.file, events: upsertEvents(s.file.events, [{ deviceId, time, parameters }]) },
      past: [...s.past, s.file.events].slice(-HISTORY_LIMIT),
      future: [],
      dirty: true,
    })),

  removeGridEvent: (deviceId, time) =>
    set((s) => ({
      file: { ...s.file, events: s.file.events.filter((e) => !(e.device_id === deviceId && e.time === time)) },
      past: [...s.past, s.file.events].slice(-HISTORY_LIMIT),
      future: [],
      dirty: true,
    })),

  setGridEventsBulk: (entries) =>
    set((s) => {
      if (entries.length === 0) return s;
      return {
        file: { ...s.file, events: upsertEvents(s.file.events, entries) },
        past: [...s.past, s.file.events].slice(-HISTORY_LIMIT),
        future: [],
        dirty: true,
      };
    }),

  removeGridEventsBulk: (entries) =>
    set((s) => {
      if (entries.length === 0) return s;
      const keys = new Set(entries.map((e) => `${e.deviceId} ${e.time}`));
      return {
        file: { ...s.file, events: s.file.events.filter((e) => !keys.has(`${e.device_id} ${e.time}`)) },
        past: [...s.past, s.file.events].slice(-HISTORY_LIMIT),
        future: [],
        dirty: true,
      };
    }),

  applyValvePattern: (opts) =>
    set((s) => {
      const field = opts.field ?? "on";
      const entries = generateValvePattern(opts).map(({ time, device_id, on }) => {
        const existing = s.file.events.find((e) => e.device_id === device_id && e.time === time);
        return { deviceId: device_id, time, parameters: { ...(existing?.parameters ?? {}), [field]: on } };
      });
      return {
        file: { ...s.file, events: upsertEvents(s.file.events, entries) },
        past: [...s.past, s.file.events].slice(-HISTORY_LIMIT),
        future: [],
        dirty: true,
      };
    }),
}));
