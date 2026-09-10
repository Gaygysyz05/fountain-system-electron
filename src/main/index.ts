import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { isAbsolute, join, relative, resolve } from "path";
import { spawn, type ChildProcess } from "child_process";
import { writeFile, readFile } from "fs/promises";
import { is } from "@electron-toolkit/utils";

// -- app settings (this shell's own preferences, not the daemon's hardware
// config) ---------------------------------------------------------------
//
// One small JSON file under userData -- not worth a dependency for a
// single boolean today. Currently holds only whether the "start
// automatically" default (below) has already been applied once; the
// Settings screen's own reads/writes of the actual login-item state go
// straight through app.getLoginItemSettings()/setLoginItemSettings(),
// which is ALREADY the persisted, OS-level source of truth for that --
// duplicating it into this file would just be a second copy that could
// drift from what Windows actually has registered.
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
    logLine(`[settings] failed to write settings.json (${err instanceof Error ? err.message : String(err)})`);
  }
}

// -- log ring buffer -------------------------------------------------------
//
// Every [daemon] line already went to console.log/console.error, which is
// fine for a developer running `electron-vite dev` in a terminal but
// invisible to an operator on a site panel -- there's no terminal to look
// at. Kept here (not in the renderer) because the daemon's own stdout/
// stderr, spawn/restart lifecycle, and any daemon-unreachable state all
// happen in THIS process; the renderer only ever sees the WS connection
// drop, not why.
const MAX_LOG_LINES = 4000;
const logBuffer: string[] = [];

function logLine(line: string): void {
  logBuffer.push(`${new Date().toISOString()} ${line}`);
  if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();
}

// One window, no fixed zone/device count baked in anywhere here -- the
// renderer discovers everything (zones, devices, scenarios) from the daemon
// over the WebSocket at runtime. See the Step 2/3 discussion: this app must
// work identically for one fountain or many, so the shell has nothing to
// know about topology.

let mainWindow: BrowserWindow | null = null;

// A site panel can get double-launched (a stray desktop-icon double-click,
// the auto-launch entry racing a manual start after a reboot) -- without
// this, the second instance would spawn its OWN daemon child process too
// (isDaemonAlreadyRunning's health-check race means it isn't guaranteed to
// see the first instance's daemon in time), fighting over port 8765 and
// the same Modbus/Art-Net links. requestSingleInstanceLock() makes the
// second launch hand off to the first and exit immediately instead.
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
    // Fullscreen by default for a packaged build (a dedicated site panel --
    // no window chrome, nothing for a stray touch/click to hit outside the
    // app) but not while iterating with `electron-vite dev`, where it would
    // just get in the way. F11 (below) toggles either way, so a site
    // install is never actually stuck fullscreen.
    fullscreen: !is.dev,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
    },
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow?.show();
  });

  // Without this, `mainWindow` keeps pointing at an already-destroyed
  // BrowserWindow once the OS close button (or Alt+F4) fires -- the
  // window itself is destroyed synchronously, but before-quit's graceful
  // daemon shutdown can still be mid-flight for up to
  // DAEMON_SHUTDOWN_TIMEOUT_MS afterward. Any code that runs during that
  // gap and checks `if (mainWindow)` (second-instance's focus/restore,
  // setDaemonStatus's webContents.send) would see a non-null but already-
  // destroyed reference and throw "Object has been destroyed" instead of
  // just skipping the no-longer-possible UI update.
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // F11 toggles fullscreen -- the standard OS convention for "let me out of
  // this", which a fullscreen kiosk-style panel otherwise has no window
  // border to grab for. Bound at the webContents level (before-input-event)
  // rather than a renderer keydown handler so it works regardless of what
  // element currently has focus.
  mainWindow.webContents.on("before-input-event", (_event, input) => {
    if (input.type === "keyDown" && input.key === "F11") {
      mainWindow?.setFullScreen(!mainWindow.isFullScreen());
    }
  });

  // Keep external links (if any ever appear, e.g. a "docs" link) in the
  // system browser instead of navigating this Electron window to them.
  // Restricted to http/https: window.open() is reachable from renderer code
  // with a URL that isn't necessarily a hardcoded string (e.g. built from a
  // driver's display_name or a device_id, both ultimately daemon-supplied)
  // -- without this check, shell.openExternal would hand any scheme
  // straight to the OS, including file:// or a custom protocol handler.
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

