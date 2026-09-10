import { useEffect, useState } from "react";
import { describeError } from "../../lib/errors";
import { restClient } from "../../lib/restClient";
import type { AuditLogEntryDto } from "../../lib/protocol";
import { useConfigStore } from "../../store/configStore";

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/**
 * Read-only viewer for GET /audit -- there's no operator-identity system on
 * this single shared panel (see persistence.py's append_audit_entry), so
 * this answers "what happened and when", not "who". Useful for
 * reconstructing what led up to an incident after the fact. Plain
 * fetch-on-demand, not a live stream -- an incident review happens after
 * the fact, not while watching commands scroll by in real time.
 */
export function AuditLogPanel(): JSX.Element {
  const [entries, setEntries] = useState<AuditLogEntryDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zones = useConfigStore((s) => s.zones);
  const loadZones = useConfigStore((s) => s.loadZones);

  async function refresh(): Promise<void> {
    setLoading(true);
    try {
      const result = await restClient.getAuditLog(300);
      setEntries(result);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    void loadZones();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only fetch
  }, []);

  function zoneName(zoneId: number | null): string {
    if (zoneId === null) return "—";
    return zones.find((z) => z.zone_id === zoneId)?.name?.trim() || `Zone ${zoneId}`;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-md p-lg">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium text-text-primary">Action Log</h2>
        <button onClick={() => void refresh()} className="text-xs text-accent hover:text-accent-hover">
          Refresh
        </button>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      {loading && entries.length === 0 && <p className="text-sm text-text-muted">Loading…</p>}
      {!loading && !error && entries.length === 0 && <p className="text-sm text-text-muted">No commands logged yet.</p>}

      <div className="min-h-0 flex-1 overflow-y-auto rounded-panel border border-border">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-bg-surface1 text-xs uppercase tracking-wide text-text-muted">
            <tr>
              <th className="px-sm py-xs">Time</th>
              <th className="px-sm py-xs">Command</th>
              <th className="px-sm py-xs">Zone</th>
              <th className="px-sm py-xs">Result</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, i) => (
              // AuditLogEntryDto carries no id of its own (see
              // persistence.py's append_audit_entry) -- ts+command+i is a
              // more stable key than the bare index alone, though the
              // whole list is atomically replaced on every refresh anyway
              // (no per-row local state or animation this table needs to
              // preserve identity across), so this was never actually
              // wrong in practice, just not the idiomatic key choice.
              <tr key={`${entry.ts}-${entry.command}-${i}`} className="border-t border-border">
                <td className="whitespace-nowrap px-sm py-xs font-mono text-xs text-text-secondary">{formatTimestamp(entry.ts)}</td>
                <td className="px-sm py-xs text-text-primary">{entry.command}</td>
                <td className="px-sm py-xs text-text-secondary">{zoneName(entry.zone_id)}</td>
                <td className={`px-sm py-xs ${entry.ok ? "text-success" : "text-danger"}`} title={entry.error ?? undefined}>
                  {entry.ok ? "OK" : (entry.error ?? "Failed")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
