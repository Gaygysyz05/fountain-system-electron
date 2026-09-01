import { create } from "zustand";
import type { Ack, Command } from "../lib/protocol";
import { DaemonClient, type ConnectionStatus } from "../lib/wsClient";

const DAEMON_WS_URL = "ws://127.0.0.1:8765/ws";

export const daemonClient = new DaemonClient(DAEMON_WS_URL);

interface ConnectionStore {
  status: ConnectionStatus;
  lastError: string | null;
  sendCommand: (command: Command) => Promise<Ack>;
}

export const useConnectionStore = create<ConnectionStore>((set) => {
  daemonClient.onStatusChange((status) => set({ status }));

  return {
    status: "closed",
    lastError: null,
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
        const message = err instanceof Error ? err.message : String(err);
        set({ lastError: message });
        throw err;
      }
    },
  };
});
