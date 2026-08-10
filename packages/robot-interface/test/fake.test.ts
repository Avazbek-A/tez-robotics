import { describe, it, expect, beforeEach } from "vitest";
import { FakeAdapter } from "../src/fake.js";
import { WarehouseMap } from "@tez/core";
import type { Mission, AdapterEvent } from "../src/adapter.js";

describe("FakeAdapter", () => {
  let adapter: FakeAdapter;
  let map: WarehouseMap;

  beforeEach(() => {
    // Create a simple 3-node linear map: n0 -> n1 -> n2
    map = WarehouseMap.fromJSON({
      nodes: [
        { id: "n0", pos: { x: 0, y: 0 } },
        { id: "n1", pos: { x: 1, y: 0 } },
        { id: "n2", pos: { x: 2, y: 0 } },
      ],
      edges: [
        { from: "n0", to: "n1", bidirectional: true },
        { from: "n1", to: "n2", bidirectional: true },
      ],
    });

    // Create adapter with one robot starting at n0
    adapter = new FakeAdapter(
      [{ id: "r1", startNodeId: "n0" }],
      map
    );
  });

  describe("initialization", () => {
    it("should initialize robot with correct starting position", () => {
      const robots = adapter.robots();
      expect(robots).toHaveLength(1);
      expect(robots[0].id).toBe("r1");
      expect(robots[0].pos).toEqual({ x: 0, y: 0 });
      expect(robots[0].status).toBe("IDLE");
      expect(robots[0].battery).toBe(1);
    });

    it("should track multiple robots", () => {
      const multiAdapter = new FakeAdapter(
        [
          { id: "r1", startNodeId: "n0" },
          { id: "r2", startNodeId: "n1" },
        ],
        map
      );
      const robots = multiAdapter.robots();
      expect(robots).toHaveLength(2);
    });
  });

  describe("mission execution", () => {
    it("should walk 3-node mission and emit progress then done", async () => {
      const mission: Mission = {
        id: "m1",
        robotId: "r1",
        nodeIds: ["n0", "n1", "n2"],
      };

      const events: AdapterEvent[] = [];
      adapter.on((e: AdapterEvent) => events.push(e));

      await adapter.start();
      await adapter.sendMission(mission, map);

      // Tick 1: move from n0 to n1
      adapter.tick();
      expect(events.length).toBeGreaterThan(0);
      const stateEvent1 = events.find((e) => e.type === "state");
      expect(stateEvent1?.type).toBe("state");
      if (stateEvent1?.type === "state") {
        expect(stateEvent1.state.pos).toEqual({ x: 1, y: 0 });
        expect(stateEvent1.state.status).toBe("EXECUTING");
      }

      const progressEvent1 = events.find((e) => e.type === "missionProgress");
      expect(progressEvent1?.type).toBe("missionProgress");
      if (progressEvent1?.type === "missionProgress") {
        expect(progressEvent1.lastNodeId).toBe("n1");
      }

      events.length = 0;

      // Tick 2: move from n1 to n2
      adapter.tick();
      const stateEvent2 = events.find((e) => e.type === "state");
      expect(stateEvent2?.type).toBe("state");
      if (stateEvent2?.type === "state") {
        expect(stateEvent2.state.pos).toEqual({ x: 2, y: 0 });
      }

      const progressEvent2 = events.find((e) => e.type === "missionProgress");
      expect(progressEvent2?.type).toBe("missionProgress");
      if (progressEvent2?.type === "missionProgress") {
        expect(progressEvent2.lastNodeId).toBe("n2");
      }

      events.length = 0;

      // Tick 3: should emit missionDone (no more progress)
      adapter.tick();
      const doneEvent = events.find((e) => e.type === "missionDone");
      expect(doneEvent?.type).toBe("missionDone");
      if (doneEvent?.type === "missionDone") {
        expect(doneEvent.missionId).toBe("m1");
      }

      // Robot should be IDLE after mission done
      const robots = adapter.robots();
      expect(robots[0].status).toBe("IDLE");
      expect(robots[0].currentMissionId).toBeUndefined();

      await adapter.stop();
    });

    it("should emit state event on every tick", async () => {
      const mission: Mission = {
        id: "m1",
        robotId: "r1",
        nodeIds: ["n0", "n1", "n2"],
      };

      const events: AdapterEvent[] = [];
      adapter.on((e: AdapterEvent) => events.push(e));

      await adapter.start();
      await adapter.sendMission(mission, map);

      adapter.tick();
      const stateEvents = events.filter((e) => e.type === "state");
      expect(stateEvents.length).toBeGreaterThanOrEqual(1);

      await adapter.stop();
    });

    it("should support mission extension (same id, longer nodeIds)", async () => {
      const mission1: Mission = {
        id: "m1",
        robotId: "r1",
        nodeIds: ["n0", "n1"],
      };

      const events: AdapterEvent[] = [];
      adapter.on((e: AdapterEvent) => events.push(e));

      await adapter.start();
      await adapter.sendMission(mission1, map);

      // Advance to n1
      adapter.tick();
      events.length = 0;

      // Extend mission to include n2
      const mission2: Mission = {
        id: "m1", // same id
        robotId: "r1",
        nodeIds: ["n0", "n1", "n2"], // strict prefix extension
      };
      await adapter.sendMission(mission2, map);

      // Should continue without restart
      adapter.tick();
      const stateEvent = events.find((e) => e.type === "state");
      if (stateEvent?.type === "state") {
        expect(stateEvent.state.pos).toEqual({ x: 2, y: 0 });
      }

      await adapter.stop();
    });

    it("should preserve robot position on mid-mission extension", async () => {
      // Create a larger map for this test: n0 -> n1 -> n2 -> n3 -> n4
      const largerMap = WarehouseMap.fromJSON({
        nodes: [
          { id: "n0", pos: { x: 0, y: 0 } },
          { id: "n1", pos: { x: 1, y: 0 } },
          { id: "n2", pos: { x: 2, y: 0 } },
          { id: "n3", pos: { x: 3, y: 0 } },
          { id: "n4", pos: { x: 4, y: 0 } },
        ],
        edges: [
          { from: "n0", to: "n1", bidirectional: true },
          { from: "n1", to: "n2", bidirectional: true },
          { from: "n2", to: "n3", bidirectional: true },
          { from: "n3", to: "n4", bidirectional: true },
        ],
      });

      const mission1: Mission = {
        id: "m1",
        robotId: "r1",
        nodeIds: ["n0", "n1", "n2"],
      };

      const events: AdapterEvent[] = [];
      adapter.on((e: AdapterEvent) => events.push(e));

      await adapter.start();
      await adapter.sendMission(mission1, largerMap);

      // Advance to n1
      adapter.tick();
      events.length = 0;

      // Record position before extension
      const robotsBeforeExtend = adapter.robots();
      const posBeforeExtend = robotsBeforeExtend[0].pos;

      // Extend mission with more nodes
      const mission2: Mission = {
        id: "m1",
        robotId: "r1",
        nodeIds: ["n0", "n1", "n2", "n3", "n4"], // longer path, same prefix
      };
      await adapter.sendMission(mission2, largerMap);

      // Position should NOT change on extension
      const robotsAfterExtend = adapter.robots();
      expect(robotsAfterExtend[0].pos).toEqual(posBeforeExtend);

      await adapter.stop();
    });

    it("should reject extension with shorter nodeIds", async () => {
      const mission1: Mission = {
        id: "m1",
        robotId: "r1",
        nodeIds: ["n0", "n1", "n2"],
      };

      await adapter.start();
      await adapter.sendMission(mission1, map);
      adapter.tick();

      // Try to extend with shorter array
      const shorterMission: Mission = {
        id: "m1",
        robotId: "r1",
        nodeIds: ["n0", "n1"], // shorter!
      };

      await expect(adapter.sendMission(shorterMission, map)).rejects.toThrow(
        "invalid mission extension"
      );

      await adapter.stop();
    });

    it("should reject extension with mismatched prefix", async () => {
      const mission1: Mission = {
        id: "m1",
        robotId: "r1",
        nodeIds: ["n0", "n1", "n2"],
      };

      await adapter.start();
      await adapter.sendMission(mission1, map);
      adapter.tick();

      // Try to extend with different path
      const mismatchedMission: Mission = {
        id: "m1",
        robotId: "r1",
        nodeIds: ["n1", "n2"], // mismatched prefix!
      };

      await expect(adapter.sendMission(mismatchedMission, map)).rejects.toThrow(
        "invalid mission extension"
      );

      await adapter.stop();
    });
  });

  describe("cancelMission", () => {
    it("should stop robot and set status to IDLE", async () => {
      const mission: Mission = {
        id: "m1",
        robotId: "r1",
        nodeIds: ["n0", "n1", "n2"],
      };

      const events: AdapterEvent[] = [];
      adapter.on((e: AdapterEvent) => events.push(e));

      await adapter.start();
      await adapter.sendMission(mission, map);

      // Advance one node
      adapter.tick();
      events.length = 0;

      // Cancel mission
      await adapter.cancelMission("r1");

      // Tick should not emit progress or done events
      adapter.tick();
      const progressEvents = events.filter(
        (e) => e.type === "missionProgress" || e.type === "missionDone"
      );
      expect(progressEvents.length).toBe(0);

      // Robot should be IDLE
      const robots = adapter.robots();
      expect(robots[0].status).toBe("IDLE");
      expect(robots[0].currentMissionId).toBeUndefined();

      await adapter.stop();
    });

    it("should not emit events after cancel", async () => {
      const mission: Mission = {
        id: "m1",
        robotId: "r1",
        nodeIds: ["n0", "n1", "n2"],
      };

      const events: AdapterEvent[] = [];
      adapter.on((e: AdapterEvent) => events.push(e));

      await adapter.start();
      await adapter.sendMission(mission, map);
      adapter.tick();

      events.length = 0;
      await adapter.cancelMission("r1");

      // Multiple ticks should not generate any mission-related events
      adapter.tick();
      adapter.tick();
      adapter.tick();

      const missionEvents = events.filter(
        (e) => e.type === "missionProgress" || e.type === "missionDone"
      );
      expect(missionEvents.length).toBe(0);

      await adapter.stop();
    });
  });

  describe("multiple handlers", () => {
    it("should support multiple event handlers", async () => {
      const mission: Mission = {
        id: "m1",
        robotId: "r1",
        nodeIds: ["n0", "n1"],
      };

      const events1: AdapterEvent[] = [];
      const events2: AdapterEvent[] = [];

      adapter.on((e) => events1.push(e));
      adapter.on((e) => events2.push(e));

      await adapter.start();
      await adapter.sendMission(mission, map);
      adapter.tick();

      expect(events1.length).toBeGreaterThan(0);
      expect(events2.length).toBeGreaterThan(0);
      expect(events1.length).toBe(events2.length);

      await adapter.stop();
    });

    it("should use EventEmitter-style no-dedup (same handler added twice receives duplicates)", async () => {
      const mission: Mission = {
        id: "m1",
        robotId: "r1",
        nodeIds: ["n0", "n1"],
      };

      const events: AdapterEvent[] = [];
      const handler = (e: AdapterEvent) => events.push(e);

      adapter.on(handler);
      adapter.on(handler); // add same handler twice

      await adapter.start();
      await adapter.sendMission(mission, map);
      adapter.tick();

      // Events should be received twice by the duplicate handler
      const stateEvents = events.filter((e) => e.type === "state");
      expect(stateEvents.length).toBe(2); // duplicated

      await adapter.stop();
    });
  });

  describe("robots snapshot", () => {
    it("should return current robot states", async () => {
      const mission: Mission = {
        id: "m1",
        robotId: "r1",
        nodeIds: ["n0", "n1", "n2"],
      };

      await adapter.start();
      await adapter.sendMission(mission, map);

      adapter.tick();
      const robots = adapter.robots();

      expect(robots).toHaveLength(1);
      expect(robots[0].id).toBe("r1");
      expect(robots[0].pos).toEqual({ x: 1, y: 0 });
      expect(robots[0].status).toBe("EXECUTING");
      expect(robots[0].currentMissionId).toBe("m1");

      await adapter.stop();
    });
  });
});
