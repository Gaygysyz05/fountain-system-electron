import { create } from "zustand";

interface DaemonStatusStore {
  status: DaemonStatus;
}

/**
 * Mirrors main/index.ts's daemon lifecycle into the renderer so an operator with no terminal can see it (see StatusBar.tsx), rather than it only going to console.log.
 */
export const useDaemonStatusStore = create<DaemonStatusStore>((set) => {
  // The one-shot snapshot and a live push can race and land out of order, so once any live push has been seen the snapshot is ignored (it only covers the gap before the first push).
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
