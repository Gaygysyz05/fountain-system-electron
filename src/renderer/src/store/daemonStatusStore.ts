import { create } from "zustand";

interface DaemonStatusStore {
  status: DaemonStatus;
}

/**
 * Mirrors main/index.ts's daemon child-process lifecycle (starting/running/
 * restarting/gave-up) into the renderer -- previously that whole story only
 * ever went to console.log in the main process, invisible to an operator on
 * a site panel who has no terminal to look at. See StatusBar.tsx for where
 * this actually gets shown.
 *
 * Same "current value first, then live pushes" pattern as connectionStore's
 * daemonClient: getDaemonStatus() covers this store's own initialization
 * (mounting after whatever the last push was), onDaemonStatus keeps it live
 * from there.
 */
export const useDaemonStatusStore = create<DaemonStatusStore>((set) => {
  window.electron.getDaemonStatus().then((status) => set({ status }));
  window.electron.onDaemonStatus((status) => set({ status }));

  return {
    status: { phase: "starting" },
  };
});
