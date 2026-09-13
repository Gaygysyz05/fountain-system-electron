import { useMemo, useState } from "react";
import { useScenariosStore } from "../../store/scenariosStore";
import { restClient } from "../../lib/restClient";
import { slugify, type ScenarioFile } from "../../lib/scenario";
import { describeError } from "../../lib/errors";
import { formatTime } from "../../lib/formatTime";
import { INPUT_CLASS } from "../../lib/styles";
import type { ZoneConfigDto } from "../../lib/protocol";

/** Minimal structural check on an imported file -- accepts anything shaped like what Export produces (see handleExport) or what the daemon itself stores, without requiring byte-identical fields; a file missing even these wouldn't have anything to load anyway. */
function isScenarioLike(value: unknown): value is {
  name: string;
  duration: number;
  events: Array<{ time: number; device_id: string; parameters?: Record<string, unknown> }>;
  music_file?: string | null;
  device_ids?: string[];
  zone_id?: number | null;
} {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === "string" && typeof v.duration === "number" && Array.isArray(v.events);
}

/** Replaces the old "Load…" <select> + separate Delete button (both awkward once there are more than a handful of scenarios: no search, no way to tell which one is currently open, no way to branch off an existing show without hand-editing its JSON). Deliberately no rename here -- see slugify's docstring: a scenario's id IS its filename, and ScheduleEntryDto.scenario_id entries reference that id directly, so changing it would silently orphan any schedule entry pointing at this scenario. Duplicate exists instead, for "start from this one but keep the original intact". Export/Import move a scenario to/from an arbitrary file on disk -- until now a scenario only ever lived inside the daemon's own data/scenarios/ folder, with no way to back one up, hand it to someone, or move it between installs. */
export function ScenarioManagerDialog({
  currentScenarioId,
  zones,
  onLoad,
  onImport,
  onDeletedCurrent,
  onClose,
}: {
  currentScenarioId: string;
  zones: ZoneConfigDto[];
  /** Caller owns the discard-unsaved-changes confirm and the actual store load; this dialog only decides which id and then closes itself. */
  onLoad: (scenarioId: string) => void;
  /** A file was picked and parsed -- caller loads it into the editor unsaved (same as "Generate from music") so the operator reviews before it becomes a real saved scenario. */
  onImport: (file: ScenarioFile) => void;
  /** Fires when the row deleted is the one currently open in the editor, so the caller can reset it (there's no file left to keep editing). */
  onDeletedCurrent: () => void;
  onClose: () => void;
}): JSX.Element {
  const scenarios = useScenariosStore((s) => s.scenarios);
  const loadScenarios = useScenariosStore((s) => s.loadScenarios);
  const deleteScenario = useScenariosStore((s) => s.deleteScenario);

  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q ? scenarios.filter((s) => s.name.toLowerCase().includes(q) || s.scenario_id.toLowerCase().includes(q)) : scenarios;
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [scenarios, search]);

  function zoneLabel(zoneId: number | null): string {
    if (zoneId == null) return "no zone recorded";
    const zone = zones.find((z) => z.zone_id === zoneId);
    return zone ? zone.name?.trim() || `Zone ${zoneId}` : `Zone ${zoneId} (deleted)`;
  }

  async function handleDuplicate(scenarioId: string, name: string): Promise<void> {
    const proposed = window.prompt("Name for the copy:", `${name} copy`);
    if (!proposed) return;

    const existingIds = new Set(scenarios.map((s) => s.scenario_id));
    let newId = slugify(proposed);
    for (let suffix = 2; existingIds.has(newId); suffix++) newId = `${slugify(proposed)}-${suffix}`;

    setBusyId(scenarioId);
    setError(null);
    try {
      const full = await restClient.getScenarioFull(scenarioId);
      await restClient.saveScenario(newId, {
        name: proposed,
        duration: full.duration,
        music_file: full.music_file,
        events: full.events.map((e) => ({ ...e, id: crypto.randomUUID() })),
        deviceIds: full.device_ids ?? [],
        zoneId: full.zone_id ?? null, // a copy stays in the same zone as the original
      });
      await loadScenarios();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleExport(scenarioId: string, name: string): Promise<void> {
    setBusyId(scenarioId);
    setError(null);
    try {
      const full = await restClient.getScenarioFull(scenarioId);
      const result = await window.electron.exportScenarioFile(`${slugify(name)}.json`, JSON.stringify(full, null, 2));
      if (!result.ok && result.error) setError(result.error);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleImport(): Promise<void> {
    setImporting(true);
    setError(null);
    try {
      const result = await window.electron.importScenarioFile();
      if (!result.ok) {
        if (result.error) setError(result.error);
        return; // cancelled -- not an error
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.content ?? "");
      } catch {
        setError("That file isn't valid JSON.");
        return;
      }
      if (!isScenarioLike(parsed)) {
        setError("That file doesn't look like a fountain scenario (missing name/duration/events).");
        return;
      }
      onImport({
        name: parsed.name,
        duration: parsed.duration,
        music_file: parsed.music_file ?? null,
        events: parsed.events.map((e) => ({ id: crypto.randomUUID(), time: e.time, device_id: e.device_id, parameters: e.parameters ?? {} })),
        deviceIds: parsed.device_ids ?? [],
        zoneId: parsed.zone_id ?? null,
      });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setImporting(false);
    }
  }

  async function handleDelete(scenarioId: string): Promise<void> {
    if (!window.confirm(`Delete saved scenario "${scenarioId}"? This can't be undone.`)) return;
    setBusyId(scenarioId);
    setError(null);
    try {
      await deleteScenario(scenarioId);
      if (scenarioId === currentScenarioId) onDeletedCurrent();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50">
      <div className="flex max-h-[80vh] w-[36rem] flex-col gap-sm rounded-panel border border-border bg-bg-surface1 p-lg">
        <div className="flex items-center justify-between">
          <span className="text-base font-medium text-text-primary">Scenarios</span>
          <button onClick={onClose} className="text-text-muted hover:text-text-secondary">
            ✕
          </button>
        </div>

        <div className="flex items-center gap-sm">
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search…"
            className={`${INPUT_CLASS} flex-1`}
          />
          <button
            disabled={importing}
            onClick={() => void handleImport()}
            title="Load a scenario .json exported from this or another install -- opens in the editor unsaved, for review before it's kept"
            className="h-control shrink-0 rounded-control border border-border bg-bg-surface3 px-md text-sm text-text-primary hover:bg-bg-surface2 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {importing ? "Importing…" : "Import…"}
          </button>
        </div>

        {error && <p className="text-xs text-danger">⚠ {error}</p>}

        <div className="min-h-0 flex-1 overflow-y-auto rounded-control border border-border">
          {filtered.length === 0 ? (
            <p className="p-md text-sm text-text-muted">{scenarios.length === 0 ? "No saved scenarios yet." : "No scenarios match."}</p>
          ) : (
            filtered.map((s) => {
              const isCurrent = s.scenario_id === currentScenarioId;
              const busy = busyId === s.scenario_id;
              return (
                <div
                  key={s.scenario_id}
                  className={`flex items-center gap-sm border-b border-border-light px-md py-sm last:border-b-0 ${isCurrent ? "bg-bg-surface2" : ""}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-xs">
                      <span className="truncate text-sm text-text-primary">{s.name}</span>
                      {isCurrent && <span className="shrink-0 rounded-sm bg-accent px-1 text-[10px] font-medium text-text-primary">OPEN</span>}
                    </div>
                    <div className="truncate font-mono text-xs text-text-muted">
                      {s.scenario_id}.json — {formatTime(s.duration)} — {zoneLabel(s.zone_id)}
                    </div>
                  </div>
                  <button
                    disabled={busy}
                    onClick={() => {
                      onLoad(s.scenario_id);
                    }}
                    className="h-control rounded-control border border-border bg-bg-surface3 px-sm text-xs text-text-primary hover:bg-bg-surface2 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Load
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => void handleDuplicate(s.scenario_id, s.name)}
                    title="Save a copy under a new name -- the original is untouched"
                    className="h-control rounded-control border border-border bg-bg-surface3 px-sm text-xs text-text-primary hover:bg-bg-surface2 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Duplicate
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => void handleExport(s.scenario_id, s.name)}
                    title="Save this scenario as a standalone .json file (backup, transfer to another install)"
                    className="h-control rounded-control border border-border bg-bg-surface3 px-sm text-xs text-text-primary hover:bg-bg-surface2 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Export
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => void handleDelete(s.scenario_id)}
                    className="h-control rounded-control border border-border bg-bg-surface3 px-sm text-xs text-danger hover:bg-danger hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Delete
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
