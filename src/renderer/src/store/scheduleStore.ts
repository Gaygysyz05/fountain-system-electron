import { create } from "zustand";
import { describeError } from "../lib/errors";
import { restClient } from "../lib/restClient";
import type { ScheduleEntryDto, ScheduleEntryInput } from "../lib/protocol";

// Same reasoning as scenariosStore/configStore's split: a schedule entry
// changes on its own cadence (an operator tweaking show times), unrelated
// to hardware config or the scenario files it references. Plain
// fetch-on-mutate, no live event stream -- schedule entries only ever
// change from this same UI, so there's nothing external to resync against.
interface ScheduleStore {
  entries: ScheduleEntryDto[];
  loading: boolean;
  error: string | null;

  loadSchedule: () => Promise<void>;
  createEntry: (input: ScheduleEntryInput) => Promise<void>;
  updateEntry: (entryId: string, input: Partial<ScheduleEntryInput>) => Promise<void>;
  deleteEntry: (entryId: string) => Promise<void>;
}

export const useScheduleStore = create<ScheduleStore>((set, get) => ({
  entries: [],
  loading: false,
  error: null,

  loadSchedule: async () => {
    set({ loading: true });
    try {
      const entries = await restClient.getSchedule();
      set({ entries, loading: false, error: null });
    } catch (err) {
      set({ loading: false, error: describeError(err) });
    }
  },

  createEntry: async (input) => {
    await restClient.createScheduleEntry(input);
    await get().loadSchedule();
  },

  updateEntry: async (entryId, input) => {
    await restClient.updateScheduleEntry(entryId, input);
    await get().loadSchedule();
  },

  deleteEntry: async (entryId) => {
    await restClient.deleteScheduleEntry(entryId);
    await get().loadSchedule();
  },
}));
