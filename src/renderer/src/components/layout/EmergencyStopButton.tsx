import { useRef, useState } from "react";
import { describeError } from "../../lib/errors";
import { useConnectionStore } from "../../store/connectionStore";

/** Lives in AppShell's header, not PlaybackPanel, so it stays reachable from every tab; sends EMERGENCY_STOP with zone_id omitted (daemon treats that as "every zone"); "STOPPED" only shows after a real daemon ack -- never a timer -- since falsely showing "stopped" is the one failure this button must never have. */
type Phase = "idle" | "sending" | "confirmed" | "failed";

export function EmergencyStopButton(): JSX.Element {
  const sendCommand = useConnectionStore((s) => s.sendCommand);
  const [phase, setPhase] = useState<Phase>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Bumped on every click so a late-resolving older attempt can't clobber a newer one's result -- only the most recent attempt may update the visible phase.
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
