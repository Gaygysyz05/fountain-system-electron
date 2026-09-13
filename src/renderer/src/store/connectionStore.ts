import { create } from "zustand";
import { describeError } from "../lib/errors";
import type { Ack, Command } from "../lib/protocol";
import { DaemonClient, type ConnectionStatus } from "../lib/wsClient";

const DAEMON_WS_URL = "ws://127.0.0.1:8765/ws";

export const daemonClient = new DaemonClient(DAEMON_WS_URL);

interface ConnectionStore {
  status: ConnectionStatus;
  lastError: string | null;
  /** Latches true on first "open" and never resets, so the startup splash (StartupSplash.tsx) shows only before the first-ever connection, not on later reconnects. */
  everConnected: boolean;
  sendCommand: (command: Command) => Promise<Ack>;
}

export const useConnectionStore = create<ConnectionStore>((set) => {
  // Plain closure variable, not get().everConnected -- onStatusChange fires synchronously during create()'s initializer, before zustand has committed state, so get() would throw here (matches configStore.ts's previousConnectionStatus).
  let everConnected = false;
  const unsubscribe = daemonClient.onStatusChange((status) => {
    if (status === "open") everConnected = true;
    set({ status, everConnected });
  });
  // Without this, dev-mode HMR reload stacks a duplicate status listener onto daemonClient on every edit (see zonesStore.ts).
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
        // Cleared on success too, else a stale failure would keep showing in StatusBar indefinitely after later commands succeed.
        set({ lastError: ack.ok ? null : (ack.error ?? "command failed") });
        return ack;
      } catch (err) {
        set({ lastError: describeError(err) });
        throw err;
      }
    },
  };
});
