/// <reference types="vite/client" />

// Mirrors main/index.ts's DaemonStatus -- duplicated rather than imported
// (like lib/protocol.ts mirrors app/protocol.py) since the renderer's
// tsconfig doesn't share a project boundary with main/preload's.
type DaemonStatus =
  | { phase: "starting" }
  | { phase: "running" }
  | { phase: "restarting"; attempt: number; maxAttempts: number }
  | { phase: "failed"; maxAttempts: number };

interface Window {
  // Matches contextBridge.exposeInMainWorld("electron", ...) in src/preload.
  // Not NodeJS.ProcessVersions -- the renderer has no Node globals (sandbox
  // stays conceptually isolated even with sandbox:false + contextIsolation),
  // this is just the plain object process.versions serializes to over the bridge.
  //
  electron: {
    versions: Record<string, string>;
    selectMusicFile: () => Promise<string | null>;
    getDaemonStatus: () => Promise<DaemonStatus>;
    onDaemonStatus: (callback: (status: DaemonStatus) => void) => () => void;
    exportLogs: () => Promise<{ ok: boolean; path?: string; error?: string | null }>;
  };
}
