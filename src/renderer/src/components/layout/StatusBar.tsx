import { useState } from "react";
import { useConnectionStore } from "../../store/connectionStore";
import { useConfigStore } from "../../store/configStore";
import { useDaemonStatusStore } from "../../store/daemonStatusStore";
import { useZonesStore } from "../../store/zonesStore";

/** Counts come from configStore (actual config), not zonesStore (live playback status) -- the latter only has entries for zones played this session, so it undercounts (e.g. "Zones: 0") for a configured-but-unplayed zone; see Sidebar.tsx for the same fix. */
/** WS connection status alone can't distinguish a network blip from the daemon restarting/failing -- this surfaces daemonStatusStore's phase for that context, shown only when it's not the steady-state "running" (see daemonStatusStore.ts). */
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
  // WS "open" (the TCP socket) doesn't mean the daemon's event loop is alive -- a deadlocked daemon can leave the socket open with nothing coming through (see zonesStore.ts's staleness watcher, which sets this).
  const stale = useZonesStore((s) => s.stale);
  const zoneCount = configuredZones.length;
  const deviceCount = configuredZones.reduce((sum, z) => sum + z.devices.length, 0);
  const [exportMessage, setExportMessage] = useState<string | null>(null);

  const statusDotColor =
    status === "open" ? (stale ? "bg-danger" : "bg-success") : status === "connecting" ? "bg-warning" : "bg-danger";
  const statusLabel =
    status === "open" ? (stale ? "Stalled" : "Connected") : status === "connecting" ? "Connecting…" : "Disconnected";
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
        <span
          className="flex items-center gap-xs"
          title={stale ? "The connection is open but nothing has come through it in a while -- the daemon may be stuck. Restarting it is the fastest fix." : undefined}
        >
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
