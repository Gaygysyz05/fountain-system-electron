import { useMemo, useState } from "react";
import { useTimelineStore } from "../../store/timelineStore";
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

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Nearest span boundary on the OTHER side of `pivot` from every span
 * except `excludeIdx` -- the room a drag on this channel is allowed to
 * move into before it would start to overlap a neighbor. Two calls (one
 * per direction) bound every drag mode below; see commitChannelSpans in
 * timelineStore.ts for why staying overlap-free here means that action
 * never has to resolve a collision itself. */
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

/**
 * Drag-to-paint editor for one binary field (valve "on", or eventually a
 * motor's "active") -- the piano-roll's editable counterpart, reusing its
 * exact visual language (ScenarioTimelinePlayer.tsx: same row height,
 * label width, ruler, green ON spans) so switching between the read-only
 * player and this editor doesn't feel like two different products.
 *
 * Exists specifically because the grid (DeviceTable) makes "open valve 5
 * for 3 seconds" cost one click per time-step between the two moments --
 * fine for precise, per-tick programming, painful for shaping a show by
 * feel across dozens of channels. This is deliberately an ADDITIONAL mode
 * (see DeviceTablePanel's Grid/Timeline toggle), not a replacement -- the
 * grid stays the default, and stays how it's always worked.
 *
 * Every drag is clamped against its channel's OWN neighboring spans in
 * real time (roomBefore/roomAfter) so two ON spans on the same device can
 * never overlap -- not detected-and-merged after the fact, prevented
 * during the drag itself, the same way trimming a clip against its
 * neighbor works in ordinary timeline-editing software. Drag tracking
 * uses window-level mousemove/mouseup (see handlePlayheadMouseDown in
 * ScenarioTimelinePlayer.tsx for the same pattern already established
 * there) so a fast drag that leaves the row, or the whole scrollable
 * area, is still tracked correctly.
 */
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

  // One flat WireEvent[] pass suffices for every device's buildToggleSpans
  // call below (it filters by device_id itself) -- avoids re-deriving a
  // per-device map for what's normally a couple dozen events at most.
  const wireEvents = events as WireEvent[];

  const spansByDevice = useMemo(() => {
    const map = new Map<string, ToggleSpan[]>();
    for (const d of devices) {
      map.set(d.device_id, buildToggleSpans(d.device_id, field, category, wireEvents, duration).filter((s) => s.on));
    }
    return map;
  }, [devices, field, category, wireEvents, duration]);

  function beginDrag(deviceId: string, mode: DragMode, idx: number, rowLeft: number, downClientX: number): void {
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

    const onMove = (ev: MouseEvent): void => setDrag(computeLive(ev.clientX));
    const onUp = (ev: MouseEvent): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      commit(computeLive(ev.clientX));
      setDrag(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function onRowMouseDown(deviceId: string, e: React.MouseEvent<HTMLDivElement>): void {
    beginDrag(deviceId, "create", -1, e.currentTarget.getBoundingClientRect().left, e.clientX);
  }

  function onSpanMouseDown(deviceId: string, idx: number, mode: DragMode, e: React.MouseEvent<HTMLDivElement>): void {
    e.stopPropagation();
    const spanEl = mode === "move" ? e.currentTarget : e.currentTarget.parentElement;
    const rowLeft = spanEl?.parentElement?.getBoundingClientRect().left ?? 0;
    beginDrag(deviceId, mode, idx, rowLeft, e.clientX);
  }

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
          const spans = spansByDevice.get(device.device_id) ?? [];
          const isDraggingRow = drag?.deviceId === device.device_id;
          const zebraClass = rowIndex % 2 === 0 ? "bg-bg-surface1" : "bg-bg-base";

          return (
            <div key={device.device_id} className="flex" style={{ height: ROW_HEIGHT }}>
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
                  const isBeingDragged = isDraggingRow && drag?.idx === idx && drag.mode !== "create";
                  const start = isBeingDragged ? drag!.liveStart : s.start;
                  const end = isBeingDragged ? drag!.liveEnd : s.end;
                  const isSelected = selected?.deviceId === device.device_id && selected.idx === idx;
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
                {isDraggingRow && drag?.mode === "create" && drag.moved && (
                  <div
                    className="pointer-events-none absolute top-[7px] bottom-[7px] rounded-sm bg-accent opacity-55"
                    style={{ left: drag.liveStart * PX_PER_SECOND, width: Math.max(2, (drag.liveEnd - drag.liveStart) * PX_PER_SECOND) }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
