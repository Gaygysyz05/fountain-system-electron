import { useEffect, useState } from "react";
import { useScheduleStore } from "../../store/scheduleStore";
import { useConfigStore } from "../../store/configStore";
import { useScenariosStore } from "../../store/scenariosStore";
import { useConnectionStore } from "../../store/connectionStore";
import type { ScheduleEntryDto, ScheduleEntryInput, ScenarioDto, ZoneConfigDto } from "../../lib/protocol";

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/** Next actual fire time for one entry, or null if disabled -- scans up to
 * 8 days ahead (today's slot may already be past) rather than assuming
 * "tomorrow", since a `days`-restricted entry's next occurrence could be
 * several days out. Mirrors the daemon's own weekday numbering
 * (0=Monday..6=Sunday, see ScheduleEntryDto) -- JS's Date.getDay() is
 * 0=Sunday, hence the `+6) % 7` shift. */
function computeNextRun(entry: ScheduleEntryDto, now: Date): Date | null {
  if (!entry.enabled) return null;
  const [hh, mm] = entry.time.split(":").map(Number);
  for (let addDays = 0; addDays < 8; addDays++) {
    const candidate = new Date(now);
    candidate.setDate(candidate.getDate() + addDays);
    candidate.setHours(hh, mm, 0, 0);
    if (candidate <= now) continue;
    const weekday = (candidate.getDay() + 6) % 7;
    if (entry.days.length === 0 || entry.days.includes(weekday)) return candidate;
  }
  return null;
}

function formatNextRun(next: Date, now: Date): string {
  const sameDay = next.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = next.toDateString() === tomorrow.toDateString();
  const hm = `${String(next.getHours()).padStart(2, "0")}:${String(next.getMinutes()).padStart(2, "0")}`;
  if (sameDay) return `Today ${hm}`;
  if (isTomorrow) return `Tomorrow ${hm}`;
  return `${DAY_LABELS[(next.getDay() + 6) % 7]} ${hm}`;
}

function daysOverlap(a: number[], b: number[]): boolean {
  if (a.length === 0 || b.length === 0) return true; // "every day" always intersects any other selection
  return a.some((d) => b.includes(d));
}

/** Other ENABLED entries in the same zone whose day-sets and time windows
 * (time .. time + scenario duration) overlap this candidate -- checked
 * before Add/Save so double-booking a zone is a deliberate choice, not a
 * surprise discovered when two shows collide live. */
function findOverlaps(
  candidate: { zoneId: number; time: string; days: number[]; durationMinutes: number },
  entries: ScheduleEntryDto[],
  scenarios: ScenarioDto[],
  excludeId?: string,
): ScheduleEntryDto[] {
  const start = timeToMinutes(candidate.time);
  const end = start + candidate.durationMinutes;
  return entries.filter((e) => {
    if (e.id === excludeId || e.zone_id !== candidate.zoneId || !e.enabled) return false;
    if (!daysOverlap(candidate.days, e.days)) return false;
    const eStart = timeToMinutes(e.time);
    const eEnd = eStart + (scenarios.find((s) => s.scenario_id === e.scenario_id)?.duration ?? 0) / 60;
    return start < eEnd && eStart < end;
  });
}

/**
 * Scheduled playback -- "Zone 1 / show X every day at 20:00" -- backed by
 * GET/POST/PUT/DELETE /schedule (see app/main.py + persistence.py's
 * ScheduleEntryDto). The daemon checks these against the wall clock every
 * 20s on its own; this panel is CRUD on the list plus a couple of things
 * that make a growing list actually manageable: sorted by time, each row's
 * real next-fire computed client-side, an overlap check before saving, and
 * a "Test now" that plays the entry's scenario immediately without waiting
 * for (or touching) its actual scheduled time.
 */