// -- daemon process management -------------------------------------------------
//
// Removes the "two terminals" friction: previously the operator had to start
// fountain-daemon by hand in its own terminal before this app was any use.
// Electron now spawns it, restarts it with backoff if it dies, and gives up
// after a few tries rather than restart-looping forever (a crash that keeps
// happening is a bug to go look at, not something to paper over).
//
// Dev-only for now: this assumes fountain-daemon is a sibling directory with
// its own persistent venv (`fountain-daemon/.venv`), which is what exists on
// this dev machine today. Packaging this daemon into a distributable build
// (bundling a frozen interpreter, or a PyInstaller-built exe shipped as an
// Electron extraResource) is a separate concern for actual site deployment,
// not solved here.

const DAEMON_HEALTH_URL = "http://127.0.0.1:8765/health";
const MAX_DAEMON_RESTART_ATTEMPTS = 5;
const DAEMON_HEALTHY_RESET_DELAY_MS = 30_000;

let daemonProcess: ChildProcess | null = null;
let daemonRestartAttempts = 0;
let shuttingDown = false;

// -- daemon status, surfaced to the renderer --------------------------------
//
// Previously this whole lifecycle (starting/restarting/gave-up) only ever
// went to console.log in this process -- an operator on a site panel just
// saw the WS connection drop with zero indication of whether it's about to
// come back on its own, or needs someone to go look at it. Mirrors
// wsClient.ts's ConnectionStatus pattern on the renderer side: last-known
// value kept here (getDaemonStatus), plus a push on every change
// (daemon-status), so a subscriber never has to guess whether it missed one.
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
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

interface DaemonLaunch {
  command: string;
  args: string[];
  cwd: string;
}

function resolveDaemonPaths(): DaemonLaunch {
  // A packaged build ships fountain-daemon.spec's frozen fountain-daemon.exe
  // as an electron-builder extraResource (see electron-builder.yml) --
  // no Python interpreter or `.venv` needs to exist on the target machine
  // at all, which is the whole point of the .exe over spawning
  // `python -m app.main` the way dev mode still does below.
  if (app.isPackaged) {
    const exePath = join(process.resourcesPath, "fountain-daemon", "fountain-daemon.exe");
    // NOT the exe's own resource directory: on a standard install (NSIS
    // defaults to Program Files) that tree is owned by the installer, not
    // the logged-in operator, and every ADD_DEVICE/scenario Save the daemon
    // does is a write to `data/` under its cwd (see persistence.py's
    // DATA_DIR) -- writing there fails with a permissions error the
    // operator has no way to diagnose from a control panel with no
    // terminal. userData (%APPDATA%/fountain-hmi on Windows) is always
    // writable by whichever account is running the app, survives an
    // upgrade/reinstall the same way an installed app's settings would,
    // and is the same per-user directory Electron itself already uses for
    // its own state.
    return { command: exePath, args: [], cwd: app.getPath("userData") };
  }

  // __dirname, not app.getAppPath() -- the latter returns the directory of
  // the nearest package.json walking up from the entry point, which is
  // fountain-hmi's own root when launched via `electron-vite dev` (its dev
  // server runs from there) but falls back to the entry SCRIPT's own
  // directory (out/main) when there's no package.json to find there, e.g.
  // launching the built output directly (`electron out/main/index.js`) --
  // silently pointing this at out/fountain-daemon, which doesn't exist.
  // __dirname is main/index.js's own compiled location in both cases:
  // out/main, three levels below the fountain-hmi/fountain-daemon sibling pair.
  const daemonDir = resolve(__dirname, "..", "..", "..", "fountain-daemon");
  const python = join(daemonDir, ".venv", "Scripts", "python.exe");
  return { command: python, args: ["-m", "app.main"], cwd: daemonDir };
}

