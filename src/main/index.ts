import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from "electron";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "path";
import { spawn, type ChildProcess } from "child_process";
import { writeFile, readFile, readdir, stat, mkdir, copyFile, rm } from "fs/promises";
import { pathToFileURL } from "url";
import { is } from "@electron-toolkit/utils";

// Own copy rather than importing the renderer's lib/errors.ts -- separate process, separate module graph/build target.
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Must run before app "ready" fires (Electron's requirement) -- lets fountain-model:// behave like a normal origin (fetch, relative-URL resolution, CORS) so GLTFLoader's resource loading for an imported .gltf's external buffers/textures works the same as the bundled default's relative-path loading. See the "custom 3D model import" section below for what serves it.
protocol.registerSchemesAsPrivileged([
  { scheme: "fountain-model", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

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

// Scenarios otherwise only round-trip through the daemon's own data/scenarios/*.json -- these let an operator pull one out to an arbitrary location (backup, USB, another install) and back in, the same native-dialog pattern as export-logs above. Content is opaque JSON text end to end: the renderer owns the ScenarioFile shape (see lib/scenario.ts), this process just moves bytes.
ipcMain.handle("export-scenario-file", async (_event, defaultName: string, content: string) => {
  if (!mainWindow) return { ok: false, error: "no window" };
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Export Scenario",
    defaultPath: defaultName,
    filters: [{ name: "Fountain Scenario", extensions: ["json"] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, error: null }; // cancelled, not a failure
  try {
    await writeFile(result.filePath, content, "utf-8");
    return { ok: true, path: result.filePath };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
});

ipcMain.handle("import-scenario-file", async () => {
  if (!mainWindow) return { ok: false, error: "no window" };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Import Scenario",
    properties: ["openFile"],
    filters: [
      { name: "Fountain Scenario", extensions: ["json"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return { ok: false, error: null };
  try {
    const content = await readFile(result.filePaths[0], "utf-8");
    return { ok: true, path: result.filePaths[0], content };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
});

// -- custom 3D model import ----------------------------------------------------
// Lets an operator swap the fountain preview's model from inside the app (the
// Import button in ScenePreview.tsx) instead of hand-editing a source folder
// that was never wired into the build at all. Stored under userData -- writable
// in both dev and a packaged install, unlike src/renderer/public/models/, which
// ends up inside app.asar (read-only) once packaged -- and served back to the
// renderer over the custom fountain-model:// scheme registered above, since
// fetch() can't read an arbitrary filesystem path directly.

function modelsDir(): string {
  return join(app.getPath("userData"), "models");
}

function modelManifestPath(): string {
  return join(modelsDir(), "manifest.json");
}

interface ModelManifest {
  entry: string; // filename of the model itself, relative to modelsDir() -- "model.glb" or "model.gltf"
}

async function readModelManifest(): Promise<ModelManifest | null> {
  try {
    return JSON.parse(await readFile(modelManifestPath(), "utf-8")) as ModelManifest;
  } catch {
    return null; // no custom model imported yet (or an unreadable manifest) -- caller falls back to the bundled default
  }
}

ipcMain.handle("get-model-info", async () => {
  const manifest = await readModelManifest();
  return manifest ? { hasCustomModel: true, entry: manifest.entry } : { hasCustomModel: false };
});

ipcMain.handle("reset-3d-model", async () => {
  await rm(modelsDir(), { recursive: true, force: true });
});

// A .gltf's mesh/texture data lives in separate files it references by a relative
// "uri" (buffers[].uri, images[].uri) -- a data: URI is already embedded and
// needs no file; anything else must be copied alongside the .gltf or the model
// loads with missing geometry/textures.
function collectGltfDependencyUris(gltfJson: unknown): string[] {
  const data = gltfJson as { buffers?: Array<{ uri?: string }>; images?: Array<{ uri?: string }> };
  const uris: string[] = [];
  for (const entry of [...(data.buffers ?? []), ...(data.images ?? [])]) {
    if (entry.uri && !entry.uri.startsWith("data:")) uris.push(decodeURIComponent(entry.uri));
  }
  return uris;
}

/** Finds the file a .gltf's `uri` actually refers to. Blender names the binary buffer after the
 * .blend/scene rather than the export filename, so a perfectly good export routinely references
 * e.g. "MyProject.bin" while the file saved right next to it is "fountain.bin" -- refusing the
 * import over that naming quirk is a dead end for something nothing is actually wrong with. Falls
 * back through: exact path, case-insensitive filename (Windows exports vs a case-sensitive check),
 * then -- for the buffer specifically -- the only .bin in the folder, which is unambiguous by
 * definition. Returns null only when there genuinely is no candidate. */
async function resolveGltfDependency(sourceDir: string, uri: string): Promise<string | null> {
  const direct = join(sourceDir, uri);
  try {
    await stat(direct); // stat, not readFile: a buffer can be tens of MB and this only asks "is it there"
    return direct;
  } catch {
    // Not at the exact path -- try the fallbacks below.
  }

  const dir = dirname(direct);
  let siblings: string[];
  try {
    siblings = await readdir(dir);
  } catch {
    return null;
  }

  const wanted = basename(uri).toLowerCase();
  const caseInsensitive = siblings.find((f) => f.toLowerCase() === wanted);
  if (caseInsensitive) return join(dir, caseInsensitive);

  if (extname(wanted) === ".bin") {
    const bins = siblings.filter((f) => f.toLowerCase().endsWith(".bin"));
    if (bins.length === 1) return join(dir, bins[0]);
  }
  return null;
}

ipcMain.handle("import-3d-model", async () => {
  if (!mainWindow) return { ok: false, error: "no window" };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Import 3D Model",
    properties: ["openFile"],
    filters: [{ name: "3D Model", extensions: ["glb", "gltf"] }],
  });
  if (result.canceled || result.filePaths.length === 0) return { ok: false, error: null };

  const sourcePath = result.filePaths[0];
  const sourceDir = dirname(sourcePath);
  const isGlb = sourcePath.toLowerCase().endsWith(".glb");
  const entryName = isGlb ? "model.glb" : "model.gltf";

  try {
    let gltfText: string | null = null;
    // uri as written in the .gltf -> the file on disk it actually resolves to (see resolveGltfDependency).
    const dependencies = new Map<string, string>();
    if (!isGlb) {
      gltfText = await readFile(sourcePath, "utf-8");

      // Resolve every referenced file BEFORE touching the currently-active model -- an export that's
      // genuinely missing a piece must not leave the preview broken, it should just refuse and say which.
      for (const uri of collectGltfDependencyUris(JSON.parse(gltfText))) {
        const resolved = await resolveGltfDependency(sourceDir, uri);
        if (!resolved) {
          return { ok: false, error: `This model references "${uri}", and there's no matching file next to the .gltf -- re-export with that file included.` };
        }
        dependencies.set(uri, resolved);
      }
    }

    // Only clears the previous custom model once resolution above has passed.
    await rm(modelsDir(), { recursive: true, force: true });
    await mkdir(modelsDir(), { recursive: true });

    if (isGlb) {
      await copyFile(sourcePath, join(modelsDir(), entryName));
    } else {
      await writeFile(join(modelsDir(), entryName), gltfText ?? "", "utf-8");
      for (const [uri, sourceFile] of dependencies) {
        // Copied under the name the .gltf ASKS for, not the name it happens to have on disk, so the
        // .gltf itself never needs rewriting to match (see resolveGltfDependency's Blender note).
        const destPath = join(modelsDir(), uri);
        await mkdir(dirname(destPath), { recursive: true });
        await copyFile(sourceFile, destPath);
      }
    }

    const manifest: ModelManifest = { entry: entryName };
    await writeFile(modelManifestPath(), JSON.stringify(manifest), "utf-8");
    return { ok: true, entry: entryName };
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

// POST /shutdown awaits the daemon's own _emergency_stop_all_zones() before responding (see main.py),
// which closes every relay channel SEQUENTIALLY per relay board -- one Modbus TCP connection only
// ever has one transaction in flight (see modbus_valve.py's "single writer" consumer). Zones run
// concurrently with each other, but a single large board (up to 256 channels, ModbusValveConfig's
// own schema max) can still take several seconds even when every write succeeds quickly. 15s is
// generous for that healthy case; tune it up further only if a real installation's largest single
// board is bigger than that math comfortably covers. There is no value that also covers a
// GENUINELY unreachable board (each of its writes would burn its own write_timeout before giving up)
// without defeating the point of a bounded shutdown -- that case is expected to hit this timeout and
// fall through to the unconditional kill below, same as before.
const DAEMON_SHUTDOWN_TIMEOUT_MS = 15_000;

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

// Serves userData/models/<path> for fountain-model://current/<path> -- must be registered after "ready" fires (Electron's requirement), before the renderer can possibly request it. net.fetch(file://...) does the actual streaming/MIME-sniffing rather than reading the file by hand.
function registerModelProtocol(): void {
  const modelsRoot = resolve(modelsDir());
  protocol.handle("fountain-model", (request) => {
    const relPath = decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, ""));
    const resolvedPath = resolve(join(modelsRoot, relPath));
    // Guards against a crafted "../.." path escaping userData/models -- same concern as fountain-daemon's resolve_music_path.
    if (resolvedPath !== modelsRoot && resolvedPath !== modelsRoot + sep && !resolvedPath.startsWith(modelsRoot + sep)) {
      return new Response("forbidden", { status: 403 });
    }
    return net.fetch(pathToFileURL(resolvedPath).toString());
  });
}

// Guards against whenReady resolving before an already-called app.quit() (second-instance handoff) takes effect.
if (gotSingleInstanceLock) {
  void app.whenReady().then(() => {
    registerModelProtocol();
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
