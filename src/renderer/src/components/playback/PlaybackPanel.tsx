import { memo, useCallback, useEffect, useState } from "react";
import { useConfigStore } from "../../store/configStore";
import { useScenariosStore } from "../../store/scenariosStore";
import { useZonesStore } from "../../store/zonesStore";
import { useConnectionStore } from "../../store/connectionStore";
import { INPUT_CLASS } from "../../lib/styles";
import { LiveTimecode } from "./LiveTimecode";
import { LiveProgressBar } from "./LiveProgressBar";
import { TransportButtons } from "./TransportButtons";
import { ScenarioTimelinePlayer } from "./ScenarioTimelinePlayer";
import { SubTab } from "../timeline/SubTab";
import type { ScenarioDto, ZoneConfigDto, ZoneState } from "../../lib/protocol";

const STATE_LABEL: Record<ZoneState, string> = {
  stopped: "Stopped",
  connecting: "Connecting",
  ready: "Ready",
  playing: "Playing",
  paused: "Paused",
  error: "Error",
};
// Solid badge (not the small sidebar dot) so state reads at a glance from across the room during a live show.
const STATE_BADGE: Record<ZoneState, string> = {
  stopped: "bg-bg-surface3 text-text-secondary",
  connecting: "bg-warning text-white",
  ready: "bg-bg-surface3 text-text-secondary",
  playing: "bg-success text-white",
  paused: "bg-warning text-white",
  error: "bg-danger text-white",
};

type Tab = "controls" | "timeline";

