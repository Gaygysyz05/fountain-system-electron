import { useEffect, useState } from "react";
import { useScheduleStore } from "../../store/scheduleStore";
import { useConfigStore } from "../../store/configStore";
import { useScenariosStore } from "../../store/scenariosStore";
import type { ScheduleEntryDto, ScheduleEntryInput, ScenarioDto, ZoneConfigDto } from "../../lib/protocol";

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * Scheduled playback -- "Zone 1 / show X every day at 20:00" -- backed by
 * GET/POST/PUT/DELETE /schedule (see app/main.py + persistence.py's
 * ScheduleEntryDto). The daemon checks these against the wall clock every
 * 20s on its own; this panel is pure CRUD on the list, not a live view of
 * "is something about to fire" -- last_fired_date (shown per row) is the
 * only feedback that an entry has actually run.
 */
export function SchedulePanel(): JSX.Element {
  const { entries, loading, error, loadSchedule, createEntry, updateEntry, deleteEntry } = useScheduleStore();
  const zones = useConfigStore((s) => s.zones);
  const loadZones = useConfigStore((s) => s.loadZones);
  const scenarios = useScenariosStore((s) => s.scenarios);
  const loadScenarios = useScenariosStore((s) => s.loadScenarios);

  useEffect(() => {
    void loadSchedule();
    void loadZones();
    void loadScenarios();
  }, [loadSchedule, loadZones, loadScenarios]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-lg overflow-y-auto p-lg">
      <h2 className="text-lg font-medium text-text-primary">Schedule</h2>
      {error && <p className="text-sm text-danger">{error}</p>}
      {loading && entries.length === 0 && <p className="text-sm text-text-muted">Loading…</p>}
      {entries.length === 0 && !loading && (
        <p className="text-sm text-text-muted">No scheduled playback yet -- add one below.</p>
      )}

      <ul className="flex flex-col gap-xs">
        {entries.map((entry) => (
          <ScheduleRow
            key={entry.id}
            entry={entry}
            zoneName={zones.find((z) => z.zone_id === entry.zone_id)?.name?.trim() || `Zone ${entry.zone_id}`}
            onToggleEnabled={() => void updateEntry(entry.id, { enabled: !entry.enabled })}
            onDelete={() => void deleteEntry(entry.id)}
          />
        ))}
      </ul>

      <AddScheduleForm zones={zones} scenarios={scenarios} onSubmit={createEntry} />
    </div>
  );
}

function ScheduleRow(props: {
  entry: ScheduleEntryDto;
  zoneName: string;
  onToggleEnabled: () => void;
  onDelete: () => void;
}): JSX.Element {
  const { entry } = props;
  const daysLabel = entry.days.length === 0 ? "Every day" : entry.days.map((d) => DAY_LABELS[d]).join(", ");
  return (
    <li className="flex items-center justify-between rounded-panel border border-border bg-bg-surface1 px-md py-sm">
      <div className="flex items-center gap-md text-sm">
        <button
          onClick={props.onToggleEnabled}
          title={entry.enabled ? "Enabled -- click to disable" : "Disabled -- click to enable"}
          className={`h-2 w-2 shrink-0 rounded-full ${entry.enabled ? "bg-success" : "bg-text-muted"}`}
        />
        <span className="font-mono text-text-primary">{entry.time}</span>
        <span className="text-text-secondary">{props.zoneName}</span>
        <span className="text-text-secondary">{entry.scenario_id}</span>
        <span className="text-xs text-text-muted">{daysLabel}</span>
        {entry.last_fired_date && <span className="text-xs text-text-muted">last ran {entry.last_fired_date}</span>}
      </div>
      <button onClick={props.onDelete} className="text-xs text-danger hover:text-danger-hover">
        Delete
      </button>
    </li>
  );
}

function AddScheduleForm(props: {
  zones: ZoneConfigDto[];
  scenarios: ScenarioDto[];
  onSubmit: (input: ScheduleEntryInput) => Promise<void>;
}): JSX.Element {
  const [zoneId, setZoneId] = useState<number | null>(props.zones[0]?.zone_id ?? null);
  const [scenarioId, setScenarioId] = useState(props.scenarios[0]?.scenario_id ?? "");
  const [time, setTime] = useState("20:00");
  const [days, setDays] = useState<number[]>([]);

  // Zones/scenarios load asynchronously after mount -- keep the pickers'
  // default selection in sync once they actually arrive, instead of the
  // form staying stuck on the empty initial render forever.
  useEffect(() => {
    if (zoneId === null && props.zones.length > 0) setZoneId(props.zones[0].zone_id);
  }, [props.zones, zoneId]);
  useEffect(() => {
    if (!scenarioId && props.scenarios.length > 0) setScenarioId(props.scenarios[0].scenario_id);
  }, [props.scenarios, scenarioId]);

  function toggleDay(day: number): void {
    setDays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort()));
  }

  const inputClass =
    "h-input rounded-control border border-border bg-bg-surface3 px-sm text-sm text-text-primary focus:border-accent focus:outline-none";

  return (
    <div className="flex flex-col gap-sm rounded-panel border border-border bg-bg-surface2 p-md">
      <div className="flex flex-wrap items-end gap-sm">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-text-muted">Zone</span>
          <select value={zoneId ?? ""} onChange={(e) => setZoneId(Number(e.target.value))} className={inputClass}>
            {props.zones.map((z) => (
              <option key={z.zone_id} value={z.zone_id}>
                {z.name?.trim() || `Zone ${z.zone_id}`}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-text-muted">Scenario</span>
          <select value={scenarioId} onChange={(e) => setScenarioId(e.target.value)} className={inputClass}>
            {props.scenarios.map((s) => (
              <option key={s.scenario_id} value={s.scenario_id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-text-muted">Time</span>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={inputClass} />
        </label>
        <button
          onClick={() => {
            if (zoneId === null || !scenarioId) return;
            void props.onSubmit({ zone_id: zoneId, scenario_id: scenarioId, time, days, enabled: true });
          }}
          disabled={zoneId === null || !scenarioId}
          className="h-input rounded-control bg-primary px-md text-sm text-text-primary hover:bg-primary-hover disabled:opacity-50"
        >
          + Add
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-xs">
        <span className="text-xs text-text-muted">Days:</span>
        {DAY_LABELS.map((label, i) => (
          <button
            key={label}
            onClick={() => toggleDay(i)}
            className={`rounded-control border px-xs py-0.5 text-xs ${
              days.includes(i) ? "border-accent bg-accent text-bg-surface1" : "border-border text-text-muted hover:text-text-secondary"
            }`}
          >
            {label}
          </button>
        ))}
        {days.length === 0 && <span className="text-xs text-text-muted">(every day)</span>}
      </div>
    </div>
  );
}
