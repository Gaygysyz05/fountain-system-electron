import { useEffect, useMemo, useRef, useState } from "react";
import { restClient } from "../../lib/restClient";
import { describeError } from "../../lib/errors";
import { formatTime } from "../../lib/formatTime";
import { resolveDeviceIds } from "../../lib/scenario";
import { zonePositions } from "../../lib/livePosition";
import { getContrastTextClass, groupDevicesByInstance } from "../timeline/deviceColumns";
import { useConnectionStore } from "../../store/connectionStore";
import { TransportButtons } from "./TransportButtons";
import { buildColorSpans, buildFrequencyMarkers, buildToggleSpans, pickTickStepSeconds, type WireEvent } from "./scenarioTimeline";
import type { DeviceDto, DeviceType, DriverInstanceDto } from "../../lib/protocol";

const CATEGORY_ORDER: DeviceType[] = ["valve", "motor", "light"];
const CATEGORY_LABEL: Record<DeviceType, string> = { valve: "Valves", motor: "Motors", light: "Light" };
const CATEGORY_PREFIX: Record<DeviceType, string> = { valve: "V", motor: "M", light: "L" };
const ROW_HEIGHT = 34;
const HEADER_HEIGHT = 28;
const INSTANCE_HEADER_HEIGHT = 24;
const RULER_HEIGHT = 34;
const LABEL_WIDTH = 70;
const MIN_PX_PER_SECOND = 4;
const MAX_PX_PER_SECOND = 200;

/**
 * Read-only "piano roll" of an entire scenario -- every scheduled event for
 * every device, laid out across the whole duration, with a playhead that
 * tracks the zone's actual live position. What the spreadsheet Timeline
 * editor doesn't give you: the shape of the whole show at a glance, and a
 * way to watch it move in real time against what's actually happening on
 * site. A fully self-sufficient view -- its own transport bar, not just a
 * chart hanging off the Controls tab -- so switching to this tab doesn't
 * strand you without Play/Stop. No cell here is editable; the ruler and the
 * playhead itself both seek.
 */
