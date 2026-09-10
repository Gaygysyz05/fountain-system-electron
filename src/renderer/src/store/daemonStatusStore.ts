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
  // The one-shot getDaemonStatus() snapshot and the live onDaemonStatus
  // push race each other: if a push arrives (e.g. the daemon transitions
  // to "running") before that snapshot's IPC round-trip resolves, the
  // snapshot lands SECOND and overwrites the newer live status with a
  // stale one. Once any live push has been seen, the snapshot is no
  // longer applied -- it only exists to cover the gap before the first push.
  let livePushReceived = false;
  window.electron.getDaemonStatus().then((status) => {
    if (!livePushReceived) set({ status });
  });
  window.electron.onDaemonStatus((status) => {
    livePushReceived = true;
    set({ status });
  });

  return {
    status: { phase: "starting" },
  };
});
