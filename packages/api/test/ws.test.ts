import { describe, it, expect } from "vitest";
import WebSocket from "ws";
import { buildSystem } from "../src/system.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";

describe("WS /ws/state", () => {
  it("streams frames with robots and increasing seq", async () => {
    const sys = await buildSystem(loadConfig({ DEMO: "1", TICK_MS: "10" }));
    await sys.start();
    const app = await buildServer(sys);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as { port: number }).port;
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/state`);
      const frames: any[] = [];
      await new Promise<void>((resolve, reject) => {
        ws.on("message", (d) => {
          frames.push(JSON.parse(d.toString()));
          if (frames.length >= 3) { ws.close(); resolve(); }
        });
        ws.on("error", reject);
      });
      expect(frames[0].robots).toHaveLength(3);
      expect(frames[2].seq).toBeGreaterThan(frames[0].seq);
      expect(frames[0]).toHaveProperty("kpis.utilization");
    } finally {
      await app.close(); await sys.stop();
    }
  });
});
