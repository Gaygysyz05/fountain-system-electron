/// <reference types="vite/client" />

// Mirrors main/index.ts's DaemonStatus, duplicated because the renderer's tsconfig doesn't share a project boundary with main/preload's.
type DaemonStatus =
  | { phase: "starting" }
  | { phase: "running" }
  | { phase: "restarting"; attempt: number; maxAttempts: number }
  | { phase: "failed"; maxAttempts: number };

interface Window {
  // Matches contextBridge.exposeInMainWorld("electron", ...) in src/preload; not NodeJS.ProcessVersions since the renderer has no Node globals.
  electron: {
    versions: Record<string, string>;
    selectMusicFile: () => Promise<string | null>;
    getDaemonStatus: () => Promise<DaemonStatus>;
    onDaemonStatus: (callback: (status: DaemonStatus) => void) => () => void;
    exportLogs: () => Promise<{ ok: boolean; path?: string; error?: string | null }>;
    exportScenarioFile: (defaultName: string, content: string) => Promise<{ ok: boolean; path?: string; error?: string | null }>;
    importScenarioFile: () => Promise<{ ok: boolean; path?: string; content?: string; error?: string | null }>;
    getModelInfo: () => Promise<{ hasCustomModel: boolean; entry?: string }>;
    importModel: () => Promise<{ ok: boolean; entry?: string; error?: string | null }>;
    resetModel: () => Promise<void>;
    getAutoLaunch: () => Promise<{ enabled: boolean; supported: boolean }>;
    setAutoLaunch: (enabled: boolean) => Promise<void>;
  };
}
