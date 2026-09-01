import type { Ack, Command, DaemonEvent, IncomingMessage } from "./protocol";
import { isAck } from "./protocol";

export type ConnectionStatus = "connecting" | "open" | "closed";

const ACK_TIMEOUT_MS = 5000;
const MAX_RECONNECT_DELAY_MS = 10_000;

function makeId(): string {
  return crypto.randomUUID();
}

/**
 * Framework-agnostic WebSocket client for the fountain daemon. Deliberately
 * NOT a React hook: `device_event` messages can arrive at up to ~20Hz per
 * device while a scenario is playing (the daemon's tick is 50ms), and piping
 * every single one through a hook that re-renders its component tree would
 * be exactly the kind of main-thread jank this whole rewrite exists to
 * avoid. Zustand stores subscribe to `onEvent` below and decide for
 * themselves what's worth turning into a re-render (see zonesStore.ts) --
 * high-frequency consumers like the 3D preview read off refs instead of
 * store state entirely (see ScenePreview.tsx).
 */
export class DaemonClient {
  private ws: WebSocket | null = null;
  private url: string;
  private status: ConnectionStatus = "closed";
  private reconnectDelay = 500;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;

  private eventListeners = new Set<(event: DaemonEvent) => void>();
  private statusListeners = new Set<(status: ConnectionStatus) => void>();
  private pending = new Map<string, { resolve: (ack: Ack) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(url: string) {
    this.url = url;
  }

  connect(): void {
    this.intentionallyClosed = false;
    this.openSocket();
  }

  disconnect(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  onEvent(handler: (event: DaemonEvent) => void): () => void {
    this.eventListeners.add(handler);
    return () => this.eventListeners.delete(handler);
  }

  onStatusChange(handler: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(handler);
    handler(this.status); // fire immediately with current status
    return () => this.statusListeners.delete(handler);
  }

  /** Sends a command and resolves with its Ack, or rejects on timeout/error. */
  send(command: Command): Promise<Ack> {
    const id = command.id ?? makeId();
    const withId = { ...command, id };

    if (!this.ws || this.status !== "open") {
      return Promise.reject(new Error("not connected to daemon"));
    }

    return new Promise<Ack>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`command ${command.command} timed out waiting for ack`));
      }, ACK_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify(withId));
    });
  }

  private openSocket(): void {
    this.setStatus("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;

    // Every handler below checks `this.ws !== ws` before touching shared
    // state: if connect() is ever called again while this socket is still
    // CONNECTING/CLOSING (React 18 StrictMode double-invokes effects in
    // dev -- connect/disconnect/connect back to back -- and any future
    // caller that does the same), this closure still fires for the socket
    // that `this.ws` no longer points at. Without the guard, a late
    // `onclose` from that superseded socket would call scheduleReconnect()
    // and race a second live connection against the current one, or a late
    // `onmessage` would resolve/dispatch against state a newer socket
    // already owns.
    const isCurrent = (): boolean => this.ws === ws;

    ws.onopen = () => {
      if (!isCurrent()) return;
      this.reconnectDelay = 500;
      this.setStatus("open");
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      if (!isCurrent()) return;
      let msg: IncomingMessage;
      try {
        msg = JSON.parse(event.data) as IncomingMessage;
      } catch {
        console.warn("[daemon] received unparseable message", event.data);
        return;
      }

      if (isAck(msg)) {
        const waiter = this.pending.get(msg.id);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.pending.delete(msg.id);
          waiter.resolve(msg);
        }
        return;
      }

      for (const listener of this.eventListeners) listener(msg);
    };

    ws.onclose = () => {
      if (!isCurrent()) return;
      this.setStatus("closed");
      this.rejectAllPending(new Error("connection closed"));
      if (!this.intentionallyClosed) this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose always follows onerror for a browser WebSocket; reconnect is
      // scheduled there, not here, to avoid double-scheduling.
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, MAX_RECONNECT_DELAY_MS);
      this.openSocket();
    }, this.reconnectDelay);
  }

  private rejectAllPending(err: Error): void {
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
      this.pending.delete(id);
    }
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }
}
