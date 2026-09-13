import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTimelineStore } from "../../store/timelineStore";
import { formatTime } from "../../lib/formatTime";
import { buildToggleSpans, type ToggleSpan, type WireEvent } from "../playback/scenarioTimeline";
import type { DeviceType } from "../../lib/protocol";

const ROW_HEIGHT = 34;
const RULER_HEIGHT = 34;
const LABEL_WIDTH = 70;
const MIN_SPAN = 0.2;
const PULSE_LENGTH = 0.5;
const SNAP = 0.1;
const MOVE_THRESHOLD_PX = 3;
const PX_PER_SECOND = 40;

function snap(t: number): number {
  return Math.round(t / SNAP) * SNAP;
}

/** Bounds a drag to the room before it would overlap a neighboring span, so commitChannelSpans never has to resolve overlaps itself. */
function roomBefore(spans: ToggleSpan[], excludeIdx: number | null, pivot: number): number {
  let bound = 0;
  spans.forEach((s, i) => {
    if (i !== excludeIdx && s.end <= pivot) bound = Math.max(bound, s.end);
  });
  return bound;
}
function roomAfter(spans: ToggleSpan[], excludeIdx: number | null, pivot: number, duration: number): number {
  let bound = duration;
  spans.forEach((s, i) => {
    if (i !== excludeIdx && s.start >= pivot) bound = Math.min(bound, s.start);
  });
  return bound;
}

type DragMode = "create" | "move" | "resize-left" | "resize-right";

interface DragState {
  deviceId: string;
  mode: DragMode;
  idx: number; // -1 for "create" (not an existing span yet)
  moved: boolean;
  liveStart: number;
  liveEnd: number;
}

