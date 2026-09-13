import { useDaemonStatusStore } from "../../store/daemonStatusStore";
import { startupMessage } from "../../lib/startupMessage";

// Overlays AppShell rather than replacing it, so panels underneath are already mounted and loading by the time this splash disappears.
export function StartupSplash(): JSX.Element {
  const daemonStatus = useDaemonStatusStore((s) => s.status);

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-md bg-bg-base">
      <div className="h-10 w-10 animate-spin rounded-full border-4 border-bg-surface3 border-t-accent" />
      <div className="text-lg font-medium text-text-primary">Fountain Control</div>
      <div className="text-sm text-text-secondary">{startupMessage(daemonStatus)}</div>
    </div>
  );
}
