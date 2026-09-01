import type { AuditLogEntryDto, DriverDescriptorDto, ScenarioDto, ScheduleEntryDto, ScheduleEntryInput, ZoneConfigDto } from "./protocol";
import type { ScenarioFile } from "./scenario";

export const DAEMON_HTTP_URL = "http://127.0.0.1:8765";

/** FastAPI's HTTPException body is `{"detail": "..."}` -- surface that
 * instead of just the HTTP status, so e.g. an invalid scenario_id shows its
 * actual validation message instead of a bare "400 Bad Request". Falls back
 * to statusText if the body isn't JSON or has no `detail`. */
async function describeHttpError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (body && typeof body.detail === "string") return body.detail;
  } catch {
    // not JSON -- fall through to statusText
  }
  return `${res.status} ${res.statusText}`;
}

async function getJson<T>(path: string): Promise<T> {
  // A scenario file changes every time it's saved, but nothing here tells
  // the browser that -- the daemon sends no cache-control header, so a
  // second GET for the same scenario_id could be served stale from cache
  // instead of hitting the daemon again. Never cache config/scenario reads.
  const res = await fetch(`${DAEMON_HTTP_URL}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET ${path} failed: ${await describeHttpError(res)}`);
  return res.json() as Promise<T>;
}

async function sendJson<T>(path: string, method: "POST" | "PUT", body: unknown): Promise<T> {
  const res = await fetch(`${DAEMON_HTTP_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} failed: ${await describeHttpError(res)}`);
  return res.json() as Promise<T>;
}

async function deleteRequest(path: string): Promise<void> {
  const res = await fetch(`${DAEMON_HTTP_URL}${path}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`DELETE ${path} failed: ${await describeHttpError(res)}`);
}

interface ScenarioFileWire {
  name: string;
  duration: number;
  music_file: string | null;
  events: Array<{ time: number; device_id: string; parameters: Record<string, unknown> }>;
  device_ids?: string[];
}

/**
 * Hardware/runtime mutations go through the WS command channel (see
 * connectionStore.sendCommand); everything here is either a stateless
 * lookup or plain CRUD on a scenario *file* -- saving a timeline has
 * nothing to do with live hardware state, so it stays on the REST side
 * rather than being shoehorned into a WS command.
 */
export const restClient = {
  getDrivers: () => getJson<DriverDescriptorDto[]>("/drivers"),
  getZones: () => getJson<ZoneConfigDto[]>("/zones"),
  getScenarios: () => getJson<ScenarioDto[]>("/scenarios"),

  /** Full content, exactly what saveScenario below writes -- GET/POST on the
   * same resource. `device_ids` is optional on the wire: a scenario saved
   * before that field existed (or edited by hand) simply has none, and the
   * editor falls back to showing every zone device (see resolveDeviceIds). */
  getScenarioFull: (scenarioId: string) => getJson<ScenarioFileWire>(`/scenarios/${encodeURIComponent(scenarioId)}`),

  /** URL for GET /audio -- not fetched here, just built, so callers (the
   * waveform decoder) can fetch().arrayBuffer() it directly. */
  audioUrl: (musicFile: string) => `${DAEMON_HTTP_URL}/audio?path=${encodeURIComponent(musicFile)}`,

  saveScenario: async (scenarioId: string, file: ScenarioFile): Promise<void> => {
    const res = await fetch(`${DAEMON_HTTP_URL}/scenarios/${encodeURIComponent(scenarioId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: file.name,
        duration: file.duration,
        music_file: file.music_file,
        device_ids: file.deviceIds,
        events: file.events.map((e) => ({ time: e.time, device_id: e.device_id, parameters: e.parameters })),
      }),
    });
    if (!res.ok) throw new Error(`Save failed: ${await describeHttpError(res)}`);
  },

  deleteScenario: async (scenarioId: string): Promise<void> => {
    const res = await fetch(`${DAEMON_HTTP_URL}/scenarios/${encodeURIComponent(scenarioId)}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`Delete failed: ${await describeHttpError(res)}`);
  },

  getSchedule: () => getJson<ScheduleEntryDto[]>("/schedule"),
  createScheduleEntry: (input: ScheduleEntryInput) => sendJson<ScheduleEntryDto>("/schedule", "POST", input),
  updateScheduleEntry: (entryId: string, input: Partial<ScheduleEntryInput>) =>
    sendJson<ScheduleEntryDto>(`/schedule/${encodeURIComponent(entryId)}`, "PUT", input),
  deleteScheduleEntry: (entryId: string) => deleteRequest(`/schedule/${encodeURIComponent(entryId)}`),

  getAuditLog: (limit = 200) => getJson<AuditLogEntryDto[]>(`/audit?limit=${limit}`),
};
