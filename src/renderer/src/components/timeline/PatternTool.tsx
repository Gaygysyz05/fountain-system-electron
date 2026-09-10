import { useState } from "react";
import { useTimelineStore } from "../../store/timelineStore";
import { INPUT_CLASS } from "../../lib/styles";
import type { ValvePatternType } from "../../lib/scenario";

const inputClass = INPUT_CLASS;
const buttonClass = "h-control rounded-control border border-border bg-bg-surface3 px-sm text-xs text-text-primary hover:bg-bg-surface2";

/**
 * Bulk / animated valve editing -- directly answers "open only even valves,
 * close odd" (select the channels, "Set constant", Apply) and "make some
 * kind of animation" (Alternate) without hand-placing one grid cell per
 * channel per moment. This is the alternating pattern feature the
 * original codebase had (component_tables.py) that the very first audit
 * flagged as worth keeping but this project never built until now.
 */
export function PatternTool({
  devices,
  duration,
  onClose,
}: {
  devices: Array<{ device_id: string; label: string }>;
  duration: number;
  onClose: () => void;
}): JSX.Element {
  const applyValvePattern = useTimelineStore((s) => s.applyValvePattern);

  const [selected, setSelected] = useState<Set<string>>(new Set(devices.map((d) => d.device_id)));
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(duration);
  const [stepInterval, setStepInterval] = useState(1);
  const [pattern, setPattern] = useState<ValvePatternType>("constant");
  const [constantOn, setConstantOn] = useState(true);

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectEvery(offset: number): void {
    setSelected(new Set(devices.filter((_, i) => i % 2 === offset).map((d) => d.device_id)));
  }

  function apply(): void {
    if (selected.size === 0) return;
    applyValvePattern({
      deviceIds: devices.filter((d) => selected.has(d.device_id)).map((d) => d.device_id),
      startTime,
      endTime,
      stepInterval,
      pattern,
      constantOn,
    });
    onClose();
  }

  return (
    <div className="mb-md flex flex-col gap-sm rounded-panel border border-border bg-bg-surface1 p-md">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-text-primary">Valve pattern</span>
        <button onClick={onClose} className="text-xs text-text-muted hover:text-text-secondary">
          Close
        </button>
      </div>

      <div className="flex flex-wrap gap-xs">
        <button onClick={() => setSelected(new Set(devices.map((d) => d.device_id)))} className={buttonClass}>All</button>
        <button onClick={() => setSelected(new Set())} className={buttonClass}>None</button>
        <button onClick={() => selectEvery(0)} className={buttonClass}>1st, 3rd, 5th…</button>
        <button onClick={() => selectEvery(1)} className={buttonClass}>2nd, 4th, 6th…</button>
      </div>

      <div className="flex max-w-2xl flex-wrap gap-xs">
        {devices.map((d) => (
          <label key={d.device_id} title={d.device_id} className="flex items-center gap-1 rounded-control border border-border px-xs py-0.5 text-xs">
            <input type="checkbox" checked={selected.has(d.device_id)} onChange={() => toggle(d.device_id)} className="h-3 w-3 accent-accent" />
            {d.label}
          </label>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-sm">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-text-secondary">Start (s)</span>
          <input type="number" min={0} step={0.1} value={startTime} onChange={(e) => setStartTime(parseFloat(e.target.value) || 0)} className={`${inputClass} w-20`} />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-text-secondary">End (s)</span>
          <input type="number" min={0} step={0.1} value={endTime} onChange={(e) => setEndTime(parseFloat(e.target.value) || 0)} className={`${inputClass} w-20`} />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-text-secondary">Pattern</span>
          <select value={pattern} onChange={(e) => setPattern(e.target.value as ValvePatternType)} className={inputClass}>
            <option value="constant">Set constant</option>
            <option value="alternate">Alternate (flash)</option>
          </select>
        </label>

        {pattern === "constant" && (
          <label className="flex items-center gap-xs text-xs">
            <input type="checkbox" checked={constantOn} onChange={(e) => setConstantOn(e.target.checked)} className="h-3 w-3 accent-accent" />
            <span className="text-text-secondary">On (unchecked = Off)</span>
          </label>
        )}

        {pattern === "alternate" && (
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-text-secondary">Step (s)</span>
            <input type="number" min={0.1} step={0.1} value={stepInterval} onChange={(e) => setStepInterval(parseFloat(e.target.value) || 1)} className={`${inputClass} w-20`} />
          </label>
        )}

        <button
          onClick={apply}
          disabled={selected.size === 0}
          className="h-control rounded-control bg-primary px-md text-sm text-text-primary hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-primary"
        >
          Apply to {selected.size} valve{selected.size === 1 ? "" : "s"}
        </button>
      </div>
    </div>
  );
}
