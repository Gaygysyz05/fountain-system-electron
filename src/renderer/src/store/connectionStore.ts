import { create } from "zustand";
import { describeError } from "../lib/errors";
import type { Ack, Command } from "../lib/protocol";
import { DaemonClient, type ConnectionStatus } from "../lib/wsClient";

const DAEMON_WS_URL = "ws://127.0.0.1:8765/ws";

export const daemonClient = new DaemonClient(DAEMON_WS_URL);

interface ConnectionStore {
  status: ConnectionStatus;
  lastError: string | null;
  /** Latches true the first time `status` ever reaches "open", and stays
   * true for the rest of the session -- a later drop (daemon restart mid-
   * show, a network blip) does NOT reset it. Exists purely so the
   * first-launch startup splash (see StartupSplash.tsx) knows to show
   * itself only while the app has NEVER yet connected, not on every
   * subsequent reconnect -- a live show reconnecting shouldn't have its
   * whole screen replaced by a splash, just the small StatusBar indicator. */
  everConnected: boolean;
  sendCommand: (command: Command) => Promise<Ack>;
}

export const useConnectionStore = create<ConnectionStore>((set) => {
  // A plain closure variable, not get().everConnected -- onStatusChange
  // fires its handler SYNCHRONOUSLY and IMMEDIATELY with the current
  // status (see wsClient.ts), which happens here WHILE create()'s own
  // initializer (this function) is still running, before it has returned
  // an initial state for get() to read. Calling get() on that first,
  // immediate invocation throws "Cannot read properties of undefined" --
  // zustand hasn't committed any state yet. Matches configStore.ts's own
  // previousConnectionStatus, the same safe pattern for the same reason.
  let everConnected = false;
  const unsubscribe = daemonClient.onStatusChange((status) => {
    if (status === "open") everConnected = true;
    set({ status, everConnected });
  });
  // See zonesStore.ts's matching comment -- without this, a dev-mode HMR
  // reload of this module stacks one more duplicate status listener onto
  // daemonClient on every edit.
  if (import.meta.hot) {
    import.meta.hot.dispose(() => unsubscribe());
  }

  return {
    status: "closed",
    lastError: null,
    everConnected: false,
    sendCommand: async (command: Command) => {
      try {
        const ack = await daemonClient.send(command);
        // Cleared on success, not just set on failure -- otherwise one
        // failed command (e.g. a test-fire on a briefly disconnected
        // device) leaves StatusBar showing that error indefinitely, even
        // after every later command succeeds, with nothing to tell the
        // operator whether the fault is current or long resolved.
        set({ lastError: ack.ok ? null : (ack.error ?? "command failed") });
        return ack;
      } catch (err) {
        set({ lastError: describeError(err) });
        throw err;
      }
    },
  };
});
