import { useRef, useState } from "react";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { StartupSplash } from "./StartupSplash";
import { EmergencyStopButton } from "./EmergencyStopButton";
import { ErrorBoundary } from "./ErrorBoundary";
import { useConnectionStore } from "../../store/connectionStore";
import { useDaemonStatusStore } from "../../store/daemonStatusStore";
import { ScenePreview } from "../preview3d/ScenePreview";
import { DeviceConfigPanel } from "../devices/DeviceConfigPanel";
import { PlaybackPanel } from "../playback/PlaybackPanel";
import { TimelinePanel } from "../timeline/TimelinePanel";
import { SchedulePanel } from "../schedule/SchedulePanel";
import { AuditLogPanel } from "../log/AuditLogPanel";
import { SettingsPanel } from "../settings/SettingsPanel";
import { ContextMenu } from "../timeline/ContextMenu";

type View = "timeline" | "playback" | "preview" | "devices" | "schedule" | "log" | "settings";

/**
 * VS Code-shaped shell: menu/toolbar row, sidebar + main content, status bar.
 * Tabs in the header, no router -- not worth a routing dependency for this
 * many screens. Emergency Stop lives in the header, not inside Playback, so
 * it's reachable no matter which tab is open.
 */
const SIDEBAR_COLLAPSED_KEY = "sidebarCollapsed";

export function AppShell(): JSX.Element {
  // Only ever true before the app's very first successful connection --
  // see connectionStore's `everConnected` and StartupSplash's own comment
  // for why a later reconnect (daemon restart mid-show) must NOT bring
  // this back.
  const everConnected = useConnectionStore((s) => s.everConnected);
  const daemonFailed = useDaemonStatusStore((s) => s.status.phase === "failed");
  const showStartupSplash = !everConnected && !daemonFailed;

  const [view, setView] = useState<View>("timeline");
  // The app menu (currently just "Settings") -- tucked behind the
  // "Fountain Control" button rather than sitting in the tab row as its
  // own tab, the same way a desktop app's own preferences live behind a
  // File/app menu rather than as a permanent tab next to its documents.
  // null when closed; the button's own position when open, so the menu
  // opens right under it regardless of window width.
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  function toggleMenu(): void {
    if (menuAnchor) {
      setMenuAnchor(null);
      return;
    }
    const rect = menuButtonRef.current?.getBoundingClientRect();
    if (rect) setMenuAnchor({ x: rect.left, y: rect.bottom + 4 });
  }

  // Remembered across restarts -- once someone hides the zones list to get
  // the width back for a wide Timeline grid, re-showing it on every launch
  // would defeat the point.
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });

  function toggleSidebar(): void {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // Purely a remembered UI preference -- fine to lose if storage is unavailable.
      }
      return next;
    });
  }

  return (
    <div className="flex h-screen flex-col">
      {/* Overlaid, not rendered instead of everything below -- the whole
          tab tree stays mounted underneath so its own data (zones,
          scenarios, schedule) is already loading in the background and
          ready the instant this disappears, matching "connect in the
          background" rather than making the operator wait twice. */}
      {showStartupSplash && <StartupSplash />}
      <header className="flex h-row shrink-0 items-center gap-md border-b border-border bg-bg-surface1 px-md text-sm text-text-secondary">
        <button
          ref={menuButtonRef}
          onClick={toggleMenu}
          className={`mr-md flex items-center gap-1 rounded-control px-sm py-1 font-medium ${
            view === "settings" || menuAnchor ? "bg-bg-surface3 text-text-primary" : "text-text-secondary hover:bg-bg-surface2 hover:text-text-primary"
          }`}
        >
          Fountain Control
          {/* Small enough to read as "this opens something" without
              becoming a second focal point next to the app name --
              text-text-muted rather than inheriting the button's own
              (sometimes highlighted) color. Flips to point up while the
              menu is open, the usual dropdown convention. */}
          <span className={`text-[10px] text-text-muted transition-transform ${menuAnchor ? "rotate-180" : ""}`}>▾</span>
        </button>
        <ViewTab label="Timeline" active={view === "timeline"} onClick={() => setView("timeline")} />
        <ViewTab label="Playback" active={view === "playback"} onClick={() => setView("playback")} />
        <ViewTab label="Devices" active={view === "devices"} onClick={() => setView("devices")} />
        <ViewTab label="Preview" active={view === "preview"} onClick={() => setView("preview")} />
        <ViewTab label="Schedule" active={view === "schedule"} onClick={() => setView("schedule")} />
        <ViewTab label="Log" active={view === "log"} onClick={() => setView("log")} />
        <div className="flex-1" />
        <EmergencyStopButton />
      </header>

      {menuAnchor && (
        <ContextMenu
          x={menuAnchor.x}
          y={menuAnchor.y}
          onClose={() => setMenuAnchor(null)}
          minWidthClassName="min-w-28"
          sections={[[{ label: "Settings", onClick: () => setView("settings") }]]}
        />
      )}

      <div className="flex min-h-0 flex-1">
        <Sidebar collapsed={sidebarCollapsed} onToggleCollapsed={toggleSidebar} />
        <main className="flex min-w-0 flex-1 flex-col">
          {/* Scoped to just the active tab's content, not the whole AppShell
              (see App.tsx for that outer, last-resort boundary): a render
              crash in the Timeline's scenario data or a driver's SchemaForm
              must not take the header down with it -- Emergency Stop and the
              connection status in StatusBar have to stay clickable/visible
              through exactly the kind of crash this exists to catch. Keyed
              on `view` so switching tabs after a crash remounts fresh
              instead of re-rendering into the same crashed boundary. */}
          <ErrorBoundary key={view}>
            {view === "devices" && <DeviceConfigPanel />}
            {view === "playback" && <PlaybackPanel />}
            {view === "timeline" && <TimelinePanel />}
            {view === "preview" && <ScenePreview />}
            {view === "schedule" && <SchedulePanel />}
            {view === "log" && <AuditLogPanel />}
            {view === "settings" && <SettingsPanel />}
          </ErrorBoundary>
        </main>
      </div>

      <StatusBar />
    </div>
  );
}

function ViewTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`border-b-2 px-xs py-1 ${
        active ? "border-accent text-text-primary" : "border-transparent text-text-muted hover:text-text-secondary"
      }`}
    >
      {label}
    </button>
  );
}