export function ScenarioTimelinePlayer({
  zoneId,
  scenarioId,
  scenarioName,
  devices,
  instances,
  canPlay,
  loopEnabled,
  onToggleLoop,
}: {
  zoneId: number;
  scenarioId: string;
  scenarioName: string;
  devices: DeviceDto[];
  instances: DriverInstanceDto[];
  canPlay: boolean;
  loopEnabled: boolean;
  onToggleLoop: () => void;
}): JSX.Element {
  const sendCommand = useConnectionStore((s) => s.sendCommand);
  const [full, setFull] = useState<{ duration: number; events: WireEvent[]; device_ids?: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pxPerSecond, setPxPerSecond] = useState(20);
  // A short scenario at a low zoom level leaves the content narrower than
  // the panel -- without this, that leftover area just showed the bare
  // page background past the last row, reading as broken/unfinished rather
  // than "nothing scheduled here". Rows stretch to whichever is wider.
  const [containerWidth, setContainerWidth] = useState(0);
  // Bumped by the Refresh button -- this tab mounts fresh (and so refetches)
  // whenever you navigate back to it, which covers editing a scenario and
  // returning here, but there's no signal at all if a save happens while
  // this view is already open. This forces a refetch without needing
  // scenarioId itself to change.
  const [reloadKey, setReloadKey] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const playheadLabelRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setFull(null);
    setError(null);
    restClient
      .getScenarioFull(scenarioId)
      .then((f) => {
        if (!cancelled) setFull(f);
      })
      .catch((e) => {
        if (!cancelled) setError(describeError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [scenarioId, reloadKey]);

  useEffect(() => {
    let frame: number;
    const tick = (): void => {
      if (!isDraggingRef.current) {
        const live = zonePositions.get(zoneId);
        const x = live ? live.position * pxPerSecond : 0;
        if (playheadRef.current) playheadRef.current.style.transform = `translateX(${x}px)`;
        if (playheadLabelRef.current) {
          playheadLabelRef.current.style.transform = `translateX(${x}px)`;
          if (live) playheadLabelRef.current.textContent = formatTime(live.position);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [zoneId, pxPerSecond]);

  // Shift+wheel zooms instead of scrolling -- plain wheel still scrolls the
  // timeline normally. Needs a native, non-passive listener: React's
  // onWheel is passive by default, so e.preventDefault() inside a JSX
  // handler would silently no-op and the page would scroll out from under
  // the zoom gesture (same reason useWheelStep.ts exists for numeric
  // fields elsewhere in this app).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent): void {
      if (!e.shiftKey) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      setPxPerSecond((v) => Math.max(MIN_PX_PER_SECOND, Math.min(MAX_PX_PER_SECOND, Math.round(v * factor))));
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [full]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setContainerWidth(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [full]);

  const sections = useMemo(() => {
    if (!full) return [];
    const scopedIds = new Set(resolveDeviceIds(full.device_ids ?? [], devices.map((d) => d.device_id)));
    return CATEGORY_ORDER.map((category) => {
      const categoryDevices = devices.filter((d) => d.category === category && scopedIds.has(d.device_id));
      const categoryInstances = instances.filter((i) => i.category === category);
      const groups = groupDevicesByInstance(categoryDevices, categoryInstances)
        .map((g) => ({ instance: g.instance, devices: [...g.devices].sort((a, b) => Number(a.channel) - Number(b.channel)) }))
        .filter((g) => g.devices.length > 0);
      return { category, groups };
    }).filter((s) => s.groups.length > 0);
  }, [full, devices, instances]);

  function seekToClientX(clientX: number): number | null {
    if (!full || !contentRef.current) return null;
    const rect = contentRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(width, clientX - rect.left - LABEL_WIDTH));
    return Math.max(0, Math.min(full.duration, x / pxPerSecond));
  }

  function handleRulerClick(e: React.MouseEvent<HTMLDivElement>): void {
    const time = seekToClientX(e.clientX);
    if (time !== null) void sendCommand({ command: "SEEK_ZONE", zone_id: zoneId, position: time });
  }

  // Dragging the playhead line itself -- clicking the thin ruler strip to
  // seek is easy to miss; grabbing the line you can already see and pulling
  // it is the more obvious move, so it needs to actually work. Visual
  // position updates locally (via the same ref/style pattern the live
  // rAF loop uses, paused for the duration of the drag) and the real
  // SEEK_ZONE command only fires once, on release, instead of flooding the
  // WS channel on every mousemove.
  function handlePlayheadMouseDown(e: React.MouseEvent): void {
    if (!full) return;
    e.preventDefault();
    isDraggingRef.current = true;

    const onMove = (ev: MouseEvent): void => {
      const time = seekToClientX(ev.clientX);
      if (time === null) return;
      const x = time * pxPerSecond;
      if (playheadRef.current) playheadRef.current.style.transform = `translateX(${x}px)`;
      if (playheadLabelRef.current) {
        playheadLabelRef.current.style.transform = `translateX(${x}px)`;
        playheadLabelRef.current.textContent = formatTime(time);
      }
    };
    const onUp = (ev: MouseEvent): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      isDraggingRef.current = false;
      const time = seekToClientX(ev.clientX);
      if (time !== null) void sendCommand({ command: "SEEK_ZONE", zone_id: zoneId, position: time });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function fitToWidth(): void {
    if (!full || !scrollRef.current) return;
    const available = scrollRef.current.clientWidth - LABEL_WIDTH - 8;
    setPxPerSecond(Math.max(MIN_PX_PER_SECOND, Math.min(MAX_PX_PER_SECOND, Math.floor(available / Math.max(1, full.duration)))));
  }

  const duration = full?.duration ?? 0;
  const width = Math.max(1, duration * pxPerSecond);
  const contentWidth = Math.max(width + LABEL_WIDTH, containerWidth);
  const tickStep = pickTickStepSeconds(pxPerSecond);
  const ticks: number[] = [];
  for (let t = 0; t <= duration + 1e-9; t += tickStep) ticks.push(Math.round(t * 100) / 100);
  const totalGroups = sections.reduce((n, s) => n + s.groups.length, 0);
  const totalLanes = sections.reduce((n, s) => n + s.groups.reduce((gn, g) => gn + g.devices.length, 0), 0);
  const contentHeight = RULER_HEIGHT + sections.length * HEADER_HEIGHT + totalGroups * INSTANCE_HEADER_HEIGHT + totalLanes * ROW_HEIGHT;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg-base p-lg">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[8px] border border-border-light bg-bg-base">
        <div className="flex shrink-0 flex-wrap items-center gap-md bg-bg-surface1 px-lg py-sm">
          <div className="min-w-0 truncate text-sm font-semibold text-text-primary">{scenarioName}</div>
          <div className="h-[22px] w-px bg-border-light" />
          <TransportButtons zoneId={zoneId} scenarioId={scenarioId} canPlay={canPlay} loopEnabled={loopEnabled} onToggleLoop={onToggleLoop} compact />
          <div className="h-[22px] w-px bg-border-light" />

          <div className="ml-auto flex items-center gap-xs text-xs text-text-muted">
            <span>Zoom</span>
            <button
              onClick={() => setPxPerSecond((v) => Math.max(MIN_PX_PER_SECOND, Math.round(v * 0.7)))}
              className="flex h-[22px] w-[22px] items-center justify-center rounded-control border border-border bg-bg-surface3 text-text-secondary hover:bg-bg-surface2"
            >
              −
            </button>
            <input
              type="range"
              min={MIN_PX_PER_SECOND}
              max={MAX_PX_PER_SECOND}
              value={pxPerSecond}
              onChange={(e) => setPxPerSecond(Number(e.target.value))}
              className="w-28 accent-accent"
            />
            <button
              onClick={() => setPxPerSecond((v) => Math.min(MAX_PX_PER_SECOND, Math.round(v * 1.4) || v + 1))}
              className="flex h-[22px] w-[22px] items-center justify-center rounded-control border border-border bg-bg-surface3 text-text-secondary hover:bg-bg-surface2"
            >
              +
            </button>
            <span className="w-11 font-mono tabular-nums text-text-secondary">{pxPerSecond}px/s</span>
            <button onClick={fitToWidth} className="rounded-control border border-border bg-bg-surface3 px-xs py-0.5 text-text-secondary hover:bg-bg-surface2">
              Fit
            </button>
            <button
              onClick={() => setReloadKey((k) => k + 1)}
              title="Reload this scenario's events from disk -- in case it was saved while this tab was already open"
              className="rounded-control border border-border bg-bg-surface3 px-xs py-0.5 text-text-secondary hover:bg-bg-surface2"
            >
              ↻ Refresh
            </button>
          </div>
        </div>

        {error && <p className="p-lg text-sm text-danger">{error}</p>}
        {!error && !full && <p className="p-lg text-sm text-text-muted">Loading timeline…</p>}

        {full && (
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
            <div ref={contentRef} style={{ width: contentWidth }} className="relative">
              {/* Ruler */}
              <div style={{ height: RULER_HEIGHT }} className="sticky top-0 z-20 flex border-b border-border-light bg-bg-surface1">
                <div style={{ width: LABEL_WIDTH }} className="shrink-0 border-r border-bg-surface2" />
                <div onClick={handleRulerClick} className="relative cursor-pointer" style={{ width }}>
                  {ticks.map((t) => (
                    <div
                      key={t}
                      style={{ left: t * pxPerSecond, lineHeight: `${RULER_HEIGHT}px` }}
                      className="absolute top-0 h-full border-l border-bg-surface2 pl-1 font-mono text-[10px] text-text-disabled"
                    >
                      {formatTime(t)}
                    </div>
                  ))}
                  <div
                    ref={playheadLabelRef}
                    className="pointer-events-none absolute top-1 z-30 -translate-x-1/2 whitespace-nowrap rounded-sm bg-accent px-1.5 py-0.5 font-mono text-[10px] font-semibold text-white shadow-[0_2px_4px_rgba(0,0,0,0.4)]"
                  >
                    0:00
                  </div>
                </div>
              </div>

              {/* Sections */}
              <div className="relative">
                {sections.length === 0 && <p className="p-lg text-sm text-text-muted">No devices in this scenario.</p>}
                {(() => {
                  let rowIndex = 0;
                  return sections.map((section, i) => (
                    <div key={section.category}>
                      <div style={{ height: HEADER_HEIGHT }} className={`relative flex items-center ${i > 0 ? "mt-1.5 border-t border-bg-surface2" : ""}`}>
                        <span className="sticky left-0 z-10 pl-xs text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                          {CATEGORY_LABEL[section.category]}
                        </span>
                      </div>
                      {section.groups.map((group) => (
                        <div key={group.instance?.instance_id ?? "unassigned"}>
                          {/* Which physical board/gateway these channels belong to --
                              a bare "V1" doesn't say which relay board if a zone
                              ever has more than one, and even with just one board
                              it's the same context the grid editor always shows
                              above its own valve table. */}
                          <div style={{ height: INSTANCE_HEADER_HEIGHT }} className="flex items-center">
                            <span className="sticky left-0 z-10 truncate pl-md font-mono text-[10px] text-text-disabled">
                              {group.instance?.instance_id ?? "Unassigned"}
                            </span>
                          </div>
                          {group.devices.map((device) => (
                            <Lane
                              key={device.device_id}
                              device={device}
                              category={section.category}
                              events={full.events}
                              duration={duration}
                              pxPerSecond={pxPerSecond}
                              rowIndex={rowIndex++}
                            />
                          ))}
                        </div>
                      ))}
                    </div>
                  ));
                })()}
              </div>

              {/* Playhead -- a wider invisible-ish grab strip around a thin
                  visible line, so it's actually easy to click and drag. */}
              <div
                ref={playheadRef}
                onMouseDown={handlePlayheadMouseDown}
                className="absolute left-0 z-10 -ml-2 w-4 cursor-ew-resize"
                style={{ top: RULER_HEIGHT - 8, height: contentHeight - RULER_HEIGHT + 8, marginLeft: LABEL_WIDTH }}
              >
                <div className="pointer-events-none absolute left-1/2 top-2 h-3 w-3 -translate-x-1/2 rounded-full bg-accent shadow-[0_0_8px_2px_rgba(0,122,204,0.6)]" />
                <div className="pointer-events-none absolute left-1/2 top-2 h-full w-0.5 -translate-x-1/2 bg-gradient-to-b from-accent-hover to-accent shadow-[0_0_10px_1px_rgba(0,122,204,0.55)]" />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Lane({
  device,
  category,
  events,
  duration,
  pxPerSecond,
  rowIndex,
}: {
  device: DeviceDto;
  category: DeviceType;
  events: WireEvent[];
  duration: number;
  pxPerSecond: number;
  rowIndex: number;
}): JSX.Element {
  // Zero-padded to match the reference app's own channel numbering
  // (V01..V32, not V1..V32) -- reads as a counted, aligned column instead
  // of a ragged one once you're past channel 9.
  const label = `${CATEGORY_PREFIX[category]}${String(device.channel).padStart(2, "0")}`;
  // A short scenario or a short zoomed-out row would otherwise end in bare
  // page background past the last event/duration -- every row gets a real
  // fill (alternating for scan-ability across 32+ rows) instead.
  // Fully opaque, not a translucent overlay -- RowLabel is sticky and needs
  // to actually occlude scrolled-under content, not just tint it.
  const zebraClass = rowIndex % 2 === 0 ? "bg-bg-surface1" : "bg-bg-base";

  if (category === "light") {
    const spans = buildColorSpans(device.device_id, events, duration);
    return (
      <div className="flex" style={{ height: ROW_HEIGHT }}>
        <RowLabel label={label} title={device.device_id} zebraClass={zebraClass} />
        <div className={`relative h-full flex-1 ${zebraClass}`}>
          <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-bg-surface3" />
          {spans.map((s) => (
            <div
              key={s.start}
              style={{ left: s.start * pxPerSecond, width: (s.end - s.start) * pxPerSecond, backgroundColor: s.hex }}
              className={`absolute top-[6px] bottom-[6px] flex items-center overflow-hidden rounded-sm px-1.5 font-mono text-[10px] ${getContrastTextClass(s.hex)}`}
            >
              {(s.end - s.start) * pxPerSecond > 34 ? s.hex : ""}
            </div>
          ))}
        </div>
      </div>
    );
  }

  const isMotor = category === "motor";
  const field = isMotor ? "active" : "on";
  const spans = buildToggleSpans(device.device_id, field, category, events, duration).filter((s) => s.on);
  const markers = isMotor ? buildFrequencyMarkers(device.device_id, events) : [];

  return (
    <div className="flex" style={{ height: ROW_HEIGHT }}>
      <RowLabel label={label} title={device.device_id} zebraClass={zebraClass} />
      <div className={`relative h-full flex-1 ${zebraClass}`}>
        {/* Off isn't rendered at all -- a closed valve or an idle motor is
            "nothing scheduled here", not an alarm state, so color is
            reserved for what's actually on. Every lane gets the thin
            center baseline (not just motors) so an "off" stretch still
            reads as "this row exists and is empty here", not a gap. */}
        <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-bg-surface3" />
        {spans.map((s) => {
          const spanWidth = (s.end - s.start) * pxPerSecond;
          return (
            <div
              key={s.start}
              style={{ left: s.start * pxPerSecond, width: spanWidth }}
              className="absolute top-[7px] bottom-[7px] flex items-center justify-center overflow-hidden rounded-sm bg-success"
            >
              {/* The channel's own number, centered in the block -- so
                  scanning a dense row of segments (which one is this?)
                  doesn't require tracing back to the row label on the far
                  left every time, matching the reference app's own
                  per-cell numbering. */}
              {spanWidth > 24 && <span className={`font-mono text-[9px] font-semibold ${getContrastTextClass("#00cc6a")}`}>{label}</span>}
            </div>
          );
        })}
        {markers.map((m) => (
          <div
            key={m.time}
            style={{ left: m.time * pxPerSecond }}
            className="absolute top-0.5 z-10 -translate-x-1/2 whitespace-nowrap rounded-sm border border-border bg-bg-surface2 px-1.5 py-0.5 font-mono text-[10px] text-text-primary"
          >
            {m.hz.toFixed(1)}Hz
          </div>
        ))}
      </div>
    </div>
  );
}

function RowLabel({ label, title, zebraClass }: { label: string; title: string; zebraClass: string }): JSX.Element {
  return (
    <div
      className={`sticky left-0 z-10 flex shrink-0 items-center border-r border-bg-surface2 pl-md font-mono text-xs font-medium text-text-secondary ${zebraClass}`}
      style={{ width: LABEL_WIDTH }}
      title={title}
    >
      {label}
    </div>
  );
}
