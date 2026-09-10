import { useEffect, useState } from "react";
import { useConfigStore } from "../../store/configStore";
import { useZonesStore } from "../../store/zonesStore";

const STATE_COLOR: Record<string, string> = {
  playing: "bg-success",
  paused: "bg-warning",
  connecting: "bg-warning",
  error: "bg-danger",
  stopped: "bg-text-disabled",
  ready: "bg-text-disabled",
};

/**
 * Zone list, sourced from configStore (GET /zones -- what's actually
 * configured: driver instances + devices), NOT zonesStore (live playback
 * status, which only has an entry once a zone has actually played
 * something this session). Showing "No zones yet" while the Scenes/Devices
 * tabs clearly have a configured zone was a real, confusing bug -- fixed by
 * switching the source of truth here to match what those tabs already use.
 * Live playback state (the colored dot) is still overlaid from zonesStore
 * when available, since that's genuinely live-only information.
 *
 * The ONE place a zone gets selected/created now -- the Devices tab used to
 * keep its own separate zone list right next to this one (same zones,
 * clicking a row in either one had no effect on the other), which was
 * exactly as confusing as it sounds. configStore.selectedZoneId is shared,
 * so picking a zone here is what the Devices tab shows too.
 */
export function Sidebar({
  collapsed,
  onToggleCollapsed,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
}): JSX.Element {
  const configuredZones = useConfigStore((s) => s.zones);
  const loadZones = useConfigStore((s) => s.loadZones);
  const selectedZoneId = useConfigStore((s) => s.selectedZoneId);
  const selectZone = useConfigStore((s) => s.selectZone);
  const renameZone = useConfigStore((s) => s.renameZone);
  const deleteZone = useConfigStore((s) => s.deleteZone);
  const liveZones = useZonesStore((s) => s.zones);

  const [editingZoneId, setEditingZoneId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [newZoneId, setNewZoneId] = useState("");
  const [newZoneName, setNewZoneName] = useState("");

  useEffect(() => {
    void loadZones();
  }, [loadZones]);

  function handleAddZone(): void {
    const id = parseInt(newZoneId, 10);
    if (Number.isNaN(id)) return;

    const existing = configuredZones.find((z) => z.zone_id === id);
    if (existing) {
      // A typo'd ID that happens to match a real, already-configured zone
      // used to silently RENAME that zone to whatever was typed in the
      // Name field here instead of creating anything new -- meaning to add
      // "Zone 5" but fat-fingering "1" clobbered Zone 1's display name
      // with no new zone appearing and nothing telling the operator what
      // actually happened. Select the existing zone instead and say so,
      // rather than guessing a rename was intended.
      const label = existing.name?.trim() ? ` ("${existing.name}")` : "";
      window.alert(`Zone ${id} already exists${label} -- selecting it instead of creating a new one.`);
      selectZone(id);
      setNewZoneId("");
      setNewZoneName("");
      return;
    }

    selectZone(id); // the zone is created lazily on the daemon once a driver instance is added to it
    const name = newZoneName.trim();
    if (name) void renameZone(id, name); // RENAME_ZONE creates the zone runtime immediately, even with 0 devices -- see zone_runtime.get_zone
    setNewZoneId("");
    setNewZoneName("");
  }

  const zoneList = [...configuredZones].sort((a, b) => a.zone_id - b.zone_id);

  function startRename(zoneId: number, currentName: string | null | undefined): void {
    setEditingZoneId(zoneId);
    setEditName(currentName ?? "");
  }

  async function commitRename(zoneId: number): Promise<void> {
    await renameZone(zoneId, editName.trim() || null);
    setEditingZoneId(null);
  }

  async function handleDelete(zone: import("../../lib/protocol").ZoneConfigDto): Promise<void> {
    const label = zone.name?.trim() || `Zone ${zone.zone_id}`;
    const deviceCount = zone.devices.length;
    const warning = deviceCount > 0 ? ` This removes all ${deviceCount} configured device(s) and driver instance(s) in it.` : "";
    if (!window.confirm(`Delete "${label}"?${warning} This can't be undone.`)) return;
    await deleteZone(zone.zone_id);
  }

  // Collapsed to a thin strip rather than gone entirely -- the wide Timeline
  // grids (32 valve channels and up) are the actual reason to reclaim this
  // width, but the toggle to bring it back needs to stay reachable without
  // hunting for a menu.
  if (collapsed) {
    return (
      <aside className="flex w-6 shrink-0 flex-col items-center border-r border-border bg-bg-surface1 py-sm">
        <button onClick={onToggleCollapsed} title="Show zones" className="text-text-muted hover:text-text-primary">
          ▶
        </button>
      </aside>
    );
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-bg-surface1">
      <div className="flex items-center justify-between border-b border-border px-md py-sm text-xs font-medium uppercase tracking-wide text-text-muted">
        <span>Zones</span>
        <button onClick={onToggleCollapsed} title="Hide zones" className="normal-case text-text-muted hover:text-text-primary">
          ◀
        </button>
      </div>

      {zoneList.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-xs px-lg text-center">
          <p className="text-sm text-text-muted">No zones yet</p>
          <p className="text-xs text-text-disabled">Add a driver instance on the Devices tab to create one</p>
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto py-xs">
          {zoneList.map((zone) => {
            const live = liveZones.get(zone.zone_id);
            const label = zone.name?.trim() || `Zone ${zone.zone_id}`;

            if (editingZoneId === zone.zone_id) {
              return (
                <li key={zone.zone_id} className="flex items-center gap-xs px-md py-xs">
                  <input
                    autoFocus
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitRename(zone.zone_id);
                      if (e.key === "Escape") setEditingZoneId(null);
                    }}
                    placeholder={`Zone ${zone.zone_id}`}
                    className="h-input min-w-0 flex-1 rounded-control border border-accent bg-bg-surface3 px-sm text-sm text-text-primary focus:outline-none"
                  />
                  <button onClick={() => void commitRename(zone.zone_id)} title="Save" className="text-xs text-accent hover:text-accent-hover">
                    ✓
                  </button>
                  <button onClick={() => setEditingZoneId(null)} title="Cancel" className="text-xs text-text-muted hover:text-text-secondary">
                    ✕
                  </button>
                </li>
              );
            }

            return (
              <li
                key={zone.zone_id}
                className={`group flex items-center gap-xs px-md py-xs text-sm ${
                  zone.zone_id === selectedZoneId ? "bg-bg-surface3" : "hover:bg-bg-surface2"
                }`}
              >
                <button
                  onClick={() => selectZone(zone.zone_id)}
                  className="flex min-w-0 flex-1 items-center gap-xs text-left"
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${live ? (STATE_COLOR[live.state] ?? "bg-text-disabled") : "bg-text-disabled"}`} />
                  <span className={`min-w-0 flex-1 truncate ${zone.zone_id === selectedZoneId ? "text-text-primary" : ""}`} title={label}>
                    {label}
                  </span>
                </button>
                <span className="whitespace-nowrap text-xs text-text-muted group-hover:hidden">
                  {live ? live.state : `${zone.devices.length} devices`}
                </span>
                <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                  <button
                    onClick={() => startRename(zone.zone_id, zone.name)}
                    title="Rename zone"
                    className="flex h-6 w-6 items-center justify-center rounded-control text-sm text-text-muted hover:bg-bg-surface3 hover:text-text-primary"
                  >
                    ✎
                  </button>
                  <button
                    onClick={() => void handleDelete(zone)}
                    title="Delete zone"
                    className="flex h-6 w-6 items-center justify-center rounded-control text-sm text-text-muted hover:bg-bg-surface3 hover:text-danger"
                  >
                    🗑
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-col gap-xs border-t border-border p-sm">
        <input
          type="number"
          placeholder="Zone ID"
          value={newZoneId}
          onChange={(e) => setNewZoneId(e.target.value)}
          className="h-input rounded-control border border-border bg-bg-surface3 px-sm text-sm text-text-primary focus:border-accent focus:outline-none"
        />
        <div className="flex gap-xs">
          <input
            type="text"
            placeholder="Name (optional)"
            value={newZoneName}
            onChange={(e) => setNewZoneName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAddZone()}
            className="h-input w-0 flex-1 rounded-control border border-border bg-bg-surface3 px-sm text-sm text-text-primary focus:border-accent focus:outline-none"
          />
          <button
            onClick={handleAddZone}
            className="h-input shrink-0 rounded-control bg-primary px-sm text-sm text-text-primary hover:bg-primary-hover"
          >
            +
          </button>
        </div>
      </div>
    </aside>
  );
}
