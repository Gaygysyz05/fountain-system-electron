/** Mirrors StatusBar's daemonStatusLabel mapping; "failed" returns "" because AppShell falls back to the normal disconnected UI (reachable "Export logs") once the daemon gives up -- kept only so the switch stays exhaustive. */
export function startupMessage(daemonStatus: DaemonStatus): string {
  switch (daemonStatus.phase) {
    case "starting":
      return "Starting the control daemon…";
    case "restarting":
      return `Daemon restarting (attempt ${daemonStatus.attempt}/${daemonStatus.maxAttempts})…`;
    case "running":
      // Daemon process is up; now waiting on the WS handshake (see wsClient.ts's fast-reconnect window for expected timing).
      return "Connecting…";
    case "failed":
      return "";
  }
}
