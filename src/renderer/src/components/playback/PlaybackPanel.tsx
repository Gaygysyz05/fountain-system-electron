import { useEffect, useState } from "react";
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
// A solid badge, not the small 2px dot used in the sidebar/status bar --
// this screen is what an operator watches during a live show, so the
// state has to read at a glance from across the room, not just up close.
const STATE_BADGE: Record<ZoneState, string> = {
  stopped: "bg-bg-surface3 text-text-secondary",
  connecting: "bg-warning text-white",
  ready: "bg-bg-surface3 text-text-secondary",
  playing: "bg-success text-white",
  paused: "bg-warning text-white",
  error: "bg-danger text-white",
};

type Tab = "controls" | "timeline";

/**
 * Two views on the same transport: "Controls" is one independent card PER
 * ZONE -- a real fountain install is rarely just one zone, and the whole
 * point of separate zones is running them independently, so every zone
 * gets its own scenario picker and Play/Pause/Stop rather than sharing one
 * selector that only ever showed whichever zone you'd last clicked.
 * "Timeline" is the piano-roll player (ScenarioTimelinePlayer), which DOES
 * stay scoped to one zone at a time via the picker up top -- there's only
 * ever one detailed view worth looking at at once.
 */
export function PlaybackPanel(): JSX.Element {
  const zones = useConfigStore((s) => s.zones);
  const loadZones = useConfigStore((s) => s.loadZones);
  const scenarios = useScenariosStore((s) => s.scenarios);
  const loadScenarios = useScenariosStore((s) => s.loadScenarios);

  // Only used by the Timeline tab -- Controls shows every zone at once and
  // has no single "selected" one.
  const [timelineZoneId, setTimelineZoneId] = useState<number | null>(null);
  const [timelineScenarioId, setTimelineScenarioId] = useState<string>("");
  const [timelineLoop, setTimelineLoop] = useState(false);
  const [tab, setTab] = useState<Tab>("controls");

  // Lifted out of ZoneControlCard (was local state there) so "Play All" can
  // read every zone's current pick -- each zone's own selector still writes
  // here, nothing changes about how picking a scenario per-zone feels.
  const [selectedScenarios, setSelectedScenarios] = useState<Record<number, string>>({});

  useEffect(() => {
    void loadZones();
    void loadScenarios();
  }, [loadZones, loadScenarios]);

  useEffect(() => {
    if (timelineZoneId === null && zones.length > 0) setTimelineZoneId(zones[0].zone_id);
  }, [zones, timelineZoneId]);

  // Zone status carries the daemon's own `scenario_id` (what's ACTUALLY
  // loaded/playing right now), not just this tab's local picks -- read here
  // so the defaulting effects below can prefer it over "first in the list"
  // when the HMI (re)connects mid-show and has no pick of its own yet.
  const liveZones = useZonesStore((s) => s.zones);

  useEffect(() => {
    if (timelineScenarioId) return;
    const live = timelineZoneId !== null ? liveZones.get(timelineZoneId)?.scenario_id : null;
    const fallback = scenarios.length > 0 ? scenarios[0].scenario_id : "";
    const preferred = live && scenarios.some((s) => s.scenario_id === live) ? live : fallback;
    if (preferred) setTimelineScenarioId(preferred);
  }, [scenarios, timelineScenarioId, timelineZoneId, liveZones]);

  // Default every zone to whatever the daemon says is actually loaded there
  // right now, falling back to the first available scenario only if nothing
  // is currently running -- same as before, just no longer blind to a show
  // already in progress when this tab first mounts (e.g. HMI closed and
  // reopened while a zone kept playing). Only ever fills in a zone that
  // doesn't have a pick yet; never overwrites an operator's own selection.
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

  /** Starts every configured zone's currently-selected scenario at once --
   * previously the only way to run more than one zone was clicking Play on
   * each zone's card in turn, which a synced multi-zone show can't really
   * tolerate (each zone's Play command lands at a slightly different
   * moment). Skips a zone with nothing selected rather than failing the
   * whole batch over it. */
  function playAllZones(): void {
    for (const zone of zones) {
      const scenarioId = selectedScenarios[zone.zone_id];
      if (scenarioId) void sendCommand({ command: "PLAY_SCENARIO", zone_id: zone.zone_id, scenario_id: scenarioId });
    }
  }

  // Play All's obvious counterparts -- it shipped without them, which read
  // as "you can start everything together but have to stop each zone by
  // hand", the opposite of what a multi-zone show actually needs. PAUSE_ZONE/
  // STOP_ZONE on a zone that isn't playing is a harmless no-op on the daemon
  // side, so these just fire at every configured zone unconditionally
  // rather than first checking each one's live state.
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
                onSelectScenario={(scenarioId) => setSelectedScenarios((prev) => ({ ...prev, [zone.zone_id]: scenarioId }))}
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

/** One zone's whole transport -- its own loop toggle, so it never fights
 * another zone's card for shared state, but scenario selection is lifted
 * to PlaybackPanel (selectedScenarioId/onSelectScenario) so "Play All"
 * there can see every zone's current pick. Rendered once per configured
 * zone in the Controls grid, every one independently playable at the same
 * time -- or all together via Play All. */
function ZoneControlCard({
  zone,
  scenarios,
  selectedScenarioId,
  onSelectScenario,
}: {
  zone: ZoneConfigDto;
  scenarios: ScenarioDto[];
  selectedScenarioId: string;
  onSelectScenario: (scenarioId: string) => void;
}): JSX.Element {
  const sendCommand = useConnectionStore((s) => s.sendCommand);

  const zoneStatus = useZonesStore((s) => s.zones.get(zone.zone_id));
  const state = zoneStatus?.state ?? "stopped";
  // Local optimistic copy, not the sole source of truth: the daemon now
  // reports its own is_looping on every zone_status (see zonesStore.ts),
  // which is what actually drove playback all along -- this card's toggle
  // used to be a plain useState that only this window ever wrote to, so a
  // second HMI window, or a reconnect mid-show, silently showed the wrong
  // value. Synced below rather than read directly so a click still feels
  // instant instead of waiting on the next tick's broadcast.
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
        onChange={(e) => onSelectScenario(e.target.value)}
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
}
