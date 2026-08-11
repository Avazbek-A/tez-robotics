import type { StoreApi } from "zustand/vanilla";
import type { FleetState } from "./store";
import type { StateFrame } from "./types";

export interface WsClientOpts {
  /**
   * Reconnect backoff schedule, in ms. The last entry repeats indefinitely
   * once attempts exceed the array length. Default: [500, 1000, 2000, 5000],
   * i.e. 500, 1000, 2000, 5000, 5000, 5000, ...
   */
  backoffMs?: number[];
}

const DEFAULT_BACKOFF_MS = [500, 1000, 2000, 5000];

export interface WsClient {
  stop(): void;
}

/**
 * Connects to the dashboard's `/ws/state` stream and mirrors every frame
 * into `store`. Reconnects with backoff on close/error; never throws on a
 * malformed frame (logs + skips instead).
 */
export function startWsClient(
  url: string,
  store: StoreApi<FleetState>,
  opts: WsClientOpts = {},
): WsClient {
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  let stopped = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let hasConnectedOnce = false;

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const detachSocket = (s: WebSocket) => {
    s.onopen = null;
    s.onmessage = null;
    s.onclose = null;
    s.onerror = null;
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    store.getState().setConnection("reconnecting");
    const delayMs = backoff[Math.min(attempt, backoff.length - 1)];
    attempt += 1;
    clearReconnectTimer();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delayMs);
  };

  function connect(): void {
    if (stopped) return;
    store.getState().setConnection(hasConnectedOnce ? "reconnecting" : "connecting");

    const ws = new window.WebSocket(url);
    socket = ws;

    ws.onopen = () => {
      if (stopped) return;
      attempt = 0;
      hasConnectedOnce = true;
      store.getState().setConnection("connected");
    };

    ws.onmessage = (event) => {
      if (stopped) return;
      try {
        const raw = typeof event.data === "string" ? event.data : String(event.data);
        const frame = JSON.parse(raw) as StateFrame;
        store.getState().applyFrame(frame);
      } catch (err) {
        // Malformed frame: never crash the client, just skip it.
        console.warn("[ws-client] failed to parse frame, skipping", err);
      }
    };

    ws.onclose = () => {
      if (stopped) return;
      if (socket === ws) socket = null;
      scheduleReconnect();
    };

    ws.onerror = () => {
      // `close` always follows `error` for connection failures in both the
      // browser WebSocket and the `ws` package; reconnect is handled there.
    };
  }

  connect();

  return {
    stop() {
      stopped = true;
      clearReconnectTimer();
      if (socket) {
        const s = socket;
        socket = null;
        detachSocket(s);
        s.close();
      }
    },
  };
}
