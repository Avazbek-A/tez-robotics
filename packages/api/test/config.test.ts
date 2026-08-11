import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("defaults to vda mode on empty env throws without MQTT_URL", () => {
    expect(() => loadConfig({})).toThrow(/MQTT_URL/);
  });
  it("defaults checked via DEV_BROKER passthrough", () => {
    const c = loadConfig({ DEV_BROKER: "1" });
    expect(c.mode).toBe("vda");
    expect(c.port).toBe(8080);
    expect(c.tickMs).toBe(500);
    expect(c.robots).toBe(3);
    expect(c.devBroker).toBe(true);
  });
  it("DEMO=1 switches mode", () => {
    expect(loadConfig({ DEMO: "1" }).mode).toBe("demo");
  });
  it("parses numbers and rejects garbage", () => {
    expect(loadConfig({ PORT: "9000", DEV_BROKER: "1" }).port).toBe(9000);
    expect(() => loadConfig({ PORT: "abc", DEV_BROKER: "1" })).toThrow(/PORT/);
    expect(() => loadConfig({ PORT: "9000x", DEV_BROKER: "1" })).toThrow(/PORT/);
  });
  it("vda mode without MQTT_URL and without DEV_BROKER throws", () => {
    expect(() => loadConfig({ DEMO: "0" })).toThrow(/MQTT_URL/);
    expect(loadConfig({ DEV_BROKER: "1" }).devBroker).toBe(true);
  });
});