/** Two views: "Controls" gives every zone its own independent card (zones run independently); "Timeline" stays scoped to one zone via the picker up top. */
export function PlaybackPanel(): JSX.Element {
  const zones = useConfigStore((s) => s.zones);
  const loadZones = useConfigStore((s) => s.loadZones);
  const scenarios = useScenariosStore((s) => s.scenarios);
  const loadScenarios = useScenariosStore((s) => s.loadScenarios);

  // Only used by the Timeline tab -- Controls has no single "selected" zone.
  const [timelineZoneId, setTimelineZoneId] = useState<number | null>(null);
  const [timelineScenarioId, setTimelineScenarioId] = useState<string>("");
  const [timelineLoop, setTimelineLoop] = useState(false);
  const [tab, setTab] = useState<Tab>("controls");

  // Lifted to this level (not local to each card) so "Play All" can read every zone's current pick.
  const [selectedScenarios, setSelectedScenarios] = useState<Record<number, string>>({});

  useEffect(() => {
    void loadZones();
    void loadScenarios();
  }, [loadZones, loadScenarios]);

  useEffect(() => {
    if (timelineZoneId === null && zones.length > 0) setTimelineZoneId(zones[0].zone_id);
  }, [zones, timelineZoneId]);

  // Daemon's live `scenario_id` (what's actually playing) so defaulting below can prefer it over "first in the list" on reconnect mid-show.
  const liveZones = useZonesStore((s) => s.zones);

  useEffect(() => {
    if (timelineScenarioId) return;
    const live = timelineZoneId !== null ? liveZones.get(timelineZoneId)?.scenario_id : null;
    const fallback = scenarios.length > 0 ? scenarios[0].scenario_id : "";
    const preferred = live && scenarios.some((s) => s.scenario_id === live) ? live : fallback;
    if (preferred) setTimelineScenarioId(preferred);
  }, [scenarios, timelineScenarioId, timelineZoneId, liveZones]);

  // Defaults each zone to what the daemon reports as currently loaded (else first scenario); only fills unset zones, never overwrites an operator's pick.
  useEffect(() => {
    if (scenarios.length === 0 || zones.length === 0) return;
    setSelectedScenarios((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const zone of zones) {
        if (next[zone.zone_id]) continue;
        const live = liveZones.get(zone.zone_id)?.scenario_id;
        next[zone.zone_id] = live && scenarios.some((s) => s.scenario_id === live) ? live : scenarios[0].scenario_id;
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [zones, scenarios, liveZones]);

  const timelineZoneStatus = useZonesStore((s) => (timelineZoneId !== null ? s.zones.get(timelineZoneId) : undefined));
  const timelineState = timelineZoneStatus?.state ?? "stopped";
  const timelineScenario = scenarios.find((s) => s.scenario_id === timelineScenarioId) ?? null;
  const timelineZone = zones.find((z) => z.zone_id === timelineZoneId) ?? null;
  const sendCommand = useConnectionStore((s) => s.sendCommand);

  /** Starts every zone's selected scenario together (a synced multi-zone show can't tolerate clicking Play on each card in turn); skips zones with nothing selected. */
  function playAllZones(): void {
    for (const zone of zones) {
      const scenarioId = selectedScenarios[zone.zone_id];
      if (scenarioId) void sendCommand({ command: "PLAY_SCENARIO", zone_id: zone.zone_id, scenario_id: scenarioId });
    }
  }

  // PAUSE_ZONE/STOP_ZONE are no-ops on the daemon for a non-playing zone, so these fire unconditionally at every zone without checking live state.
  function pauseAllZones(): void {
    for (const zone of zones) void sendCommand({ command: "PAUSE_ZONE", zone_id: zone.zone_id });
  }

  function stopAllZones(): void {
    for (const zone of zones) void sendCommand({ command: "STOP_ZONE", zone_id: zone.zone_id });
  }

  function toggleTimelineLoop(): void {
    if (timelineZoneId === null) return;
    const next = !timelineLoop;
    setTimelineLoop(next);
    void sendCommand({ command: "SET_LOOP", zone_id: timelineZoneId, enabled: next });
  }

  // Stable callback identity so React.memo on ZoneControlCard below isn't defeated by a fresh closure on every render (this component re-renders on any zone's status tick via liveZones).
  const handleSelectScenario = useCallback((zoneId: number, scenarioId: string) => {
    setSelectedScenarios((prev) => ({ ...prev, [zoneId]: scenarioId }));
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-xl pt-lg">
        <div className="flex items-center gap-lg">
          <div className="flex gap-md">
            <SubTab label="Controls" active={tab === "controls"} onClick={() => setTab("controls")} />
            <SubTab label="Timeline" active={tab === "timeline"} onClick={() => setTab("timeline")} />
          </div>

          {tab === "timeline" && (
            <label className="flex items-center gap-xs text-sm">
              <span className="text-text-secondary">Zone</span>
              <select
                value={timelineZoneId ?? ""}
                onChange={(e) => setTimelineZoneId(Number(e.target.value))}
                className={INPUT_CLASS}
              >
                {zones.map((z) => (
                  <option key={z.zone_id} value={z.zone_id}>
                    {z.name?.trim() || `Zone ${z.zone_id}`}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {tab === "controls" && zones.length > 1 && (
          <div className="mb-sm flex items-center gap-sm">
            <button
              onClick={playAllZones}
              title="Starts every zone's currently-selected scenario at once, instead of pressing Play on each card in turn"
              className="h-control rounded-control bg-primary px-md text-sm font-medium text-text-primary hover:bg-primary-hover"
            >
              ▶ Play All
            </button>
            <button
              onClick={pauseAllZones}
              title="Pauses every zone at once"
              className="h-control rounded-control border border-border bg-bg-surface3 px-md text-sm font-medium text-text-primary hover:bg-bg-surface2"
            >
              ⏸ Pause All
            </button>
            <button
              onClick={stopAllZones}
              title="Stops every zone at once (not an emergency stop -- for that, use the button in the header)"
              className="h-control rounded-control border border-border bg-bg-surface3 px-md text-sm font-medium text-text-primary hover:bg-bg-surface2"
            >
              ■ Stop All
            </button>
          </div>
        )}

        {tab === "timeline" && timelineZoneId !== null && (
          <span className={`mb-sm rounded-control px-md py-1 text-sm font-medium ${STATE_BADGE[timelineState]}`}>
            {STATE_LABEL[timelineState]}
          </span>
        )}
      </div>

      {zones.length === 0 ? (
        <p className="p-xl text-sm text-text-muted">No zones configured yet -- add one on the Devices tab first.</p>
      ) : tab === "controls" ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-bg-base p-lg">
          <div className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-lg py-lg lg:grid-cols-2">
            {zones.map((zone) => (
              <ZoneControlCard
                key={zone.zone_id}
                zone={zone}
                scenarios={scenarios}
                selectedScenarioId={selectedScenarios[zone.zone_id] ?? ""}
                onSelectScenario={handleSelectScenario}
              />
            ))}
          </div>
        </div>
      ) : (
        timelineZoneId !== null &&
        timelineScenarioId && (
          <ScenarioTimelinePlayer
            zoneId={timelineZoneId}
            scenarioId={timelineScenarioId}
            scenarioName={timelineScenario?.name ?? timelineScenarioId}
            devices={timelineZone?.devices ?? []}
            instances={timelineZone?.driver_instances ?? []}
            canPlay={!!timelineScenarioId}
            loopEnabled={timelineLoop}
            onToggleLoop={toggleTimelineLoop}
          />
        )
      )}
    </div>
  );
}

/** One zone's transport; scenario selection is lifted to PlaybackPanel so "Play All" can see every zone's pick. Wrapped in React.memo since the parent re-renders on any zone's status tick, which would otherwise re-render every other zone's card too. */
const ZoneControlCard = memo(function ZoneControlCard({
  zone,
  scenarios,
  selectedScenarioId,
  onSelectScenario,
}: {
  zone: ZoneConfigDto;
  scenarios: ScenarioDto[];
  selectedScenarioId: string;
  onSelectScenario: (zoneId: number, scenarioId: string) => void;
}): JSX.Element {
  const sendCommand = useConnectionStore((s) => s.sendCommand);

  const zoneStatus = useZonesStore((s) => s.zones.get(zone.zone_id));
  const state = zoneStatus?.state ?? "stopped";
  // Local optimistic copy synced to the daemon's is_looping (source of truth) so a second HMI window or reconnect mid-show doesn't show a stale value, while a click still feels instant.
  const reportedLooping = zoneStatus?.is_looping;
  const [loopEnabled, setLoopEnabled] = useState(reportedLooping ?? false);
  useEffect(() => {
    if (reportedLooping !== undefined) setLoopEnabled(reportedLooping);
  }, [reportedLooping]);
  const currentScenario = scenarios.find((s) => s.scenario_id === selectedScenarioId) ?? null;
  const label = zone.name?.trim() || `Zone ${zone.zone_id}`;

  const deviceCounts = { valve: 0, motor: 0, light: 0 };
  for (const d of zone.devices) deviceCounts[d.category]++;
  const connectedInstances = zone.driver_instances.filter((i) => i.connected).length;
  const totalInstances = zone.driver_instances.length;

  function toggleLoop(): void {
    const next = !loopEnabled;
    setLoopEnabled(next);
    void sendCommand({ command: "SET_LOOP", zone_id: zone.zone_id, enabled: next });
  }

  return (
    <div className="flex flex-col gap-md rounded-[8px] border border-border-light bg-bg-surface1 p-lg shadow-[0_8px_24px_rgba(0,0,0,0.35)]">
      <div className="flex items-center justify-between">
        <span className="truncate text-sm font-semibold text-text-primary" title={label}>
          {label}
        </span>
        <span className={`shrink-0 rounded-control px-sm py-0.5 text-xs font-medium ${STATE_BADGE[state]}`}>{STATE_LABEL[state]}</span>
      </div>

      <div className="flex items-center justify-between rounded-control bg-bg-surface2 px-sm py-1 text-xs">
        <span className="text-text-muted">
          {deviceCounts.valve}V · {deviceCounts.motor}M · {deviceCounts.light}L
        </span>
        <span className={connectedInstances === totalInstances && totalInstances > 0 ? "text-success" : "text-warning"}>
          {connectedInstances}/{totalInstances} connected
        </span>
      </div>

      <div className="text-center">
        <div className="truncate text-lg font-bold text-text-primary">{currentScenario ? currentScenario.name : "No scenario selected"}</div>
      </div>

      <div className="flex flex-col gap-xs">
        <LiveProgressBar zoneId={zone.zone_id} />
        <LiveTimecode zoneId={zone.zone_id} className="text-center font-mono text-xs text-text-muted" />
      </div>

      <select
        value={selectedScenarioId}
        onChange={(e) => onSelectScenario(zone.zone_id, e.target.value)}
        className="h-control rounded-control border border-border bg-bg-surface3 px-sm text-sm text-text-primary focus:border-accent focus:outline-none"
      >
        {scenarios.length === 0 && <option value="">No scenarios found</option>}
        {scenarios.map((s) => (
          <option key={s.scenario_id} value={s.scenario_id}>
            {s.name} ({Math.round(s.duration)}s)
          </option>
        ))}
      </select>

      <TransportButtons
        zoneId={zone.zone_id}
        scenarioId={selectedScenarioId}
        canPlay={!!selectedScenarioId}
        loopEnabled={loopEnabled}
        onToggleLoop={toggleLoop}
      />
    </div>
  );
});
