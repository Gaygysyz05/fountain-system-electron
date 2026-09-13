import { useEffect, useMemo, useRef, useState } from "react";
import { useConfigStore } from "../../store/configStore";
import { useScenariosStore } from "../../store/scenariosStore";
import { useTimelineStore } from "../../store/timelineStore";
import { describeError } from "../../lib/errors";
import { restClient } from "../../lib/restClient";
import { resolveDeviceIds } from "../../lib/scenario";
import { INPUT_CLASS } from "../../lib/styles";
import { useWheelStep } from "../../lib/useWheelStep";
import { decodeAudioDuration } from "../../lib/waveform";
import { DeviceCategoryTabs } from "./DeviceCategoryTabs";
import { DeviceTablePanel } from "./DeviceTablePanel";
import { ScenarioDevicePicker } from "./ScenarioDevicePicker";
import { SubTab } from "./SubTab";
import { buildNozzleColumns, groupNozzlePairs } from "./deviceColumns";
import type { DeviceType } from "../../lib/protocol";

type SubView = "valves" | "motors" | "nozzles" | "light";

const CATEGORY_BY_SUBVIEW: Record<Exclude<SubView, "nozzles">, DeviceType> = {
  valves: "valve",
  motors: "motor",
  light: "light",
};

/** Scenario ids become filenames on the daemon (persistence.py's `_SAFE_SCENARIO_ID = ^[A-Za-z0-9_-]+$`) -- must only ever produce characters that pattern accepts. */
function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "scenario";
}

