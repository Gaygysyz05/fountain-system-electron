/** Same phase -> message mapping StatusBar's daemonStatusLabel uses for its
 * small inline indicator -- this is what StartupSplash.tsx shows full-
 * screen, only before the app has EVER connected. "failed" deliberately
 * returns an empty string: AppShell stops rendering the splash at all once
 * the daemon gives up, falling back to the normal (disconnected) interface
 * so the operator still has StatusBar's "Export logs" button reachable
 * instead of being stuck behind a full-screen dead end -- this branch only
 * exists so the switch stays exhaustive. */
export function startupMessage(daemonStatus: DaemonStatus): string {
  switch (daemonStatus.phase) {
    case "starting":
      return "Starting the control daemon…";
    case "restarting":
      return `Daemon restarting (attempt ${daemonStatus.attempt}/${daemonStatus.maxAttempts})…`;
    case "running":
      // The daemon process itself is up; just waiting on the WS handshake
      // now (see wsClient.ts's fast-reconnect window for how long that
      // should actually take).
      return "Connecting…";
    case "failed":
      return "";
  }
}
