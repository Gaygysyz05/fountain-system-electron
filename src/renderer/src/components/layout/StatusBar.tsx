import { useConnectionStore } from "../../store/connectionStore";
import { useConfigStore } from "../../store/configStore";

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
export function StatusBar(): JSX.Element {
  const status = useConnectionStore((s) => s.status);
  const lastError = useConnectionStore((s) => s.lastError);
  const configuredZones = useConfigStore((s) => s.zones);
  const zoneCount = configuredZones.length;
  const deviceCount = configuredZones.reduce((sum, z) => sum + z.devices.length, 0);

  const statusDotColor =
    status === "open" ? "bg-success" : status === "connecting" ? "bg-warning" : "bg-danger";
  const statusLabel = status === "open" ? "Connected" : status === "connecting" ? "Connecting…" : "Disconnected";

  return (
    <footer className="flex h-row items-center justify-between border-t border-border bg-bg-surface1 px-md text-sm text-text-secondary">
      <div className="flex items-center gap-lg">
        <span className="flex items-center gap-xs">
          <span className={`h-2 w-2 rounded-full ${statusDotColor}`} />
          {statusLabel}
        </span>
        <span>Zones: {zoneCount}</span>
        <span>Devices: {deviceCount}</span>
      </div>
      {lastError && <span className="truncate text-danger">{lastError}</span>}
    </footer>
  );
}
