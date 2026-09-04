import { useEffect, useState } from "react";

/**
 * This app's own preferences -- as opposed to the daemon's hardware config
 * (Devices tab) or a show's data (Timeline/Schedule). Currently just the
 * one toggle; laid out as a list of labeled rows so a second setting has
 * somewhere obvious to go rather than needing its own screen.
 */
export function SettingsPanel(): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-lg overflow-y-auto p-lg">
      <h2 className="text-lg font-medium text-text-primary">Settings</h2>
      <div className="flex max-w-xl flex-col gap-md rounded-panel border border-border bg-bg-surface1 p-lg">
        <AutoLaunchSetting />
      </div>
    </div>
  );
}

function AutoLaunchSetting(): JSX.Element {
  // null while the initial IPC round-trip is in flight -- the toggle stays
  // disabled rather than guessing a starting position, since guessing
  // wrong (even for a moment) could look like a click was silently
  // ignored.
  const [state, setState] = useState<{ enabled: boolean; supported: boolean } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.electron.getAutoLaunch().then(setState);
  }, []);

  async function toggle(): Promise<void> {
    if (!state || pending) return;
    const next = !state.enabled;
    setPending(true);
    setError(null);
    try {
      await window.electron.setAutoLaunch(next);
      // Re-read rather than optimistically assuming `next` stuck -- Windows
      // itself can refuse a login-item registration (Task Scheduler access
      // denied under a locked-down account, say), and the toggle should
      // reflect what's actually registered, not what was merely requested.
      setState(await window.electron.getAutoLaunch());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  const enabled = state?.enabled ?? false;
  const disabled = !state || pending || !state.supported;

  return (
    <div className="flex items-start justify-between gap-lg">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-text-primary">Start automatically when Windows starts</span>
        <span className="text-xs text-text-muted">
          {state && !state.supported
            ? "Not available while running from a development build -- only an installed copy can register itself as a startup item."
            : "Recommended for a fountain running unattended -- the control panel comes back up on its own after a power flicker or a Windows Update reboot."}
        </span>
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
      <button
        role="switch"
        aria-checked={enabled}
        onClick={() => void toggle()}
        disabled={disabled}
        title={state && !state.supported ? "Not available in a development build" : undefined}
        className={`h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          enabled ? "bg-accent" : "bg-bg-surface3"
        }`}
      >
        <span className={`block h-5 w-5 rounded-full bg-white transition-transform ${enabled ? "translate-x-5" : "translate-x-0.5"}`} />
      </button>
    </div>
  );
}
