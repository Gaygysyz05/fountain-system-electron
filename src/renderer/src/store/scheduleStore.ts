import { create } from "zustand";
import { describeError } from "../lib/errors";
import { restClient } from "../lib/restClient";
import { afterMutation } from "../lib/storeHelpers";
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

  createEntry: afterMutation(
    (input: ScheduleEntryInput) => restClient.createScheduleEntry(input),
    () => get().loadSchedule(),
  ),

  updateEntry: afterMutation(
    (entryId: string, input: Partial<ScheduleEntryInput>) => restClient.updateScheduleEntry(entryId, input),
    () => get().loadSchedule(),
  ),

  deleteEntry: afterMutation(
    (entryId: string) => restClient.deleteScheduleEntry(entryId),
    () => get().loadSchedule(),
  ),
}));
