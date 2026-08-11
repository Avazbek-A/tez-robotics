import { act, renderHook } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket as NodeWebSocketClient, WebSocketServer } from "ws";
import { fleetStore, useFleetStore } from "../src/store";
import { startWsClient } from "../src/ws-client";
import type { WsClient } from "../src/ws-client";
import type { StateFrame } from "../src/types";

function makeFrame(seq: number): StateFrame {
  return {
    t: new Date().toISOString(),
    seq,
    degraded: false,
    robots: [],
    orders: [],
    kpis: { ordersPerHour: 0, avgCycleMs: 0, utilization: 0 },
    alarms: [],
  };
}

const INITIAL_FLEET_STATE = {
  connection: "connecting" as const,
  frame: undefined,
  lastFrameAt: undefined,
  selectedRobotId: undefined,
};

function resetFleetStore() {
  fleetStore.setState(INITIAL_FLEET_STATE);
}

describe("fleetStore", () => {
  beforeEach(resetFleetStore);

  it("applyFrame updates frame + lastFrameAt", () => {
    const frame = makeFrame(1);
    const before = Date.now();

    fleetStore.getState().applyFrame(frame);

    const state = fleetStore.getState();
    expect(state.frame).toEqual(frame);
    expect(state.lastFrameAt).toBeGreaterThanOrEqual(before);
  });

  it("selectRobot toggles the selected robot id", () => {
    expect(fleetStore.getState().selectedRobotId).toBeUndefined();

    fleetStore.getState().selectRobot("r1");
    expect(fleetStore.getState().selectedRobotId).toBe("r1");

    fleetStore.getState().selectRobot(undefined);
    expect(fleetStore.getState().selectedRobotId).toBeUndefined();
  });

  it("setConnection updates the connection state", () => {
    fleetStore.getState().setConnection("connected");
    expect(fleetStore.getState().connection).toBe("connected");
  });

  it("useFleetStore mirrors the vanilla store and re-renders on change", () => {
    const { result } = renderHook(() => useFleetStore((s) => s.connection));
    expect(result.current).toBe("connecting");

    act(() => {
      fleetStore.getState().setConnection("connected");
    });

    expect(result.current).toBe("connected");
  });
});

// --- ws-client integration, against a local `ws` server on an ephemeral port ---

function startTestServer(port = 0): Promise<{ wss: WebSocketServer; port: number }> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port }, () => {
      const addr = wss.address();
      const actualPort = typeof addr === "object" && addr !== null ? addr.port : port;
      resolve({ wss, port: actualPort });
    });
    wss.on("connection", (socket) => {
      socket.send(JSON.stringify(makeFrame(0)));
    });
    wss.on("error", reject);
  });
}

function closeServer(wss: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    for (const client of wss.clients) client.terminate();
    wss.close((err) => (err ? reject(err) : resolve()));
  });
}

describe("startWsClient", () => {
  beforeAll(() => {
    // happy-dom's `window` has no WebSocket implementation; inject the `ws`
    // package's client, which supports the same onopen/onmessage/onclose/
    // onerror browser-style API our production code (`window.WebSocket`) uses.
    (window as unknown as { WebSocket: typeof WebSocket }).WebSocket =
      NodeWebSocketClient as unknown as typeof WebSocket;
  });

  afterAll(() => {
    delete (window as unknown as { WebSocket?: typeof WebSocket }).WebSocket;
  });

  let client: WsClient | undefined;

  beforeEach(resetFleetStore);

  afterEach(() => {
    client?.stop();
    client = undefined;
  });

  it("receives frames from the server and updates the store", async () => {
    const { wss, port } = await startTestServer();
    try {
      client = startWsClient(`ws://127.0.0.1:${port}`, fleetStore);

      await vi.waitFor(() => {
        expect(fleetStore.getState().connection).toBe("connected");
        expect(fleetStore.getState().frame?.seq).toBe(0);
      });
    } finally {
      await closeServer(wss);
    }
  });

  it("goes to 'reconnecting' on server close and back to 'connected' after the server restarts on the same port", async () => {
    const first = await startTestServer();
    client = startWsClient(`ws://127.0.0.1:${first.port}`, fleetStore, { backoffMs: [50, 50] });

    await vi.waitFor(() => {
      expect(fleetStore.getState().connection).toBe("connected");
    });

    await closeServer(first.wss);

    await vi.waitFor(() => {
      expect(fleetStore.getState().connection).toBe("reconnecting");
    });

    const second = await startTestServer(first.port);
    try {
      await vi.waitFor(
        () => {
          expect(fleetStore.getState().connection).toBe("connected");
        },
        { timeout: 3000 },
      );
    } finally {
      await closeServer(second.wss);
    }
  });

  it("never crashes on a malformed frame and just skips it", async () => {
    const { wss, port } = await startTestServer();
    try {
      // Override the default connection handler to send garbage instead of a frame.
      wss.removeAllListeners("connection");
      wss.on("connection", (socket) => {
        socket.send("not json{{{");
      });

      client = startWsClient(`ws://127.0.0.1:${port}`, fleetStore);

      await vi.waitFor(() => {
        expect(fleetStore.getState().connection).toBe("connected");
      });

      // Give the malformed message a moment to be processed; the store's
      // frame must remain untouched (no throw reaching the test either).
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(fleetStore.getState().frame).toBeUndefined();
    } finally {
      await closeServer(wss);
    }
  });

  it("stop() closes the socket and cancels pending reconnects", async () => {
    const { wss, port } = await startTestServer();
    try {
      client = startWsClient(`ws://127.0.0.1:${port}`, fleetStore, { backoffMs: [50, 50] });

      await vi.waitFor(() => {
        expect(fleetStore.getState().connection).toBe("connected");
      });

      client.stop();

      const connectionAfterStop = fleetStore.getState().connection;
      // No reconnect attempt should flip this back to "reconnecting"/"connecting".
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(fleetStore.getState().connection).toBe(connectionAfterStop);
    } finally {
      await closeServer(wss);
    }
  });
});
