import { useMemo, useState } from "react";
import { useTimelineStore } from "../../store/timelineStore";
import type { ScenarioEvent } from "../../lib/scenario";
import type { DeviceType, DriverInstanceDto } from "../../lib/protocol";
import { DeviceTable } from "./DeviceTable";
import { PatternTool } from "./PatternTool";
import { PianoRollEditor } from "./PianoRollEditor";
import type { DeviceColumn } from "./deviceColumns";

function roundTime(t: number): number {
  return Math.round(t * 10) / 10;
}

// Field names vary by driver (host/port vs target_ip/target_port) and slave_id is absent for non-Modbus drivers (Art-Net), so both are checked defensively.
function connectionSummary(instance: DriverInstanceDto): string | null {
  const host = instance.config.host ?? instance.config.target_ip;
  const port = instance.config.port ?? instance.config.target_port;
  const slaveId = instance.config.slave_id;
  const parts: string[] = [];
  if (host != null || port != null) parts.push([host, port].filter((v) => v != null).join(":"));
  if (slaveId != null) parts.push(`Slave ID ${slaveId}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

// State persists until changed, matching the daemon's scheduler; `sortedEvents` must already be time-sorted.
function computeEffectiveRow(sortedEvents: ScenarioEvent[], rowTimes: number[]): Array<Record<string, unknown> | undefined> {
  const result: Array<Record<string, unknown> | undefined> = [];
  let idx = 0;
  let current: Record<string, unknown> | undefined;
  for (const t of rowTimes) {
    while (idx < sortedEvents.length && sortedEvents[idx].time <= t) {
      current = sortedEvents[idx].parameters;
      idx++;
    }
    result.push(current);
  }
  return result;
}

// `category` is passed separately from the already-built `columns` because DeviceTable needs it for its default-parameters fallback -- e.g. Nozzles columns are motor-shaped ({frequency, active}) even though the tab isn't literally category "motor".
export function DeviceTablePanel({
  category,
  columns,
  instances,
}: {
  category: DeviceType;
  columns: DeviceColumn[];
  instances: DriverInstanceDto[];
}): JSX.Element {
  const duration = useTimelineStore((s) => s.file.duration);
  const events = useTimelineStore((s) => s.file.events);

  const [step, setStep] = useState(1);
  const [showPatternTool, setShowPatternTool] = useState(false);
  // Defaults to grid on every mount so a returning operator sees the same view; timeline mode is valve-only for now since motor rows mix Hz with the toggle field.
  const [mode, setMode] = useState<"grid" | "timeline">("grid");

  const rowTimes = useMemo(() => {
    const times: number[] = [];
    for (let t = 0; t <= duration + 1e-9; t += step) times.push(roundTime(t));
    return times;
  }, [duration, step]);

  const { effectiveByDevice, explicitTimes } = useMemo(() => {
    const byDevice = new Map<string, ScenarioEvent[]>();
    for (const e of events) {
      const list = byDevice.get(e.device_id) ?? [];
      list.push(e);
      byDevice.set(e.device_id, list);
    }
    for (const list of byDevice.values()) list.sort((a, b) => a.time - b.time);

    const deviceIds = new Set(columns.map((c) => c.deviceId));
    const effective = new Map<string, Array<Record<string, unknown> | undefined>>();
    for (const deviceId of deviceIds) {
      effective.set(deviceId, computeEffectiveRow(byDevice.get(deviceId) ?? [], rowTimes));
    }
    const explicit = new Set(events.map((e) => `${e.device_id}::${e.time}`));
    return { effectiveByDevice: effective, explicitTimes: explicit };
  }, [columns, events, rowTimes]);

  function getEffective(deviceId: string, rowIndex: number): Record<string, unknown> | undefined {
    return effectiveByDevice.get(deviceId)?.[rowIndex];
  }

  // True only if this exact row has a stored event (not an inherited value); caps edits to the row clicked rather than bleeding into later rows.
  function hasExplicit(deviceId: string, rowIndex: number): boolean {
    return explicitTimes.has(`${deviceId}::${rowTimes[rowIndex]}`);
  }

  // Flagged, not blocked: the daemon already throttles switches faster than min_toggle_interval at playback, so this just warns rather than guesses at a fix. Only checked for single-instance valve tables since a mixed-instance table has no single interval to check against.
  const minToggleInterval = category === "valve" && instances.length === 1 ? Number(instances[0].config.min_toggle_interval ?? 0) : 0;

  const flaggedCells = useMemo(() => {
    const flagged = new Set<string>();
    if (!minToggleInterval) return flagged;
    for (const column of columns) {
      if (column.kind !== "toggle") continue;
      let lastToggleTime: number | null = null;
      let lastValue: boolean | undefined;
      for (let r = 0; r < rowTimes.length; r++) {
        if (!hasExplicit(column.deviceId, r)) continue;
        const value = Boolean(getEffective(column.deviceId, r)?.[column.field]);
        if (lastValue !== undefined && value !== lastValue) {
          if (lastToggleTime !== null && rowTimes[r] - lastToggleTime < minToggleInterval) {
            flagged.add(`${column.deviceId}::${r}`);
          }
          lastToggleTime = rowTimes[r];
        } else if (lastToggleTime === null) {
          lastToggleTime = rowTimes[r];
        }
        lastValue = value;
      }
    }
    return flagged;
  }, [columns, rowTimes, minToggleInterval, effectiveByDevice, explicitTimes]);

  function isFlagged(deviceId: string, rowIndex: number): boolean {
    return flaggedCells.has(`${deviceId}::${rowIndex}`);
  }

  if (columns.length === 0) {
    return (
      <p className="p-lg text-sm text-text-muted">
        No {category} devices selected for this scenario -- add some via "Edit devices…" above, or configure some on the Devices tab first.
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col p-md">
      <div className="mb-sm flex flex-wrap items-center gap-sm">
        {category === "valve" && (
          <div className="flex overflow-hidden rounded-control border border-border">
            <button
              onClick={() => setMode("grid")}
              title="Dense per-time-step spreadsheet -- precise, one click per moment"
              className={`px-sm py-1 text-sm ${mode === "grid" ? "bg-accent text-text-primary" : "bg-bg-surface3 text-text-secondary hover:bg-bg-surface2"}`}
            >
              Grid
            </button>
            <button
              onClick={() => setMode("timeline")}
              title="Drag directly on a channel's row to paint how long it's open -- faster for shaping a show, less precise than typing an exact tick"
              className={`px-sm py-1 text-sm ${mode === "timeline" ? "bg-accent text-text-primary" : "bg-bg-surface3 text-text-secondary hover:bg-bg-surface2"}`}
            >
              Timeline
            </button>
          </div>
        )}
        {mode === "grid" && (
          <>
            <label className="flex items-center gap-xs text-sm text-text-secondary">
              Step
              <input
                type="number"
                min={0.1}
                step={0.1}
                value={step}
                onChange={(e) => setStep(Math.max(0.1, parseFloat(e.target.value) || 1))}
                className="h-input w-20 rounded-control border border-border bg-bg-surface3 px-sm text-sm text-text-primary focus:border-accent focus:outline-none"
              />
              s
            </label>
            {category === "valve" && (
              <button
                onClick={() => setShowPatternTool((v) => !v)}
                className="h-control rounded-control border border-border bg-bg-surface3 px-md text-sm text-text-primary hover:bg-bg-surface2"
              >
                Valve pattern…
              </button>
            )}
            <span className="text-xs text-text-muted">
              Drag or click a header to select, arrow keys to move, right-click for bulk actions, Ctrl+C/Ctrl+V to copy/paste.
              {minToggleInterval > 0 && <> A <span className="text-warning">▸</span> corner marks a toggle faster than this relay's {minToggleInterval}s minimum.</>}
            </span>
          </>
        )}
        {mode === "timeline" && (
          <span className="text-xs text-text-muted">
            Drag on a row to paint how long a valve is open. Drag an edge to resize, the middle to move. Click a span, then Delete to remove it. Spans can't overlap on the same valve.
          </span>
        )}
      </div>

      {instances.length > 0 && (
        <div className="mb-sm flex flex-wrap gap-md text-xs text-text-muted">
          {instances.map((instance) => {
            const conn = connectionSummary(instance);
            return (
              <span key={instance.instance_id}>
                <span className="text-text-secondary">{instance.instance_id}</span>
                {conn && <> — {conn}</>}
                {!instance.connected && <span className="text-danger"> (disconnected)</span>}
              </span>
            );
          })}
        </div>
      )}

      {mode === "grid" ? (
        <>
          {showPatternTool && category === "valve" && (
            <PatternTool
              devices={columns.filter((c) => c.kind === "toggle").map((c) => ({ device_id: c.deviceId, label: c.label }))}
              duration={duration}
              onClose={() => setShowPatternTool(false)}
            />
          )}
          <div className="min-h-0 flex-1 overflow-auto">
            <DeviceTable category={category} columns={columns} rowTimes={rowTimes} getEffective={getEffective} hasExplicit={hasExplicit} isFlagged={isFlagged} />
          </div>
        </>
      ) : (
        <PianoRollEditor
          category={category}
          field="on"
          devices={columns.filter((c) => c.kind === "toggle").map((c) => ({ device_id: c.deviceId, label: c.label }))}
          duration={duration}
        />
      )}
    </div>
  );
}
