import { useEffect, useState } from "react";
import { useConfigStore } from "../../store/configStore";
import { useScenariosStore } from "../../store/scenariosStore";
import { useZonesStore } from "../../store/zonesStore";
import { useConnectionStore } from "../../store/connectionStore";
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

  useEffect(() => {
    void loadZones();
    void loadScenarios();
  }, [loadZones, loadScenarios]);

  useEffect(() => {
    if (timelineZoneId === null && zones.length > 0) setTimelineZoneId(zones[0].zone_id);
  }, [zones, timelineZoneId]);

  useEffect(() => {
    if (!timelineScenarioId && scenarios.length > 0) setTimelineScenarioId(scenarios[0].scenario_id);
  }, [scenarios, timelineScenarioId]);

  const timelineZoneStatus = useZonesStore((s) => (timelineZoneId !== null ? s.zones.get(timelineZoneId) : undefined));
  const timelineState = timelineZoneStatus?.state ?? "stopped";
  const timelineScenario = scenarios.find((s) => s.scenario_id === timelineScenarioId) ?? null;
  const timelineZone = zones.find((z) => z.zone_id === timelineZoneId) ?? null;
  const sendCommand = useConnectionStore((s) => s.sendCommand);

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
                className="h-input rounded-control border border-border bg-bg-surface3 px-sm text-sm text-text-primary focus:border-accent focus:outline-none"
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
              <ZoneControlCard key={zone.zone_id} zone={zone} scenarios={scenarios} />
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

/** One zone's whole transport, fully self-contained -- its own scenario
 * selection and loop toggle, so it never fights another zone's card for
 * shared state. Rendered once per configured zone in the Controls grid,
 * every one independently playable at the same time. */
function ZoneControlCard({ zone, scenarios }: { zone: ZoneConfigDto; scenarios: ScenarioDto[] }): JSX.Element {
  const [selectedScenarioId, setSelectedScenarioId] = useState<string>("");
  const [loopEnabled, setLoopEnabled] = useState(false);
  const sendCommand = useConnectionStore((s) => s.sendCommand);

  useEffect(() => {
    if (!selectedScenarioId && scenarios.length > 0) setSelectedScenarioId(scenarios[0].scenario_id);
  }, [scenarios, selectedScenarioId]);

  const zoneStatus = useZonesStore((s) => s.zones.get(zone.zone_id));
  const state = zoneStatus?.state ?? "stopped";
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
        onChange={(e) => setSelectedScenarioId(e.target.value)}
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
