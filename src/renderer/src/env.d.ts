/// <reference types="vite/client" />

interface Window {
  // Matches contextBridge.exposeInMainWorld("electron", ...) in src/preload.
  // Not NodeJS.ProcessVersions -- the renderer has no Node globals (sandbox
  // stays conceptually isolated even with sandbox:false + contextIsolation),
  // this is just the plain object process.versions serializes to over the bridge.
  electron: {
    versions: Record<string, string>;
    selectMusicFile: () => Promise<string | null>;
  };
}
