import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { DaemonStatus } from "../main/index";

// Renderer talks to the daemon directly over WebSocket (no IPC needed); this preload only exposes main-process-only capabilities (daemon process, native dialogs) so contextIsolation can stay on.
contextBridge.exposeInMainWorld("electron", {
  versions: process.versions,
  // Native file picker for music_file; defaults to the daemon's scenarios folder (see main/index.ts) so no path needs to be typed. Resolves to null if cancelled.
  selectMusicFile: (): Promise<string | null> => ipcRenderer.invoke("select-music-file"),

  // Daemon lifecycle status; getDaemonStatus returns the current value first (covers a subscriber mounting after the last push), then onDaemonStatus streams live updates.
  getDaemonStatus: (): Promise<DaemonStatus> => ipcRenderer.invoke("get-daemon-status"),
  onDaemonStatus: (callback: (status: DaemonStatus) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, status: DaemonStatus): void => callback(status);
    ipcRenderer.on("daemon-status", listener);
    return () => ipcRenderer.removeListener("daemon-status", listener);
  },

  // Saves the log ring buffer (daemon stdout/stderr + lifecycle events) to an operator-picked file for on-site diagnostics without a dev terminal.
  exportLogs: (): Promise<{ ok: boolean; path?: string; error?: string | null }> => ipcRenderer.invoke("export-logs"),

  // Scenario file <-> disk, for backup/transfer independent of the daemon's own data/scenarios/ folder (see main/index.ts). Content is a plain JSON string both ways -- this process doesn't parse it.
  exportScenarioFile: (defaultName: string, content: string): Promise<{ ok: boolean; path?: string; error?: string | null }> =>
    ipcRenderer.invoke("export-scenario-file", defaultName, content),
  importScenarioFile: (): Promise<{ ok: boolean; path?: string; content?: string; error?: string | null }> =>
    ipcRenderer.invoke("import-scenario-file"),

  // Swaps the 3D preview's model from inside the app (see ScenePreview.tsx) -- stored under userData and served back over fountain-model:// (see main/index.ts), so this never touches the read-only-once-packaged src/renderer/public/models/ folder.
  getModelInfo: (): Promise<{ hasCustomModel: boolean; entry?: string }> => ipcRenderer.invoke("get-model-info"),
  importModel: (): Promise<{ ok: boolean; entry?: string; error?: string | null }> => ipcRenderer.invoke("import-3d-model"),
  resetModel: (): Promise<void> => ipcRenderer.invoke("reset-3d-model"),

  // Auto-launch reads/writes app.getLoginItemSettings() directly (see main/index.ts); supported is false in dev mode (no installed .exe to register) so Settings can show the toggle disabled instead of silently no-op.
  getAutoLaunch: (): Promise<{ enabled: boolean; supported: boolean }> => ipcRenderer.invoke("get-auto-launch"),
  setAutoLaunch: (enabled: boolean): Promise<void> => ipcRenderer.invoke("set-auto-launch", enabled),
});
