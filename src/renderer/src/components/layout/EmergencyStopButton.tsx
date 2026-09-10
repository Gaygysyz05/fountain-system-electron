import { useRef, useState } from "react";
import { describeError } from "../../lib/errors";
import { useConnectionStore } from "../../store/connectionStore";

/**
 * Always reachable, regardless of which tab is open -- this is why it lives
 * in AppShell's header rather than inside PlaybackPanel. Sends
 * EMERGENCY_STOP with zone_id omitted, which the daemon treats as "every
 * zone" (see main.py's _dispatch).
 *
 * The visible state is driven entirely by the actual command outcome, not a
 * timer: this used to flash "STOPPED" on a bare setTimeout regardless of
 * whether the command was ever sent (e.g. the socket was reconnecting) or
 * came back Ack(ok=false). That silently told the operator the fountain was
 * off exactly when it might not be -- the one thing this button must never
 * do. "STOPPED" now only ever shows once the daemon has actually
 * acknowledged the command; a dropped connection, a rejected command, or a
 * timeout shows a persistent failure state instead, with the reason in the
 * tooltip. A second click always fires another attempt regardless of the
 * current phase -- this must never require waiting out a pending one.
 */
type Phase = "idle" | "sending" | "confirmed" | "failed";

export function EmergencyStopButton(): JSX.Element {
  const sendCommand = useConnectionStore((s) => s.sendCommand);
  const [phase, setPhase] = useState<Phase>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Bumped on every click so a late-resolving older attempt can't clobber a
  // newer one's result (e.g. click while "sending", the first attempt's ack
  // arrives after the second's) -- only the most recent attempt is allowed
  // to update the visible phase.
  const attemptRef = useRef(0);

  function handleClick(): void {
    const attempt = ++attemptRef.current;
    setPhase("sending");
    setErrorMessage(null);

    sendCommand({ command: "EMERGENCY_STOP" }).then(
      (ack) => {
        if (attemptRef.current !== attempt) return;
        if (ack.ok) {
          setPhase("confirmed");
          setTimeout(() => {
            if (attemptRef.current === attempt) setPhase("idle");
          }, 1500);
        } else {
          setPhase("failed");
          setErrorMessage(ack.error ?? "daemon rejected the command");
        }
      },
      (err: unknown) => {
        if (attemptRef.current !== attempt) return;
        setPhase("failed");
        setErrorMessage(describeError(err));
      },
    );
  }

  const label =
    phase === "sending"
      ? "STOPPING…"
      : phase === "confirmed"
        ? "✓ STOPPED"
        : phase === "failed"
          ? "⚠ NOT SENT — RETRY"
          : "⏻ EMERGENCY STOP";

  const colorClass =
    phase === "confirmed"
      ? "bg-success"
      : phase === "failed"
        ? "bg-danger animate-pulse"
        : "bg-danger hover:bg-danger-hover";

  const title =
    phase === "failed" && errorMessage
      ? `Stop every zone immediately -- last attempt failed: ${errorMessage} (click to retry)`
      : "Stop every zone immediately";

  return (
    <button
      onClick={handleClick}
      className={`h-control rounded-control px-md text-sm font-medium text-white transition-colors ${colorClass}`}
      title={title}
    >
      {label}
    </button>
  );
}