/** Drag-to-paint editor for one binary field, matching ScenarioTimelinePlayer's visual language as an additional mode alongside the grid (not a replacement); drags are clamped in real time against sibling spans so ON spans on one channel can never overlap, using window-level mouse listeners so a fast drag stays tracked even off the row. */
export function PianoRollEditor({
  category,
  field,
  devices,
  duration,
}: {
  category: DeviceType;
  field: string;
  devices: Array<{ device_id: string; label: string }>;
  duration: number;
}): JSX.Element {
  const events = useTimelineStore((s) => s.file.events);
  const commitChannelSpans = useTimelineStore((s) => s.commitChannelSpans);

  const [drag, setDrag] = useState<DragState | null>(null);
  const [selected, setSelected] = useState<{ deviceId: string; idx: number } | null>(null);
  const timelineWidth = duration * PX_PER_SECOND;

  // A mouseup landing outside the window never reaches us, so without this a stale drag's listeners stay attached and would commit corrupt data on top of the next drag; beginDrag and unmount both force-tear it down.
  const dragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanupRef.current?.(), []);

  // Passed as-is to each device's buildToggleSpans call (it filters by device_id itself) rather than pre-splitting into a per-device map.
  const wireEvents = events as WireEvent[];

  const spansByDevice = useMemo(() => {
    const map = new Map<string, ToggleSpan[]>();
    for (const d of devices) {
      map.set(d.device_id, buildToggleSpans(d.device_id, field, category, wireEvents, duration).filter((s) => s.on));
    }
    return map;
  }, [devices, field, category, wireEvents, duration]);

  // useCallback so PianoRollRow's React.memo sees stable callback props; its own deps stay stable mid-drag since spansByDevice only rebuilds when file.events changes (on commit, not on every mousemove).
  const beginDrag = useCallback((deviceId: string, mode: DragMode, idx: number, rowLeft: number, downClientX: number): void => {
    dragCleanupRef.current?.(); // force-close any drag left over from an off-window mouseup (see dragCleanupRef)

    const spans = spansByDevice.get(deviceId) ?? [];
    const anchorTime = Math.max(0, Math.min(duration, (downClientX - rowLeft) / PX_PER_SECOND));
    const existing = idx >= 0 ? spans[idx] : null;
    const origStart = existing?.start ?? anchorTime;
    const origEnd = existing?.end ?? anchorTime;

    setSelected(idx >= 0 ? { deviceId, idx } : null);
    setDrag({ deviceId, mode, idx, moved: false, liveStart: origStart, liveEnd: origEnd });

    function computeLive(clientX: number): DragState {
      const t = Math.max(0, Math.min(duration, (clientX - rowLeft) / PX_PER_SECOND));
      const moved = Math.abs(t - anchorTime) * PX_PER_SECOND > MOVE_THRESHOLD_PX;

      if (mode === "create") {
        const min = roomBefore(spans, null, anchorTime);
        const max = roomAfter(spans, null, anchorTime, duration);
        return { deviceId, mode, idx, moved, liveStart: Math.max(min, Math.min(anchorTime, t)), liveEnd: Math.min(max, Math.max(anchorTime, t)) };
      }
      if (mode === "move") {
        const min = roomBefore(spans, idx, origStart);
        const max = roomAfter(spans, idx, origEnd, duration);
        const length = origEnd - origStart;
        const start = Math.max(min, Math.min(max - length, origStart + (t - anchorTime)));
        return { deviceId, mode, idx, moved, liveStart: start, liveEnd: start + length };
      }
      if (mode === "resize-left") {
        const min = roomBefore(spans, idx, origStart);
        return { deviceId, mode, idx, moved, liveStart: Math.max(min, Math.min(t, origEnd - MIN_SPAN)), liveEnd: origEnd };
      }
      // resize-right
      const max = roomAfter(spans, idx, origEnd, duration);
      return { deviceId, mode, idx, moved, liveStart: origStart, liveEnd: Math.min(max, Math.max(t, origStart + MIN_SPAN)) };
    }

    function commit(final: DragState): void {
      const rest = spans.filter((_, i) => i !== idx);
      if (final.mode === "create") {
        if (!final.moved) {
          const min = roomBefore(spans, null, anchorTime);
          const max = roomAfter(spans, null, anchorTime, duration);
          const start = snap(Math.max(min, anchorTime));
          const end = Math.min(max, start + PULSE_LENGTH);
          if (end - start >= MIN_SPAN) commitChannelSpans(deviceId, field, [...rest, { start, end }]);
        } else if (final.liveEnd - final.liveStart >= MIN_SPAN) {
          commitChannelSpans(deviceId, field, [...rest, { start: snap(final.liveStart), end: snap(final.liveEnd) }]);
        }
        return;
      }
      commitChannelSpans(deviceId, field, [...rest, { start: snap(final.liveStart), end: snap(final.liveEnd) }]);
    }

    let lastClientX = downClientX;
    const onMove = (ev: MouseEvent): void => {
      lastClientX = ev.clientX;
      setDrag(computeLive(ev.clientX));
    };
    function cleanup(): void {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("blur", onBlur);
      dragCleanupRef.current = null;
    }
    const onUp = (ev: MouseEvent): void => {
      cleanup();
      commit(computeLive(ev.clientX));
      setDrag(null);
    };
    // blur catches drags that end without a mouseup ever reaching the window, falling back to the last known position since blur carries no clientX.
    const onBlur = (): void => {
      cleanup();
      commit(computeLive(lastClientX));
      setDrag(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("blur", onBlur);
    dragCleanupRef.current = cleanup;
  }, [spansByDevice, duration, commitChannelSpans, field]);

  const onRowMouseDown = useCallback(
    (deviceId: string, e: React.MouseEvent<HTMLDivElement>): void => {
      beginDrag(deviceId, "create", -1, e.currentTarget.getBoundingClientRect().left, e.clientX);
    },
    [beginDrag],
  );

  const onSpanMouseDown = useCallback(
    (deviceId: string, idx: number, mode: DragMode, e: React.MouseEvent<HTMLDivElement>): void => {
      e.stopPropagation();
      const spanEl = mode === "move" ? e.currentTarget : e.currentTarget.parentElement;
      const rowLeft = spanEl?.parentElement?.getBoundingClientRect().left ?? 0;
      beginDrag(deviceId, mode, idx, rowLeft, e.clientX);
    },
    [beginDrag],
  );

  function deleteSelected(): void {
    if (!selected) return;
    const spans = spansByDevice.get(selected.deviceId) ?? [];
    commitChannelSpans(selected.deviceId, field, spans.filter((_, i) => i !== selected.idx));
    setSelected(null);
  }

  const ticks: Array<{ t: number; left: number }> = [];
  const tickStep = PX_PER_SECOND >= 20 ? 2 : PX_PER_SECOND >= 8 ? 5 : 10;
  for (let t = 0; t <= duration; t += tickStep) ticks.push({ t, left: t * PX_PER_SECOND });

  return (
    <div
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Delete" || e.key === "Backspace") deleteSelected();
      }}
      onClick={() => setSelected(null)}
      className="flex min-h-0 flex-1 flex-col overflow-auto outline-none"
    >
      <div style={{ width: LABEL_WIDTH + timelineWidth }} className="relative">
        <div style={{ height: RULER_HEIGHT }} className="sticky top-0 z-20 flex border-b border-border-light bg-bg-surface1">
          <div style={{ width: LABEL_WIDTH }} className="shrink-0 border-r border-bg-surface2" />
          <div className="relative" style={{ width: timelineWidth }}>
            {ticks.map(({ t, left }) => (
              <div
                key={t}
                style={{ left, lineHeight: `${RULER_HEIGHT}px` }}
                className="absolute top-0 h-full border-l border-bg-surface2 pl-1 font-mono text-[10px] text-text-disabled"
              >
                {formatTime(t)}
              </div>
            ))}
          </div>
        </div>

        {devices.map((device, rowIndex) => {
          const isDraggingRow = drag?.deviceId === device.device_id;
          return (
            <PianoRollRow
              key={device.device_id}
              device={device}
              rowIndex={rowIndex}
              spans={spansByDevice.get(device.device_id) ?? []}
              timelineWidth={timelineWidth}
              isDraggingRow={isDraggingRow}
              dragMode={isDraggingRow ? (drag!.mode) : null}
              dragMoved={isDraggingRow && drag!.moved}
              dragIdx={isDraggingRow ? drag!.idx : -1}
              dragLiveStart={isDraggingRow ? drag!.liveStart : 0}
              dragLiveEnd={isDraggingRow ? drag!.liveEnd : 0}
              isRowSelected={selected?.deviceId === device.device_id}
              selectedIdx={selected?.deviceId === device.device_id ? selected.idx : -1}
              onRowMouseDown={onRowMouseDown}
              onSpanMouseDown={onSpanMouseDown}
            />
          );
        })}
      </div>
    </div>
  );
}

