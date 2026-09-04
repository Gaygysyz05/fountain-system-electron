import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { DaemonStatus } from "../main/index";

// The renderer talks to the daemon directly over `ws://127.0.0.1:8765/ws`
// using the browser's native WebSocket API -- no IPC bridge needed for that,
// it's just a local network connection like any other. This preload exists
// so contextIsolation can stay on (Electron's secure default) for
// main-process-only capabilities: spawning/monitoring the daemon process,
// native file-picker dialogs, etc.
contextBridge.exposeInMainWorld("electron", {
  versions: process.versions,
  // Native "choose a file" dialog for the timeline's music_file field --
  // defaults to the daemon's scenarios folder (see main/index.ts's
  // select-music-file handler) so picking a track there needs no typed
  // path at all. Resolves to null if the user cancels.
  selectMusicFile: (): Promise<string | null> => ipcRenderer.invoke("select-music-file"),

  // Daemon child-process lifecycle (starting/running/restarting/gave-up) --
  // see main/index.ts's daemon status block for why this exists. Current
  // value first (covers a subscriber mounting after the last push), then
  // live updates.
  getDaemonStatus: (): Promise<DaemonStatus> => ipcRenderer.invoke("get-daemon-status"),
  onDaemonStatus: (callback: (status: DaemonStatus) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, status: DaemonStatus): void => callback(status);
    ipcRenderer.on("daemon-status", listener);
    return () => ipcRenderer.removeListener("daemon-status", listener);
  },

  // Saves the main process's log ring buffer (daemon stdout/stderr + its
  // own spawn/restart lifecycle lines) to a file the operator picks via a
  // native save dialog -- on-site diagnostics without a dev terminal.
  exportLogs: (): Promise<{ ok: boolean; path?: string; error?: string | null }> => ipcRenderer.invoke("export-logs"),

  // "Start automatically when Windows starts" -- see main/index.ts's
  // configureAutoLaunch/get-auto-launch/set-auto-launch for why this reads
  // and writes app.getLoginItemSettings() directly rather than a settings
  // value of its own. `supported` is false in `electron-vite dev` (there is
  // no installed .exe to register), letting the Settings screen show the
  // toggle disabled with an explanation instead of it silently doing nothing.
  getAutoLaunch: (): Promise<{ enabled: boolean; supported: boolean }> => ipcRenderer.invoke("get-auto-launch"),
  setAutoLaunch: (enabled: boolean): Promise<void> => ipcRenderer.invoke("set-auto-launch", enabled),
});