// Same folder persistence.py's resolve_music_path treats a relative
// music_file as relative to -- so a file picked from here needs no typed
// path at all, and one picked from elsewhere still works (as an absolute
// path), just isn't portable if the project moves to another machine.
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
  // Inside the scenarios folder -- store the portable relative form (what
  // resolve_music_path expects); anywhere else (or on Windows, a different
  // drive -- relative() then returns an absolute path, hence the isAbsolute
  // check), the absolute path still resolves fine, it just won't survive
  // moving the project to another machine.
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

  // Someone may have started it by hand (as the operator was told to do
  // before this existed) -- don't spawn a second one fighting for the port.
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
    // Ran long enough to count as healthy -- forgive earlier restart attempts
    // so a rare crash after hours of uptime doesn't inherit an old backoff streak.
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
      // MAX_DAEMON_RESTART_ATTEMPTS restarts happen AFTER the original
      // launch, so the daemon was actually spawned MAX+1 times total by
      // the time this fires -- said explicitly here so the log's own
      // count doesn't undercount by one against what actually happened.
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

// daemonProcess.kill() alone used to be the whole shutdown path -- but on
// Windows, Node delivers it in a way Python's asyncio signal handlers
// aren't guaranteed to see in time to run lifespan's shutdown cleanup
// (see main.py's POST /shutdown docstring), so a valve/motor/light active
// when the operator just closes the window could be abandoned running.
// This asks the daemon over HTTP to stop hardware FIRST -- something under
// its own control regardless of how the OS handles the process exit --
// then kills the process either way (a daemon that's already dead or
// unreachable just hits the catch and falls through to the same kill()).
async function stopDaemonGracefully(): Promise<void> {
  if (!daemonProcess) return;
  try {
    await fetch(DAEMON_HEALTH_URL.replace("/health", "/shutdown"), {
      method: "POST",
      signal: AbortSignal.timeout(DAEMON_SHUTDOWN_TIMEOUT_MS),
    });
  } catch (err) {
    logLine(`[daemon] graceful shutdown request failed (${err instanceof Error ? err.message : String(err)}) -- killing directly`);
  }
  stopDaemon();
}

// Packaged build only -- never touch the developer's own login items while
// iterating via `electron-vite dev`. A power flicker or a Windows Update
// reboot on the site PC would otherwise leave the fountain control panel
// closed until someone walks over and starts it by hand -- so a fresh
// install defaults to on. Only a DEFAULT, though: it must apply once and
// then get out of the way, or an operator who deliberately turns this off
// in Settings (below) would find it silently switched back on the very
// next launch. autoLaunchDefaultApplied is the marker that's already happened.
async function configureAutoLaunch(): Promise<void> {
  if (is.dev) return;
  const settings = await readAppSettings();
  if (settings.autoLaunchDefaultApplied) return;
  app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
  await writeAppSettings({ ...settings, autoLaunchDefaultApplied: true });
}

// Settings screen's auto-launch toggle -- app.getLoginItemSettings() IS the
// persisted state (Windows' own registered startup entry), so "read" just
// asks Electron, no local copy to keep in sync. Also reports `supported`:
// in `electron-vite dev`, process.execPath is the dev Electron binary
// itself, not this app -- registering THAT as a login item would silently
// launch node_modules/electron.exe with no arguments on every boot, so the
// write side no-ops and the renderer disables the toggle instead.
ipcMain.handle("get-auto-launch", () => ({
  enabled: app.getLoginItemSettings().openAtLogin,
  supported: !is.dev,
}));

ipcMain.handle("set-auto-launch", async (_event, enabled: boolean) => {
  if (is.dev) return;
  app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath });
  // The operator has now made an explicit choice -- the on-by-default
  // above must never override it again, whichever way they set it.
  await writeAppSettings({ ...(await readAppSettings()), autoLaunchDefaultApplied: true });
});

// gotSingleInstanceLock is false only when app.quit() was already called
// above (a second launch handing off to the first) -- whenReady would still
// resolve before that quit takes effect, so guard here too rather than
// spawn a second daemon and a window that's about to disappear anyway.
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

// Deferred quit: the first before-quit intercepts the close, waits for the
// hardware-safe shutdown above to finish (or time out), then calls
// app.quit() itself -- which re-fires this same event. shuttingDown is
// already true by then, so the second pass falls through and the app
// actually exits, instead of looping.
app.on("before-quit", (event) => {
  if (shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  void stopDaemonGracefully().finally(() => app.quit());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
