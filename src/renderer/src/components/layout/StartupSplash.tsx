import { useDaemonStatusStore } from "../../store/daemonStatusStore";
import { startupMessage } from "../../lib/startupMessage";

/**
 * Full-screen "starting up" cover shown only for the very first connection
 * of the session -- replaces the previously-blank "Zones: 0 Devices: 0"
 * look during that window with something that actually says what's
 * happening. Rendered as an overlay ON TOP of AppShell rather than
 * instead of it, so every panel underneath (zones, scenarios, schedule)
 * is already mounted and loading in the background the moment the daemon
 * answers -- the interface is instantly populated the moment this splash
 * disappears, not starting its own fetches from zero at that point.
 */
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