/** Authoring screen for one scenario file; Nozzles isn't its own device category -- it's motor devices paired by nozzle_group, so paired motors are excluded from the Motors tab and shown only here. */
export function TimelinePanel(): JSX.Element {
  const zones = useConfigStore((s) => s.zones);
  const loadZones = useConfigStore((s) => s.loadZones);
  const scenarios = useScenariosStore((s) => s.scenarios);
  const loadScenarios = useScenariosStore((s) => s.loadScenarios);
  const deleteScenario = useScenariosStore((s) => s.deleteScenario);

  // Individual selectors, not the whole store -- that re-rendered on every write regardless of relevance, and DeviceTable resets grid selection whenever `columns` changes identity (see DeviceTable.tsx), wiping in-progress edits.
  const scenarioId = useTimelineStore((s) => s.scenarioId);
  const file = useTimelineStore((s) => s.file);
  const dirty = useTimelineStore((s) => s.dirty);
  const saving = useTimelineStore((s) => s.saving);
  const error = useTimelineStore((s) => s.error);
  const setError = useTimelineStore((s) => s.setError);
  const newScenario = useTimelineStore((s) => s.newScenario);
  const loadScenario = useTimelineStore((s) => s.loadScenario);
  const saveScenario = useTimelineStore((s) => s.saveScenario);
  const setName = useTimelineStore((s) => s.setName);
  const setDuration = useTimelineStore((s) => s.setDuration);
  const setMusicFile = useTimelineStore((s) => s.setMusicFile);
  const setDeviceIds = useTimelineStore((s) => s.setDeviceIds);
  const past = useTimelineStore((s) => s.past);
  const future = useTimelineStore((s) => s.future);
  const undo = useTimelineStore((s) => s.undo);
  const redo = useTimelineStore((s) => s.redo);

  const [selectedZoneId, setSelectedZoneId] = useState<number | null>(null);
  const [subView, setSubView] = useState<SubView>("valves");
  const [devicePicker, setDevicePicker] = useState<"new" | "edit" | null>(null);
  // Transient "saved" confirmation -- the dirty dot disappearing is easy to miss; auto-clears rather than lingering until the next click.
  const [justSaved, setJustSaved] = useState(false);

  // Scroll-to-adjust for Duration -- scenarios are timed against music, so this field gets nudged constantly.
  const durationInputRef = useRef<HTMLInputElement>(null);
  useWheelStep(durationInputRef, (direction) => setDuration(Math.max(1, file.duration + direction)));

  useEffect(() => {
    void loadZones();
    void loadScenarios();
  }, [loadZones, loadScenarios]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (!e.ctrlKey) return;
      if (e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undo, redo]);

  useEffect(() => {
    if (selectedZoneId === null && zones.length > 0) setSelectedZoneId(zones[0].zone_id);
  }, [zones, selectedZoneId]);

  // Guards against closing/reloading the window with unsaved edits.
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent): void {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  /** New/Load discard the editor's contents; beforeunload can't catch in-app navigation, so this asks separately. */
  function confirmDiscard(): boolean {
    return !dirty || window.confirm("You have unsaved changes. Discard them?");
  }

  const selectedZone = zones.find((z) => z.zone_id === selectedZoneId) ?? null;
  const devices = selectedZone?.devices ?? [];

  /** Blocking issues refuse the save; warnings (stale device refs, nothing selected) would silently save "wrong" but aren't invalid enough to refuse, so they go through confirm() instead. */
  function validateBeforeSave(): { blocking: string | null; warnings: string[] } {
    if (!(file.duration > 0)) return { blocking: "Duration must be greater than 0 before saving.", warnings: [] };

    const warnings: string[] = [];
    if (devices.length > 0 && resolveDeviceIds(file.deviceIds, devices.map((d) => d.device_id)).length === 0) {
      warnings.push("No devices are selected for this scenario -- every tab will show empty.");
    }
    const zoneDeviceIds = new Set(devices.map((d) => d.device_id));
    const staleCount = new Set(file.events.filter((e) => !zoneDeviceIds.has(e.device_id)).map((e) => e.device_id)).size;
    if (staleCount > 0) {
      warnings.push(`${staleCount} device(s) referenced in this scenario no longer exist in the zone -- their events will be kept but won't play.`);
    }
    return { blocking: null, warnings };
  }

  // resolveDeviceIds falls back to every zone device when deviceIds is unset (pre-picker scenario, or a fresh one), so tabs show everything by default.
  const scenarioDevices = useMemo(() => {
    const ids = new Set(resolveDeviceIds(file.deviceIds, devices.map((d) => d.device_id)));
    return devices.filter((d) => ids.has(d.device_id));
  }, [file.deviceIds, devices]);

  const nozzlePairs = useMemo(
    () => groupNozzlePairs(scenarioDevices.filter((d) => d.category === "motor" && d.nozzle_group)),
    [scenarioDevices],
  );
  const standaloneMotors = scenarioDevices.filter((d) => d.category === "motor" && !d.nozzle_group);
  const nozzleInstanceIds = new Set(nozzlePairs.flatMap((p) => [p.inv1?.instance_id, p.inv2?.instance_id]));

  const fieldClass = INPUT_CLASS;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-sm border-b border-border bg-bg-surface1 p-sm">
        <select
          value={selectedZoneId ?? ""}
          onChange={(e) => setSelectedZoneId(Number(e.target.value))}
          className={fieldClass}
        >
          {zones.map((z) => (
            <option key={z.zone_id} value={z.zone_id}>
              {z.name?.trim() || `Zone ${z.zone_id}`}
            </option>
          ))}
        </select>

        <input value={file.name} onChange={(e) => setName(e.target.value)} placeholder="Scenario name" className={`${fieldClass} w-40`} />

        <label className="flex items-center gap-xs text-sm text-text-secondary">
          Duration
          <input
            ref={durationInputRef}
            type="number"
            min={1}
            value={file.duration}
            onChange={(e) => setDuration(parseFloat(e.target.value) || 0)}
            title="Scroll to adjust"
            className={`${fieldClass} w-20`}
          />
          s
        </label>

        <div className="flex items-center gap-1">
          <button
            onClick={async () => {
              const picked = await window.electron.selectMusicFile();
              if (!picked) return;
              setMusicFile(picked);
              // Picking a track resets duration to match it -- the previous value (often just the "New Scenario" default) had no relationship to the new track.
              try {
                const bytes = await (await fetch(restClient.audioUrl(picked))).arrayBuffer();
                const duration = await decodeAudioDuration(bytes);
                if (duration > 0) setDuration(Math.round(duration * 100) / 100);
              } catch (err) {
                // Duration sync is a convenience, not a requirement -- an unreadable/unsupported file still gets selected as music_file.
                console.warn("could not decode music duration:", err);
              }
            }}
            title={file.music_file ?? "No music selected"}
            className={`${fieldClass} flex max-w-56 items-center gap-xs px-sm hover:bg-bg-surface2`}
          >
            🎵 <span className="truncate">{file.music_file ? file.music_file.replace(/^.*[\\/]/, "") : "Choose music…"}</span>
          </button>
          {file.music_file && (
            <button
              onClick={() => setMusicFile("")}
              title="Clear music"
              className="text-text-muted hover:text-danger"
            >
              ✕
            </button>
          )}
        </div>

        <button
          onClick={() => setDevicePicker("edit")}
          className="h-control rounded-control border border-border bg-bg-surface3 px-md text-sm text-text-primary hover:bg-bg-surface2"
        >
          Edit devices…
        </button>

        <div className="flex-1" />

        <button
          onClick={undo}
          disabled={past.length === 0}
          title="Undo (Ctrl+Z)"
          className="h-control rounded-control border border-border bg-bg-surface3 px-sm text-sm text-text-primary hover:bg-bg-surface2 disabled:cursor-not-allowed disabled:opacity-40"
        >
          ↶ Undo
        </button>
        <button
          onClick={redo}
          disabled={future.length === 0}
          title="Redo (Ctrl+Shift+Z)"
          className="h-control rounded-control border border-border bg-bg-surface3 px-sm text-sm text-text-primary hover:bg-bg-surface2 disabled:cursor-not-allowed disabled:opacity-40"
        >
          ↷ Redo
        </button>

        <select
          value=""
          onChange={(e) => {
            const id = e.target.value;
            if (id && confirmDiscard()) void loadScenario(id);
          }}
          className={fieldClass}
        >
          <option value="">Load…</option>
          {scenarios.map((s) => (
            <option key={s.scenario_id} value={s.scenario_id}>
              {s.name}
            </option>
          ))}
        </select>

        <button
          onClick={() => confirmDiscard() && setDevicePicker("new")}
          className="h-control rounded-control border border-border bg-bg-surface3 px-md text-sm text-text-primary hover:bg-bg-surface2"
        >
          New
        </button>

        <button
          disabled={!scenarioId || saving}
          onClick={async () => {
            if (!scenarioId) return;
            if (!window.confirm(`Delete saved scenario "${scenarioId}"? This can't be undone.`)) return;
            try {
              await deleteScenario(scenarioId);
              newScenario([]);
            } catch (err) {
              setError(describeError(err));
            }
          }}
          title={scenarioId ? `Delete "${scenarioId}"` : "Load or save a scenario first"}
          className="h-control rounded-control border border-border bg-bg-surface3 px-sm text-sm text-danger hover:bg-danger hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-bg-surface3 disabled:hover:text-danger"
        >
          Delete
        </button>

        <button
          disabled={saving}
          title={`Saves as "${slugify(file.name)}.json"`}
          onClick={async () => {
            // Once scenarioId is set, saves keep targeting that same file even if the name changes, so routine edits don't fork into a second file; only a rename onto a DIFFERENT existing id overwrites (after the confirm below).
            const id = scenarioId || slugify(file.name);
            const { blocking, warnings } = validateBeforeSave();
            if (blocking) {
              window.alert(blocking);
              return;
            }
            const overwritesOther = id !== scenarioId && scenarios.some((s) => s.scenario_id === id);
            if (overwritesOther && !window.confirm(`A scenario named "${file.name}" already exists (${id}.json). Overwrite it?`)) return;
            if (warnings.length > 0 && !window.confirm(`${warnings.join("\n")}\n\nSave anyway?`)) return;
            const ok = await saveScenario(id);
            if (ok) {
              await loadScenarios();
              setJustSaved(true);
              window.setTimeout(() => setJustSaved(false), 2000);
            }
          }}
          className="h-control rounded-control bg-primary px-md text-sm text-text-primary hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? "Saving…" : dirty ? "Save •" : "Save"}
        </button>
        {justSaved && <span className="text-sm text-success">✓ Saved</span>}
      </div>

      {error && (
        <div className="flex items-center gap-sm border-b border-danger bg-bg-surface2 px-md py-xs text-sm text-danger">
          <span className="flex-1">⚠ {error}</span>
          <button onClick={() => setError(null)} title="Dismiss" className="text-text-muted hover:text-text-primary">
            ✕
          </button>
        </div>
      )}

      <div className="flex items-center gap-md border-b border-border bg-bg-surface1 px-sm">
        <SubTab label="Valves" active={subView === "valves"} onClick={() => setSubView("valves")} />
        <SubTab label="Motors" active={subView === "motors"} onClick={() => setSubView("motors")} />
        <SubTab label="Nozzles" active={subView === "nozzles"} onClick={() => setSubView("nozzles")} />
        <SubTab label="Light" active={subView === "light"} onClick={() => setSubView("light")} />
      </div>

      {subView === "nozzles" ? (
        // Keyed by zone too -- otherwise DeviceTablePanel's local state (Grid/Timeline mode, Step size) survives a zone switch on this tab.
        <DeviceTablePanel
          key={`nozzles-${selectedZoneId}`}
          category="motor"
          columns={buildNozzleColumns(nozzlePairs)}
          instances={(selectedZone?.driver_instances ?? []).filter((i) => i.category === "motor" && nozzleInstanceIds.has(i.instance_id))}
        />
      ) : (
        // Same reasoning as above -- `subView` alone doesn't distinguish zones.
        <DeviceCategoryTabs
          key={`${subView}-${selectedZoneId}`}
          category={CATEGORY_BY_SUBVIEW[subView]}
          devices={subView === "motors" ? standaloneMotors : scenarioDevices.filter((d) => d.category === CATEGORY_BY_SUBVIEW[subView])}
          instances={(selectedZone?.driver_instances ?? []).filter((i) => i.category === CATEGORY_BY_SUBVIEW[subView])}
        />
      )}

      {devicePicker && selectedZone && (
        <ScenarioDevicePicker
          zone={selectedZone}
          initialSelected={
            devicePicker === "new"
              ? new Set(devices.map((d) => d.device_id))
              : new Set(resolveDeviceIds(file.deviceIds, devices.map((d) => d.device_id)))
          }
          onConfirm={(ids) => {
            if (devicePicker === "new") {
              newScenario(ids);
            } else {
              setDeviceIds(ids);
            }
            setDevicePicker(null);
          }}
          onCancel={() => setDevicePicker(null)}
        />
      )}
    </div>
  );
}