export function SchedulePanel(): JSX.Element {
  const { entries, loading, error, loadSchedule, createEntry, updateEntry, deleteEntry } = useScheduleStore();
  const zones = useConfigStore((s) => s.zones);
  const loadZones = useConfigStore((s) => s.loadZones);
  const scenarios = useScenariosStore((s) => s.scenarios);
  const loadScenarios = useScenariosStore((s) => s.loadScenarios);
  const sendCommand = useConnectionStore((s) => s.sendCommand);
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);

  // Drives "next run" labels -- doesn't need to be second-accurate, just
  // not stuck on whatever moment the tab happened to mount.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    void loadSchedule();
    void loadZones();
    void loadScenarios();
  }, [loadSchedule, loadZones, loadScenarios]);

  const sortedEntries = [...entries].sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time));
  const editingEntry = entries.find((e) => e.id === editingEntryId) ?? null;

  async function handleTestNow(entry: ScheduleEntryDto): Promise<void> {
    await sendCommand({ command: "PLAY_SCENARIO", zone_id: entry.zone_id, scenario_id: entry.scenario_id });
  }

  /** Shared by both Add and Save: warns (with a chance to back out) if the
   * candidate overlaps another enabled entry in the same zone, then
   * delegates to whichever daemon call the caller passed in. */
  async function submitWithOverlapCheck(
    input: ScheduleEntryInput,
    excludeId: string | undefined,
    apply: () => Promise<void>,
  ): Promise<void> {
    const durationMinutes = (scenarios.find((s) => s.scenario_id === input.scenario_id)?.duration ?? 0) / 60;
    const overlaps = findOverlaps({ zoneId: input.zone_id, time: input.time, days: input.days, durationMinutes }, entries, scenarios, excludeId);
    if (overlaps.length > 0) {
      const names = overlaps.map((o) => `${o.time} ${o.scenario_id}`).join(", ");
      if (!window.confirm(`This overlaps ${overlaps.length} other scheduled show(s) in the same zone (${names}). Save anyway?`)) return;
    }
    await apply();
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-lg overflow-y-auto p-lg">
      <h2 className="text-lg font-medium text-text-primary">Schedule</h2>
      {error && <p className="text-sm text-danger">{error}</p>}
      {loading && entries.length === 0 && <p className="text-sm text-text-muted">Loading…</p>}
      {entries.length === 0 && !loading && (
        <p className="text-sm text-text-muted">No scheduled playback yet -- add one below.</p>
      )}
      {zones.length > 0 && scenarios.length === 0 && (
        <p className="text-sm text-text-muted">No saved scenarios yet -- create one on the Timeline tab first.</p>
      )}

      <ul className="flex flex-col gap-xs">
        {sortedEntries.map((entry) => (
          <ScheduleRow
            key={entry.id}
            entry={entry}
            zoneName={zones.find((z) => z.zone_id === entry.zone_id)?.name?.trim() || `Zone ${entry.zone_id}`}
            nextRun={computeNextRun(entry, now)}
            now={now}
            editing={editingEntryId === entry.id}
            onToggleEnabled={() => void updateEntry(entry.id, { enabled: !entry.enabled })}
            onDelete={() => void deleteEntry(entry.id)}
            onEdit={() => setEditingEntryId(entry.id)}
            onTestNow={() => void handleTestNow(entry)}
          />
        ))}
      </ul>

      <ScheduleEntryForm
        key={editingEntryId ?? "new"} // remount on entering/leaving edit mode -- a fresh set of local state per entry, not one form silently carrying over stale values
        zones={zones}
        scenarios={scenarios}
        initial={editingEntry}
        onCancel={editingEntryId ? () => setEditingEntryId(null) : undefined}
        onSubmit={async (input) => {
          if (editingEntryId) {
            await submitWithOverlapCheck(input, editingEntryId, () => updateEntry(editingEntryId, input));
            setEditingEntryId(null);
          } else {
            await submitWithOverlapCheck(input, undefined, () => createEntry(input));
          }
        }}
      />
    </div>
  );
}

