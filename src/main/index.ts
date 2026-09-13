import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { isAbsolute, join, relative, resolve } from "path";
import { spawn, type ChildProcess } from "child_process";
import { writeFile, readFile } from "fs/promises";
import { is } from "@electron-toolkit/utils";

// Own copy rather than importing the renderer's lib/errors.ts -- separate process, separate module graph/build target.
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// This shell's own preferences (not the daemon's); login-item state itself lives in Windows' own registered entry, not duplicated here, to avoid drift.
interface AppSettings {
  autoLaunchDefaultApplied?: boolean;
}

function settingsFilePath(): string {
  return join(app.getPath("userData"), "settings.json");
}

async function readAppSettings(): Promise<AppSettings> {
  try {
    return JSON.parse(await readFile(settingsFilePath(), "utf-8")) as AppSettings;
  } catch {
    return {};
  }
}

async function writeAppSettings(settings: AppSettings): Promise<void> {
  try {
    await writeFile(settingsFilePath(), JSON.stringify(settings, null, 2), "utf-8");
  } catch (err) {
    logLine(`[settings] failed to write settings.json (${errorMessage(err)})`);
  }
}

// Kept here, not the renderer: daemon stdout/stderr and restart lifecycle happen in this process, so this is the only place that knows why the WS dropped.
const MAX_LOG_LINES = 4000;
const logBuffer: string[] = [];

function logLine(line: string): void {
  logBuffer.push(`${new Date().toISOString()} ${line}`);
  if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();
}

// No fixed zone/device count here -- the renderer discovers topology from the daemon at runtime, so this shell works unchanged for one fountain or many.

let mainWindow: BrowserWindow | null = null;

// Prevents a double-launched instance from spawning its own daemon and fighting over port 8765 / the same Modbus/Art-Net links.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    show: false,
    backgroundColor: "#1e1e1e", // avoids a white flash before the renderer paints
    autoHideMenuBar: true,
    // Fullscreen by default in a packaged build (dedicated site panel, no chrome for a stray touch to hit) but not in dev; F11 always toggles either way.
    fullscreen: !is.dev,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
    },
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow?.show();
  });

  // Clears the reference immediately: the window is destroyed synchronously here, but before-quit's graceful shutdown can still be mid-flight, and code checking `if (mainWindow)` during that gap would otherwise throw "Object has been destroyed".
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Bound at webContents level, not a renderer keydown handler, so F11 works regardless of what element has focus.
  mainWindow.webContents.on("before-input-event", (_event, input) => {
    if (input.type === "keyDown" && input.key === "F11") {
      mainWindow?.setFullScreen(!mainWindow.isFullScreen());
    }
  });

  // Restricted to http/https: window.open()'s URL can be built from daemon-supplied data, and without this check shell.openExternal would hand any scheme (file://, a custom handler) straight to the OS.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    try {
      const url = new URL(details.url);
      if (url.protocol === "http:" || url.protocol === "https:") {
        void shell.openExternal(details.url);
      }
    } catch {
      // Malformed URL -- nothing to open, just deny below.
    }
    return { action: "deny" };
  });

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    void mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

// Spawns fountain-daemon and restarts it with backoff, giving up after a few tries rather than restart-looping forever on a real bug.

const DAEMON_HEALTH_URL = "http://127.0.0.1:8765/health";
const MAX_DAEMON_RESTART_ATTEMPTS = 5;
const DAEMON_HEALTHY_RESET_DELAY_MS = 30_000;

let daemonProcess: ChildProcess | null = null;
let daemonRestartAttempts = 0;
let shuttingDown = false;

// Mirrors wsClient.ts's ConnectionStatus pattern: last-known value kept here plus a push on every change, so a subscriber never has to guess whether it missed one.
export type DaemonStatus =
  | { phase: "starting" }
  | { phase: "running" }
  | { phase: "restarting"; attempt: number; maxAttempts: number }
  | { phase: "failed"; maxAttempts: number };

let daemonStatus: DaemonStatus = { phase: "starting" };

