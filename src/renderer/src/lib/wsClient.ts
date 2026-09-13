import type { Ack, Command, DaemonEvent, IncomingMessage } from "./protocol";
import { isAck } from "./protocol";

export type ConnectionStatus = "connecting" | "open" | "closed";

const ACK_TIMEOUT_MS = 5000;
// main/index.ts spawns the daemon alongside this renderer, so at launch the WS port is briefly closed (not down) while the daemon starts -- retry flat/fast here instead of the exponential backoff used once it looks genuinely unreachable, so startup doesn't misread as a slow daemon.
const FAST_RECONNECT_DELAY_MS = 250;
const FAST_RECONNECT_WINDOW_MS = 8_000;
const MAX_RECONNECT_DELAY_MS = 10_000;

function makeId(): string {
  return crypto.randomUUID();
}

/** Deliberately not a React hook: device_event can arrive at ~20Hz per device, so re-rendering on every one would cause main-thread jank -- consumers subscribe via onEvent and decide what's worth a re-render (see zonesStore.ts, ScenePreview.tsx). */
export class DaemonClient {
  private ws: WebSocket | null = null;
  private url: string;
  private status: ConnectionStatus = "closed";
  // Only used once FAST_RECONNECT_WINDOW_MS of continuous failure has elapsed (see scheduleReconnect).
  private reconnectDelay = 500;
  private reconnectingSince: number | null = null;
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
    const previous = this.ws;
    this.openSocket();
    // Close the old socket only AFTER openSocket() repoints this.ws -- closing it first would make its own onclose see isCurrent() still true and schedule a reconnect that races the new connection (see openSocket()'s isCurrent() comment).
    previous?.close();
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

    // Guards against a superseded socket's late onclose/onmessage racing a reconnect or dispatching against state a newer socket already owns (e.g. StrictMode's double-invoked effects).
    const isCurrent = (): boolean => this.ws === ws;

    ws.onopen = () => {
      if (!isCurrent()) return;
      this.reconnectDelay = 500;
      this.reconnectingSince = null;
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
      // onclose always follows onerror for a browser WebSocket; reconnect is scheduled there to avoid double-scheduling.
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    if (this.reconnectingSince === null) this.reconnectingSince = Date.now();
    const inFastWindow = Date.now() - this.reconnectingSince < FAST_RECONNECT_WINDOW_MS;
    const delay = inFastWindow ? FAST_RECONNECT_DELAY_MS : this.reconnectDelay;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!inFastWindow) this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, MAX_RECONNECT_DELAY_MS);
      this.openSocket();
    }, delay);
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