function ScheduleRow(props: {
  entry: ScheduleEntryDto;
  zoneName: string;
  nextRun: Date | null;
  now: Date;
  editing: boolean;
  onToggleEnabled: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onTestNow: () => void;
}): JSX.Element {
  const { entry } = props;
  const daysLabel = entry.days.length === 0 ? "Every day" : entry.days.map((d) => DAY_LABELS[d]).join(", ");
  return (
    <li
      className={`flex flex-wrap items-center justify-between gap-x-md gap-y-1 rounded-panel border px-md py-sm ${
        props.editing ? "border-accent bg-bg-surface2" : "border-border bg-bg-surface1"
      }`}
    >
      <div className="flex flex-wrap items-center gap-md text-sm">
        <button
          onClick={props.onToggleEnabled}
          title={entry.enabled ? "Enabled -- click to disable" : "Disabled -- click to enable"}
          className={`h-2 w-2 shrink-0 rounded-full ${entry.enabled ? "bg-success" : "bg-text-muted"}`}
        />
        <span className="font-mono text-text-primary">{entry.time}</span>
        <span className="text-text-secondary">{props.zoneName}</span>
        <span className="text-text-secondary">{entry.scenario_id}</span>
        <span className="text-xs text-text-muted">{daysLabel}</span>
        <span className="text-xs text-text-muted">
          {props.nextRun ? `Next: ${formatNextRun(props.nextRun, props.now)}` : "Disabled"}
        </span>
        {entry.last_fired_date && <span className="text-xs text-text-muted">last ran {entry.last_fired_date}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-sm">
        <button onClick={props.onTestNow} title="Plays this entry's scenario right now, without waiting for its scheduled time -- doesn't touch last_fired_date" className="text-xs text-accent hover:text-accent-hover">
          Test now
        </button>
        <button onClick={props.onEdit} className="text-xs text-accent hover:text-accent-hover">
          Edit
        </button>
        <button onClick={props.onDelete} className="text-xs text-danger hover:text-danger-hover">
          Delete
        </button>
      </div>
    </li>
  );
}

function ScheduleEntryForm(props: {
  zones: ZoneConfigDto[];
  scenarios: ScenarioDto[];
  initial: ScheduleEntryDto | null;
  onCancel?: () => void;
  onSubmit: (input: ScheduleEntryInput) => Promise<void>;
}): JSX.Element {
  const [zoneId, setZoneId] = useState<number | null>(props.initial?.zone_id ?? props.zones[0]?.zone_id ?? null);
  const [scenarioId, setScenarioId] = useState(props.initial?.scenario_id ?? props.scenarios[0]?.scenario_id ?? "");
  const [time, setTime] = useState(props.initial?.time ?? "20:00");
  const [days, setDays] = useState<number[]>(props.initial?.days ?? []);

  // Zones/scenarios load asynchronously after mount -- keep the pickers'
  // default selection in sync once they actually arrive, instead of the
  // form staying stuck on the empty initial render forever. Skipped once
  // editing an existing entry -- its own values take priority.
  useEffect(() => {
    if (!props.initial && zoneId === null && props.zones.length > 0) setZoneId(props.zones[0].zone_id);
  }, [props.zones, props.initial, zoneId]);
  useEffect(() => {
    if (!props.initial && !scenarioId && props.scenarios.length > 0) setScenarioId(props.scenarios[0].scenario_id);
  }, [props.scenarios, props.initial, scenarioId]);

  function toggleDay(day: number): void {
    setDays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort()));
  }

  const inputClass =
    "h-input rounded-control border border-border bg-bg-surface3 px-sm text-sm text-text-primary focus:border-accent focus:outline-none";

  return (
    <div className="flex flex-col gap-sm rounded-panel border border-border bg-bg-surface2 p-md">
      {props.initial && <span className="text-xs font-medium text-accent">Editing {props.initial.time} · {props.initial.scenario_id}</span>}
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
            void props.onSubmit({ zone_id: zoneId, scenario_id: scenarioId, time, days, enabled: props.initial?.enabled ?? true });
          }}
          disabled={zoneId === null || !scenarioId}
          className="h-input rounded-control bg-primary px-md text-sm text-text-primary hover:bg-primary-hover disabled:opacity-50"
        >
          {props.initial ? "Save" : "+ Add"}
        </button>
        {props.onCancel && (
          <button onClick={props.onCancel} className="h-input text-xs text-text-muted hover:text-text-secondary">
            Cancel
          </button>
        )}
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