/** Memoized so a drag's per-mousemove setDrag only re-renders the dragged row; requires the parent to pass per-row primitives (isDraggingRow, dragLiveStart, etc.) rather than the raw drag/selected objects, or every row would see a changed prop each tick. */
const PianoRollRow = memo(function PianoRollRow({
  device,
  rowIndex,
  spans,
  timelineWidth,
  isDraggingRow,
  dragMode,
  dragMoved,
  dragIdx,
  dragLiveStart,
  dragLiveEnd,
  isRowSelected,
  selectedIdx,
  onRowMouseDown,
  onSpanMouseDown,
}: {
  device: { device_id: string; label: string };
  rowIndex: number;
  spans: ToggleSpan[];
  timelineWidth: number;
  isDraggingRow: boolean;
  dragMode: DragMode | null;
  dragMoved: boolean;
  dragIdx: number;
  dragLiveStart: number;
  dragLiveEnd: number;
  isRowSelected: boolean;
  selectedIdx: number;
  onRowMouseDown: (deviceId: string, e: React.MouseEvent<HTMLDivElement>) => void;
  onSpanMouseDown: (deviceId: string, idx: number, mode: DragMode, e: React.MouseEvent<HTMLDivElement>) => void;
}): JSX.Element {
  const zebraClass = rowIndex % 2 === 0 ? "bg-bg-surface1" : "bg-bg-base";

  return (
    <div className="flex" style={{ height: ROW_HEIGHT }}>
      <div
        title={device.device_id}
        className={`sticky left-0 z-10 flex shrink-0 items-center border-r border-bg-surface2 pl-md font-mono text-xs font-medium text-text-secondary ${zebraClass}`}
        style={{ width: LABEL_WIDTH }}
      >
        {device.label}
      </div>
      <div
        onMouseDown={(e) => onRowMouseDown(device.device_id, e)}
        className={`relative h-full cursor-crosshair ${zebraClass}`}
        style={{ width: timelineWidth }}
      >
        <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-bg-surface3" />
        {spans.map((s, idx) => {
          const isBeingDragged = isDraggingRow && dragIdx === idx && dragMode !== "create";
          const start = isBeingDragged ? dragLiveStart : s.start;
          const end = isBeingDragged ? dragLiveEnd : s.end;
          const isSelected = isRowSelected && selectedIdx === idx;
          return (
            <div
              key={idx}
              onMouseDown={(e) => onSpanMouseDown(device.device_id, idx, "move", e)}
              onClick={(e) => e.stopPropagation()}
              title={`${device.device_id}: ${start.toFixed(1)}s – ${end.toFixed(1)}s`}
              className={`absolute top-[7px] bottom-[7px] cursor-grab rounded-sm bg-success ${isSelected ? "ring-2 ring-accent" : ""}`}
              style={{ left: start * PX_PER_SECOND, width: Math.max(2, (end - start) * PX_PER_SECOND) }}
            >
              <div onMouseDown={(e) => onSpanMouseDown(device.device_id, idx, "resize-left", e)} className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize" />
              <div onMouseDown={(e) => onSpanMouseDown(device.device_id, idx, "resize-right", e)} className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize" />
            </div>
          );
        })}
        {isDraggingRow && dragMode === "create" && dragMoved && (
          <div
            className="pointer-events-none absolute top-[7px] bottom-[7px] rounded-sm bg-accent opacity-55"
            style={{ left: dragLiveStart * PX_PER_SECOND, width: Math.max(2, (dragLiveEnd - dragLiveStart) * PX_PER_SECOND) }}
          />
        )}
      </div>
    </div>
  );
});
