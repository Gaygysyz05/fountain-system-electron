import { useState } from "react";
import { useConnectionStore } from "../../store/connectionStore";
import { useConfigStore } from "../../store/configStore";
import { useDaemonStatusStore } from "../../store/daemonStatusStore";

/**
 * The "live metrics strip" pattern from the original PyQt6 apps' status bars
 * (pipe-delimited counts, refreshed live) is worth keeping -- it's the one
 * thing that already scaled fine regardless of zone/device count, since it
 * was always just `len(...)` of whatever collection existed.
 *
 * Counts come from configStore (actual configuration), not zonesStore (live
 * playback status) -- the latter only has entries for zones that have
 * played something this session, so it read "Zones: 0" even with a fully
 * configured zone sitting right there on the Devices/Scenes tabs. See
 * Sidebar.tsx for the same fix.
 */
/**
 * A dropped WS connection could mean either "the daemon is fine, just a
 * network blip" or "the daemon child process is restarting/gave up
 * entirely" -- indistinguishable from the WS status dot alone. This turns
 * daemonStatusStore's phase into that missing context, shown only when
 * there's something to say (anything other than the steady-state "running"
 * -- see daemonStatusStore.ts for what pushes phase changes here).
 */
function daemonStatusLabel(status: DaemonStatus): string | null {
  switch (status.phase) {
    case "starting":
      return "Daemon starting…";
    case "restarting":
      return `Daemon restarting (attempt ${status.attempt}/${status.maxAttempts})…`;
    case "failed":
      return `Daemon failed to start after ${status.maxAttempts} attempts -- export logs and check it manually`;
    case "running":
      return null;
  }
}

export function StatusBar(): JSX.Element {
  const status = useConnectionStore((s) => s.status);
  const lastError = useConnectionStore((s) => s.lastError);
  const configuredZones = useConfigStore((s) => s.zones);
  const daemonStatus = useDaemonStatusStore((s) => s.status);
  const zoneCount = configuredZones.length;
  const deviceCount = configuredZones.reduce((sum, z) => sum + z.devices.length, 0);
  const [exportMessage, setExportMessage] = useState<string | null>(null);

  const statusDotColor =
    status === "open" ? "bg-success" : status === "connecting" ? "bg-warning" : "bg-danger";
  const statusLabel = status === "open" ? "Connected" : status === "connecting" ? "Connecting…" : "Disconnected";
  const daemonLabel = daemonStatusLabel(daemonStatus);

  async function handleExportLogs(): Promise<void> {
    const result = await window.electron.exportLogs();
    if (result.error) {
      setExportMessage(`Export failed: ${result.error}`);
    } else if (result.path) {
      setExportMessage(`Saved to ${result.path}`);
    } else {
      return; // cancelled -- nothing to say
    }
    setTimeout(() => setExportMessage(null), 5000);
  }

  return (
    <footer className="flex h-row items-center justify-between border-t border-border bg-bg-surface1 px-md text-sm text-text-secondary">
      <div className="flex items-center gap-lg">
        <span className="flex items-center gap-xs">
          <span className={`h-2 w-2 rounded-full ${statusDotColor}`} />
          {statusLabel}
        </span>
        <span>Zones: {zoneCount}</span>
        <span>Devices: {deviceCount}</span>
        {daemonLabel && (
          <span className={daemonStatus.phase === "failed" ? "text-danger" : "text-warning"}>{daemonLabel}</span>
        )}
      </div>
      <div className="flex items-center gap-md">
        {exportMessage && <span className="truncate text-text-muted">{exportMessage}</span>}
        {lastError && <span className="truncate text-danger">{lastError}</span>}
        <button onClick={() => void handleExportLogs()} className="text-text-muted hover:text-text-secondary" title="Save daemon/app logs to a file for support">
          Export logs
        </button>
      </div>
    </footer>
  );
}
