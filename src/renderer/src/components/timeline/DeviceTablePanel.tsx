import { useMemo, useState } from "react";
import { useTimelineStore } from "../../store/timelineStore";
import type { ScenarioEvent } from "../../lib/scenario";
import type { DeviceType, DriverInstanceDto } from "../../lib/protocol";
import { DeviceTable } from "./DeviceTable";
import { PatternTool } from "./PatternTool";
import type { DeviceColumn } from "./deviceColumns";

function roundTime(t: number): number {
  return Math.round(t * 10) / 10;
}

/** One line of "how to reach this board, and which physical board this
 * is" -- host/port and Slave ID are each one number for the whole
 * instance (see modbus_valve_driver.py's ModbusValveConfig), not
 * per-channel, so they're shown once here instead of repeated on every
 * column header. Slave ID matters specifically because several relay
 * boards can share one host:port (one RTU/TCP gateway, several boards on
 * the bus) -- device_config.py's original valve setup splits every 32
 * channels onto a new Slave ID for exactly this reason. Different driver
 * configs name the host/port fields differently (host/port vs
 * target_ip/target_port), so this checks both rather than assuming one
 * shape; slave_id is absent for drivers that don't use Modbus (Art-Net). */
function connectionSummary(instance: DriverInstanceDto): string | null {
  const host = instance.config.host ?? instance.config.target_ip;
  const port = instance.config.port ?? instance.config.target_port;
  const slaveId = instance.config.slave_id;
  const parts: string[] = [];
  if (host != null || port != null) parts.push([host, port].filter((v) => v != null).join(":"));
  if (slaveId != null) parts.push(`Slave ID ${slaveId}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

/** For each row time, the most recent event at or before it -- state
 * persists until changed, same rule the daemon's scheduler plays by.
 * `sortedEvents` must already be time-sorted. */
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

/**
 * Renders one already-built set of columns (`columns`) as a table --
 * mirrors component_tables.py's per-type tables (FountainValveTableWidget
 * etc, each with its own time-step resolution), now further scoped to one
 * physical board by DeviceCategoryTabs.tsx when a category has more than
 * one instance. Column *building* (which devices, in what shape) is the
 * caller's job -- TimelinePanel.tsx/DeviceCategoryTabs.tsx pick
 * buildValveColumns/buildMotorColumns/buildLightColumns/buildNozzleColumns
 * depending on which tab this is -- this component only owns the
 * time-step size and computes the effective-state matrix DeviceTable
 * reads from (rows = time, columns = devices/channels -- see
 * DeviceTable.tsx). `category` is still needed here for DeviceTable's
 * default-parameters fallback -- Nozzles columns are motor-shaped
 * ({frequency, active}) even though the tab itself isn't literally
 * category "motor", so callers pass whichever category actually matches
 * the underlying parameter shape. The "Valve pattern…" advanced popover
 * (wave delay/duration) stays valve-only, same scope the original had
 * (Apply Pattern only existed in FountainValveTableWidget's context menu,
 * not the motor/light/nozzle tables).
 */
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

  /** Whether this device has an event stored at exactly this row's time --
   * i.e. this row's value was deliberately set, not inherited from an
   * earlier row via "state persists until changed". Used to cap edits so a
   * single click only affects the row clicked instead of visually bleeding
   * into every later row that has nothing of its own to stop at. */
  function hasExplicit(deviceId: string, rowIndex: number): boolean {
    return explicitTimes.has(`${deviceId}::${rowTimes[rowIndex]}`);
  }

  // A relay has a minimum time between switches (ModbusValveConfig's
  // min_toggle_interval -- the daemon already enforces it at playback
  // time, throttling anything closer together than the hardware
  // datasheet allows). The editor never enforced it, so it was possible
  // to author a pattern that looks right on screen but gets silently
  // slowed down when it actually plays. Flag it instead -- informational
  // only, still lets you type it (maybe you'll widen the step later).
  // Only meaningful for valves, and only when this table is scoped to
  // exactly one instance (the normal case once DeviceCategoryTabs.tsx
  // splits multi-board categories into per-board sub-tabs) -- a mixed-
  // instance table (e.g. Nozzles spanning two gateways) has no single
  // min_toggle_interval to check against, so it's skipped rather than
  // guessed at.
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
    </div>
  );
}
