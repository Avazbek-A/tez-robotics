import { act, renderHook } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket as NodeWebSocketClient, WebSocketServer } from "ws";
import { KPI_BUFFER_CAP, fleetStore, useFleetStore } from "../src/store";
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
  kpiBuffer: [],
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

  it("applyFrame appends one kpiBuffer sample per call", () => {
    expect(fleetStore.getState().kpiBuffer).toHaveLength(0);

    fleetStore.getState().applyFrame(makeFrame(1));
    expect(fleetStore.getState().kpiBuffer).toHaveLength(1);
    expect(fleetStore.getState().kpiBuffer[0]).toMatchObject({
      kpis: { ordersPerHour: 0, avgCycleMs: 0, utilization: 0 },
    });
    expect(typeof fleetStore.getState().kpiBuffer[0].t).toBe("number");

    fleetStore.getState().applyFrame(makeFrame(2));
    expect(fleetStore.getState().kpiBuffer).toHaveLength(2);
  });

  it("applyFrame caps kpiBuffer at 600 samples, dropping the oldest first", () => {
    for (let i = 0; i < KPI_BUFFER_CAP + 50; i++) {
      const frame = makeFrame(i);
      frame.kpis = { ordersPerHour: i, avgCycleMs: 0, utilization: 0 };
      fleetStore.getState().applyFrame(frame);
    }

    const buffer = fleetStore.getState().kpiBuffer;
    expect(buffer).toHaveLength(KPI_BUFFER_CAP);
    // Oldest 50 samples (ordersPerHour 0..49) were dropped; the buffer now
    // starts at sample 50 and ends at the last appended sample.
    expect(buffer[0].kpis.ordersPerHour).toBe(50);
    expect(buffer[buffer.length - 1].kpis.ordersPerHour).toBe(KPI_BUFFER_CAP + 49);
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
