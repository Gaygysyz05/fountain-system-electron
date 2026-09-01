import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { isAbsolute, join, relative, resolve } from "path";
import { spawn, type ChildProcess } from "child_process";
import { is } from "@electron-toolkit/utils";

// One window, no fixed zone/device count baked in anywhere here -- the
// renderer discovers everything (zones, devices, scenarios) from the daemon
// over the WebSocket at runtime. See the Step 2/3 discussion: this app must
// work identically for one fountain or many, so the shell has nothing to
// know about topology.

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    show: false,
    backgroundColor: "#1e1e1e", // avoids a white flash before the renderer paints
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
    },
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow?.show();
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

function resolveDaemonPaths(): { cwd: string; python: string } {
  // __dirname, not app.getAppPath() -- the latter returns the directory of
  // the nearest package.json walking up from the entry point, which is
  // fountain-hmi's own root when launched via `electron-vite dev` (its dev
  // server runs from there) but falls back to the entry SCRIPT's own
  // directory (out/main) when there's no package.json to find there, e.g.
  // launching the built output directly (`electron out/main/index.js`, or
  // eventually a packaged build) -- silently pointing this at
  // out/fountain-daemon, which doesn't exist. __dirname is main/index.js's
  // own compiled location in both cases: out/main, three levels below the
  // fountain-hmi/fountain-daemon sibling pair.
  const daemonDir = resolve(__dirname, "..", "..", "..", "fountain-daemon");
  const python = join(daemonDir, ".venv", "Scripts", "python.exe");
  return { cwd: daemonDir, python };
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
    console.log("[daemon] already running (started outside this app) -- not spawning another");
    return;
  }

  const { cwd, python } = resolveDaemonPaths();
  console.log(`[daemon] starting: ${python} -m app.main (cwd=${cwd})`);

  const proc = spawn(python, ["-m", "app.main"], { cwd, stdio: "pipe" });
  daemonProcess = proc;

  proc.stdout?.on("data", (chunk: Buffer) => console.log(`[daemon] ${chunk.toString().trimEnd()}`));
  proc.stderr?.on("data", (chunk: Buffer) => console.error(`[daemon] ${chunk.toString().trimEnd()}`));

  proc.on("error", (err) => {
    console.error("[daemon] failed to start:", err.message);
  });

  proc.on("spawn", () => {
    // Ran long enough to count as healthy -- forgive earlier restart attempts
    // so a rare crash after hours of uptime doesn't inherit an old backoff streak.
    const resetTimer = setTimeout(() => {
      daemonRestartAttempts = 0;
    }, DAEMON_HEALTHY_RESET_DELAY_MS);
    proc.once("exit", () => clearTimeout(resetTimer));
  });

  proc.on("exit", (code) => {
    console.log(`[daemon] exited with code ${code}`);
    daemonProcess = null;
    if (shuttingDown) return;

    daemonRestartAttempts += 1;
    if (daemonRestartAttempts > MAX_DAEMON_RESTART_ATTEMPTS) {
      console.error(
        `[daemon] gave up after ${MAX_DAEMON_RESTART_ATTEMPTS} restart attempts -- ` +
          `run it manually (${python} -m app.main in ${cwd}) to see the actual error`,
      );
      return;
    }
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

void app.whenReady().then(() => {
  createWindow();
  void startDaemon();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  shuttingDown = true;
  stopDaemon();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
