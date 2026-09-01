import { getColorHex } from "../timeline/deviceColumns";
import { defaultParametersFor } from "../../lib/scenario";
import type { DeviceType } from "../../lib/protocol";

/** The same shape restClient.getScenarioFull() resolves to -- a plain wire
 * event, not the editor's ScenarioEvent (which also carries a client-side
 * `id`). This view is read-only and works straight off what's on disk. */
export interface WireEvent {
  time: number;
  device_id: string;
  parameters: Record<string, unknown>;
}

export interface ToggleSpan {
  start: number;
  end: number;
  on: boolean;
}

export interface ColorSpan {
  start: number;
  end: number;
  hex: string;
}

export interface FrequencyMarker {
  time: number;
  hz: number;
}

function eventsFor(deviceId: string, events: WireEvent[]): WireEvent[] {
  return events.filter((e) => e.device_id === deviceId).sort((a, b) => a.time - b.time);
}

/** "Hold until changed" playback semantics turned into contiguous spans for
 * a piano-roll view -- a gap before the first explicit event is filled with
 * the device's own default (valve/motor start off, matching
 * defaultParametersFor), not left blank. Adjacent events that re-assert the
 * SAME value (the grid editor's own bulk-fill tools can write one explicit
 * event per time step even when nothing actually changed) are merged into
 * one span instead of rendering as a row of abutting same-color tiles with
 * visible seams between them. */
export function buildToggleSpans(deviceId: string, field: string, category: DeviceType, events: WireEvent[], duration: number): ToggleSpan[] {
  const own = eventsFor(deviceId, events);
  const spans: ToggleSpan[] = [];
  let cursor = 0;
  let current = Boolean((defaultParametersFor(category) as Record<string, unknown>)[field]);

  const flush = (end: number): void => {
    if (end <= cursor) return;
    const last = spans[spans.length - 1];
    if (last && last.on === current) last.end = end;
    else spans.push({ start: cursor, end, on: current });
    cursor = end;
  };

  for (const e of own) {
    flush(e.time);
    if (field in e.parameters) current = Boolean(e.parameters[field]);
  }
  flush(duration);
  return spans;
}

export function buildColorSpans(deviceId: string, events: WireEvent[], duration: number): ColorSpan[] {
  const own = eventsFor(deviceId, events);
  const spans: ColorSpan[] = [];
  let cursor = 0;
  let current = getColorHex(defaultParametersFor("light"));

  const flush = (end: number): void => {
    if (end <= cursor) return;
    const last = spans[spans.length - 1];
    if (last && last.hex === current) last.end = end;
    else spans.push({ start: cursor, end, hex: current });
    cursor = end;
  };

  for (const e of own) {
    flush(e.time);
    current = getColorHex(e.parameters);
  }
  flush(duration);
  return spans;
}

/** Not a span -- a motor's frequency is a set-point, not on/off, so it's
 * shown as a label at each moment it actually changes (matching the
 * reference app's badges) rather than a continuous bar. */
export function buildFrequencyMarkers(deviceId: string, events: WireEvent[]): FrequencyMarker[] {
  const own = eventsFor(deviceId, events);
  const markers: FrequencyMarker[] = [];
  let last: number | null = null;

  for (const e of own) {
    if (!("frequency" in e.parameters)) continue;
    const hz = Number(e.parameters.frequency);
    if (last === null || Math.abs(hz - last) > 0.05) {
      markers.push({ time: e.time, hz });
      last = hz;
    }
  }
  return markers;
}

/** Picks a round tick spacing (1/2/5/10/15/30/60/...s) so ruler labels stay
 * legibly spaced apart regardless of zoom level. */
export function pickTickStepSeconds(pxPerSecond: number, minLabelSpacingPx = 50): number {
  const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const step of candidates) {
    if (step * pxPerSecond >= minLabelSpacingPx) return step;
  }
  return candidates[candidates.length - 1];
}