function setDaemonStatus(status: DaemonStatus): void {
  daemonStatus = status;
  mainWindow?.webContents.send("daemon-status", status);
}

ipcMain.handle("get-daemon-status", () => daemonStatus);

ipcMain.handle("export-logs", async () => {
  if (!mainWindow) return { ok: false, error: "no window" };
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Export Logs",
    defaultPath: `fountain-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`,
    filters: [{ name: "Text", extensions: ["txt"] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, error: null }; // cancelled, not a failure
  try {
    await writeFile(result.filePath, logBuffer.join("\n") + "\n", "utf-8");
    return { ok: true, path: result.filePath };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
});

interface DaemonLaunch {
  command: string;
  args: string[];
  cwd: string;
}

function resolveDaemonPaths(): DaemonLaunch {
  // Packaged build ships a frozen fountain-daemon.exe (electron-builder extraResource) so no Python/.venv needs to exist on the target machine.
  if (app.isPackaged) {
    const exePath = join(process.resourcesPath, "fountain-daemon", "fountain-daemon.exe");
    // cwd is userData, not the exe's resource directory: NSIS installs under Program Files, which isn't writable by the operator, and the daemon writes to `data/` under its cwd (persistence.py's DATA_DIR).
    return { command: exePath, args: [], cwd: app.getPath("userData") };
  }

  // __dirname, not app.getAppPath(): the latter walks up to the nearest package.json, which can resolve to the wrong directory when launching built output directly.
  const daemonDir = resolve(__dirname, "..", "..", "..", "fountain-daemon");
  const python = join(daemonDir, ".venv", "Scripts", "python.exe");
  return { command: python, args: ["-m", "app.main"], cwd: daemonDir };
}

// Matches the folder persistence.py's resolve_music_path treats a relative music_file as relative to.
function resolveScenariosDir(): string {
  return join(resolveDaemonPaths().cwd, "data", "scenarios");
}

ipcMain.handle("select-music-file", async () => {
  if (!mainWindow) return null;
  const scenariosDir = resolveScenariosDir();
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose Music File",
    defaultPath: scenariosDir,
    properties: ["openFile"],
    filters: [
      { name: "Audio", extensions: ["mp3", "wav", "ogg", "m4a", "flac"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const picked = result.filePaths[0];
  const relativeToScenarios = relative(scenariosDir, picked);
  // Stores the portable relative form when inside scenarios/; the isAbsolute check catches Windows cross-drive paths, where relative() returns an absolute path instead of "..".
  const isInsideScenarios = !relativeToScenarios.startsWith("..") && !isAbsolute(relativeToScenarios);
  return isInsideScenarios ? relativeToScenarios : picked;
});

async function isDaemonAlreadyRunning(): Promise<boolean> {
  try {
    const res = await fetch(DAEMON_HEALTH_URL, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function startDaemon(): Promise<void> {
  if (shuttingDown) return;

  // Someone may have started it by hand -- don't spawn a second one fighting for the port.
  if (await isDaemonAlreadyRunning()) {
    logLine("[daemon] already running (started outside this app) -- not spawning another");
    setDaemonStatus({ phase: "running" });
    return;
  }

  const { command, args, cwd } = resolveDaemonPaths();
  logLine(`[daemon] starting: ${command} ${args.join(" ")} (cwd=${cwd})`);

  const proc = spawn(command, args, { cwd, stdio: "pipe" });
  daemonProcess = proc;

  proc.stdout?.on("data", (chunk: Buffer) => logLine(`[daemon] ${chunk.toString().trimEnd()}`));
  proc.stderr?.on("data", (chunk: Buffer) => logLine(`[daemon] ${chunk.toString().trimEnd()}`));

  proc.on("error", (err) => {
    logLine(`[daemon] failed to start: ${err.message}`);
  });

  proc.on("spawn", () => {
    setDaemonStatus({ phase: "running" });
    // Forgives earlier restart attempts once running long enough, so a rare crash after hours of uptime doesn't inherit an old backoff streak.
    const resetTimer = setTimeout(() => {
      daemonRestartAttempts = 0;
    }, DAEMON_HEALTHY_RESET_DELAY_MS);
    proc.once("exit", () => clearTimeout(resetTimer));
  });

  proc.on("exit", (code) => {
    logLine(`[daemon] exited with code ${code}`);
    daemonProcess = null;
    if (shuttingDown) return;

    daemonRestartAttempts += 1;
    if (daemonRestartAttempts > MAX_DAEMON_RESTART_ATTEMPTS) {
      // Restarts happen after the original launch, so total launches is MAX+1 -- said explicitly so the log doesn't undercount by one.
      logLine(
        `[daemon] gave up after ${MAX_DAEMON_RESTART_ATTEMPTS} restart attempts ` +
          `(${MAX_DAEMON_RESTART_ATTEMPTS + 1} total launches) -- ` +
          `run it manually (${command} ${args.join(" ")} in ${cwd}) to see the actual error`,
      );
      setDaemonStatus({ phase: "failed", maxAttempts: MAX_DAEMON_RESTART_ATTEMPTS });
      return;
    }
    setDaemonStatus({ phase: "restarting", attempt: daemonRestartAttempts, maxAttempts: MAX_DAEMON_RESTART_ATTEMPTS });
    const delay = Math.min(1000 * 2 ** daemonRestartAttempts, 15_000);
    setTimeout(() => void startDaemon(), delay);
  });
}

function stopDaemon(): void {
  if (daemonProcess) {
    daemonProcess.kill();
    daemonProcess = null;
  }
}

const DAEMON_SHUTDOWN_TIMEOUT_MS = 3000;

// Asks the daemon over HTTP to stop hardware first, since on Windows Python's asyncio signal handlers aren't guaranteed to see kill() in time to run lifespan's shutdown cleanup (main.py's POST /shutdown) -- otherwise an active valve/motor/light could be left running.
async function stopDaemonGracefully(): Promise<void> {
  if (!daemonProcess) return;
  try {
    await fetch(DAEMON_HEALTH_URL.replace("/health", "/shutdown"), {
      method: "POST",
      signal: AbortSignal.timeout(DAEMON_SHUTDOWN_TIMEOUT_MS),
    });
  } catch (err) {
    logLine(`[daemon] graceful shutdown request failed (${errorMessage(err)}) -- killing directly`);
  }
  stopDaemon();
}

// Packaged build only, and applies once: autoLaunchDefaultApplied stops this from silently re-enabling itself after an operator deliberately turns it off in Settings.
async function configureAutoLaunch(): Promise<void> {
  if (is.dev) return;
  const settings = await readAppSettings();
  if (settings.autoLaunchDefaultApplied) return;
  app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
  await writeAppSettings({ ...settings, autoLaunchDefaultApplied: true });
}

// `supported: false` in dev, since process.execPath there is the dev Electron binary itself -- registering it as a login item would launch node_modules/electron.exe with no arguments on every boot.
ipcMain.handle("get-auto-launch", () => ({
  enabled: app.getLoginItemSettings().openAtLogin,
  supported: !is.dev,
}));

ipcMain.handle("set-auto-launch", async (_event, enabled: boolean) => {
  if (is.dev) return;
  app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath });
  // Marks the default as already applied so it never overrides this explicit choice later.
  await writeAppSettings({ ...(await readAppSettings()), autoLaunchDefaultApplied: true });
});

// Guards against whenReady resolving before an already-called app.quit() (second-instance handoff) takes effect.
if (gotSingleInstanceLock) {
  void app.whenReady().then(() => {
    createWindow();
    void configureAutoLaunch();
    void startDaemon();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

// Deferred quit: intercepts close, waits for hardware-safe shutdown, then calls app.quit() itself, which re-fires this event -- shuttingDown guards against looping on that second pass.
app.on("before-quit", (event) => {
  if (shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  void stopDaemonGracefully().finally(() => app.quit());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
