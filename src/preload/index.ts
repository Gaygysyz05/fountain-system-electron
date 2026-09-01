import { contextBridge, ipcRenderer } from "electron";

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
});
