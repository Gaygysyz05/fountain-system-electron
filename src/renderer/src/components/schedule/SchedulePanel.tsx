import { useEffect, useState } from "react";
import { useScheduleStore } from "../../store/scheduleStore";
import { useConfigStore } from "../../store/configStore";
import { useScenariosStore } from "../../store/scenariosStore";
import { useConnectionStore } from "../../store/connectionStore";
import type { ScheduleEntryDto, ScheduleEntryInput, ScenarioDto, ZoneConfigDto } from "../../lib/protocol";

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_LETTERS = ["M", "T", "W", "T", "F", "S", "S"];

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
 * (time .. time + scenario duration) overlap this candidate -- surfaced
 * live in the form (see OverlapWarning) so double-booking a zone is a
 * choice made with the collision already visible, not a surprise
 * discovered when two shows collide live. */
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
 * 20s on its own; this panel is CRUD on the list plus what makes a growing
 * list actually manageable: sorted by time, each row's real next-fire
 * computed client-side, an overlap warning visible WHILE authoring an entry
 * (not a browser confirm() after the fact), a "Test now" that plays the
 * entry's scenario immediately without waiting for (or touching) its actual
 * scheduled time, and in-place editing of an existing entry.
 */
export function SchedulePanel(): JSX.Element {
  const { entries, loading, error, loadSchedule, createEntry, updateEntry, deleteEntry } = useScheduleStore();
  const zones = useConfigStore((s) => s.zones);
  const loadZones = useConfigStore((s) => s.loadZones);
  const scenarios = useScenariosStore((s) => s.scenarios);
  const loadScenarios = useScenariosStore((s) => s.loadScenarios);
  const sendCommand = useConnectionStore((s) => s.sendCommand);
  const [creating, setCreating] = useState(false);
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
  const formOpen = creating || editingEntry !== null;

  function zoneName(zoneId: number): string {
    return zones.find((z) => z.zone_id === zoneId)?.name?.trim() || `Zone ${zoneId}`;
  }

  // Header subhead: "N active · Next: <whichever fires soonest>" -- an
  // operator glancing at this tab wants "is anything about to happen"
  // without reading every row's own next-run time.
  const activeCount = entries.filter((e) => e.enabled).length;
  const soonest = entries
    .map((e) => ({ entry: e, next: computeNextRun(e, now) }))
    .filter((x): x is { entry: ScheduleEntryDto; next: Date } => x.next !== null)
    .sort((a, b) => a.next.getTime() - b.next.getTime())[0];

  async function handleTestNow(entry: ScheduleEntryDto): Promise<void> {
    await sendCommand({ command: "PLAY_SCENARIO", zone_id: entry.zone_id, scenario_id: entry.scenario_id });
  }

  function openCreate(): void {
    setEditingEntryId(null);
    setCreating(true);
  }

  function closeForm(): void {
    setCreating(false);
    setEditingEntryId(null);
  }

  async function handleSubmit(input: ScheduleEntryInput): Promise<void> {
    if (editingEntryId) {
      await updateEntry(editingEntryId, input);
    } else {
      await createEntry(input);
    }
    closeForm();
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-start justify-between px-xl pb-md pt-lg">
        <div className="flex flex-col gap-1">
          <h1 className="text-[20px] font-semibold text-text-primary">Schedule</h1>
          {entries.length > 0 && (
            <div className="flex items-center gap-sm text-base text-text-muted">
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-success" />
                {activeCount} active
              </span>
              {soonest && (
                <>
                  <span className="text-border-separator">·</span>
                  <span>
                    Next:{" "}
                    <strong className="font-medium text-text-secondary">
                      {zoneName(soonest.entry.zone_id)} — {soonest.entry.scenario_id}, {formatNextRun(soonest.next, now)}
                    </strong>
                  </span>
                </>
              )}
            </div>
          )}
        </div>
        <button
          onClick={openCreate}
          className="flex h-control shrink-0 items-center gap-1.5 rounded-control bg-primary px-md text-base font-medium text-text-primary hover:bg-primary-hover"
        >
          <span className="text-md leading-none">+</span> New Schedule
        </button>
      </div>

      {error && <p className="px-xl text-base text-danger">{error}</p>}

      <div className="min-h-0 flex-1 overflow-y-auto px-xl pb-xl">
        <div className="mx-auto flex max-w-[920px] flex-col gap-sm">
          {loading && entries.length === 0 && <p className="text-base text-text-muted">Loading…</p>}

          {entries.length === 0 && !loading && !formOpen && (
            <div className="flex flex-col items-center gap-xs rounded-[8px] border border-dashed border-border py-xl text-center">
              <span className="text-base text-text-secondary">No scheduled playback yet</span>
              <span className="text-base text-text-muted">Add a show to run automatically, on its own days and time.</span>
            </div>
          )}

          {zones.length > 0 && scenarios.length === 0 && (
            <p className="text-base text-text-muted">No saved scenarios yet -- create one on the Timeline tab first.</p>
          )}

          {sortedEntries.map((entry) => (
            <ScheduleCard
              key={entry.id}
              entry={entry}
              zoneName={zoneName(entry.zone_id)}
              nextRun={computeNextRun(entry, now)}
              now={now}
              editing={editingEntryId === entry.id}
              onToggleEnabled={() => void updateEntry(entry.id, { enabled: !entry.enabled })}
              onDelete={() => void deleteEntry(entry.id)}
              onEdit={() => {
                setCreating(false);
                setEditingEntryId(entry.id);
              }}
              onTestNow={() => void handleTestNow(entry)}
            />
          ))}

          {formOpen && (
            <ScheduleEntryForm
              key={editingEntryId ?? "new"} // remount on entering/leaving edit mode -- a fresh set of local state per entry, not one form silently carrying over stale values
              zones={zones}
              scenarios={scenarios}
              entries={entries}
              initial={editingEntry}
              onCancel={closeForm}
              onSubmit={handleSubmit}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function ScheduleCard(props: {
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
  return (
    <div
      className={`flex items-center gap-lg rounded-[8px] border bg-bg-surface1 px-lg py-md shadow-[0_8px_24px_rgba(0,0,0,0.35)] ${
        props.editing ? "border-accent" : "border-border-light"
      } ${entry.enabled ? "" : "opacity-55"}`}
    >
      <button
        onClick={props.onToggleEnabled}
        title={entry.enabled ? "Enabled -- click to disable" : "Disabled -- click to enable"}
        className={`h-2.5 w-2.5 shrink-0 rounded-full ${entry.enabled ? "bg-success" : "bg-text-disabled"}`}
      />

      <span className="min-w-[68px] font-mono text-[20px] font-semibold text-text-primary">{entry.time}</span>

      <div className="h-8 w-px shrink-0 bg-border-light" />

      <div className="flex min-w-[190px] flex-col gap-0.5">
        <span className="text-md font-medium text-text-primary">{entry.scenario_id}</span>
        <span className="text-base text-text-muted">{props.zoneName}</span>
      </div>

      <div className="flex gap-1">
        {DAY_LETTERS.map((letter, i) => (
          <span
            key={i}
            className={`flex h-[22px] w-[22px] items-center justify-center rounded-control text-sm font-semibold ${
              entry.days.length === 0 || entry.days.includes(i) ? "bg-accent text-text-primary" : "bg-bg-surface3 text-text-disabled"
            }`}
          >
            {letter}
          </span>
        ))}
      </div>

      <div className="flex-1" />

      <div className="flex flex-col items-end gap-0.5">
        {props.nextRun ? (
          <span className={`text-base font-medium ${props.nextRun.toDateString() === props.now.toDateString() ? "text-success" : "text-text-secondary"}`}>
            Next: {formatNextRun(props.nextRun, props.now)}
          </span>
        ) : (
          <span className="text-base font-medium text-text-disabled">Disabled</span>
        )}
        <span className="text-sm text-text-disabled">{entry.last_fired_date ? `Last ran ${entry.last_fired_date}` : "Never ran"}</span>
      </div>

      <div className="h-8 w-px shrink-0 bg-border-light" />

      <div className="flex items-center gap-md">
        <button
          onClick={props.onTestNow}
          title="Plays this entry's scenario right now, without waiting for its scheduled time -- doesn't touch last_fired_date"
          className="text-base font-medium text-accent hover:text-accent-hover"
        >
          Test now
        </button>
        <button onClick={props.onEdit} className="text-base font-medium text-accent hover:text-accent-hover">
          Edit
        </button>
        <button onClick={props.onDelete} className="text-base font-medium text-danger hover:text-danger-hover">
          Delete
        </button>
      </div>
    </div>
  );
}

function ScheduleEntryForm(props: {
  zones: ZoneConfigDto[];
  scenarios: ScenarioDto[];
  entries: ScheduleEntryDto[];
  initial: ScheduleEntryDto | null;
  onCancel: () => void;
  onSubmit: (input: ScheduleEntryInput) => Promise<void>;
}): JSX.Element {
  const [zoneId, setZoneId] = useState<number | null>(props.initial?.zone_id ?? props.zones[0]?.zone_id ?? null);
  const [scenarioId, setScenarioId] = useState(props.initial?.scenario_id ?? props.scenarios[0]?.scenario_id ?? "");
  const [time, setTime] = useState(props.initial?.time ?? "20:00");
  const [days, setDays] = useState<number[]>(props.initial?.days ?? []);
  const [saving, setSaving] = useState(false);

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

  // Recomputed on every keystroke/pick -- the point of showing this INSIDE
  // the form instead of a confirm() dialog after Save is clicked: the
  // operator sees the collision while they're still choosing the time,
  // not as an interruption after they've already committed to it.
  const durationMinutes = (props.scenarios.find((s) => s.scenario_id === scenarioId)?.duration ?? 0) / 60;
  const overlaps =
    zoneId !== null && scenarioId
      ? findOverlaps({ zoneId, time, days, durationMinutes }, props.entries, props.scenarios, props.initial?.id)
      : [];

  async function handleSave(): Promise<void> {
    if (zoneId === null || !scenarioId) return;
    setSaving(true);
    try {
      await props.onSubmit({ zone_id: zoneId, scenario_id: scenarioId, time, days, enabled: props.initial?.enabled ?? true });
    } finally {
      setSaving(false);
    }
  }

  const inputClass =
    "h-input rounded-control border border-border bg-bg-surface3 px-sm text-base text-text-primary focus:border-accent focus:outline-none";

  return (
    <div className="flex flex-col gap-md rounded-[8px] border border-accent bg-bg-surface2 p-lg">
      <div className="flex items-center justify-between">
        <span className="text-md font-semibold text-text-primary">{props.initial ? "Edit Schedule" : "New Schedule"}</span>
        <button onClick={props.onCancel} title="Cancel" className="text-lg leading-none text-text-muted hover:text-text-primary">
          ×
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-sm">
        <label className="flex min-w-[160px] flex-col gap-1.5 text-base text-text-muted">
          Zone
          <select value={zoneId ?? ""} onChange={(e) => setZoneId(Number(e.target.value))} className={inputClass}>
            {props.zones.map((z) => (
              <option key={z.zone_id} value={z.zone_id}>
                {z.name?.trim() || `Zone ${z.zone_id}`}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-[200px] flex-col gap-1.5 text-base text-text-muted">
          Scenario
          <select value={scenarioId} onChange={(e) => setScenarioId(e.target.value)} className={inputClass}>
            {props.scenarios.map((s) => (
              <option key={s.scenario_id} value={s.scenario_id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-[110px] flex-col gap-1.5 text-base text-text-muted">
          Time
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={inputClass} />
        </label>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-base text-text-muted">Repeats</span>
        <div className="flex gap-1.5">
          {DAY_LABELS.map((label, i) => (
            <button
              key={label}
              onClick={() => toggleDay(i)}
              className={`h-control w-[42px] rounded-control border text-base font-semibold ${
                days.includes(i) ? "border-accent bg-accent text-text-primary" : "border-border text-text-muted hover:text-text-secondary"
              }`}
            >
              {label}
            </button>
          ))}
          {days.length === 0 && <span className="ml-xs self-center text-base text-text-muted">(every day)</span>}
        </div>
      </div>

      {overlaps.length > 0 && (
        <div className="flex items-start gap-sm rounded-panel border border-warning/35 bg-warning/10 px-md py-sm">
          <span className="text-md leading-tight text-warning">⚠</span>
          <span className="text-base leading-relaxed text-warning">
            Overlaps <strong className="font-semibold">{overlaps.length === 1 ? "1 other schedule" : `${overlaps.length} other schedules`}</strong> in this zone:{" "}
            {overlaps.map((o) => `${o.time} ${o.scenario_id}`).join(", ")}. Saving will double-book it.
          </span>
        </div>
      )}

      <div className="flex items-center gap-sm">
        <button
          onClick={() => void handleSave()}
          disabled={zoneId === null || !scenarioId || saving}
          className="h-control rounded-control bg-primary px-lg text-base font-medium text-text-primary hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "Saving…" : props.initial ? "Save changes" : "Add schedule"}
        </button>
        <button onClick={props.onCancel} className="h-control px-sm text-base text-text-muted hover:text-text-secondary">
          Cancel
        </button>
      </div>
    </div>
  );
}
