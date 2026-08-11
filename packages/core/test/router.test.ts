import { describe, it, expect } from "vitest";
import { WarehouseMap } from "../src/map.js";
import { PibtRouter, type Agent } from "../src/router.js";
import type { RobotId } from "@tez/shared";

// --- deterministic PRNG (mulberry32) so the random-instance test is stable ---
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

/** Assert the mapping has no vertex conflicts and no edge (head-on) swaps. */
function assertNoConflicts(prev: Map<RobotId, string>, next: Map<RobotId, string>): void {
  const seen = new Set<string>();
  for (const [id, node] of next) {
    expect(seen.has(node), `vertex conflict: two agents targeted ${node}`).toBe(false);
    seen.add(node);
  }
  const ids = [...next.keys()];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const idA = ids[i]!;
      const idB = ids[j]!;
      const prevA = prev.get(idA)!;
      const prevB = prev.get(idB)!;
      const nextA = next.get(idA)!;
      const nextB = next.get(idB)!;
      const isSwap = prevA === nextB && prevB === nextA && prevA !== prevB;
      expect(isSwap, `edge swap between ${idA} and ${idB}`).toBe(false);
    }
  }
}

describe("PibtRouter", () => {
  it("resolves two agents head-on in a corridor with a passing bay", () => {
    // A 5x2 corridor: row 0 is the main lane, row 1 is the passing bay.
    // Two agents start at opposite ends of the main lane with swapped
    // goals, so they meet head-on and must resolve via siding into row 1
    // or waiting — an in-place swap is never legal (would be an edge
    // conflict), and a strict 1-wide path can never resolve a head-on
    // meeting at all (the relative order of two tokens on a path is
    // provably invariant), which is why a passing lane is required.
    const map = WarehouseMap.fromJSON(WarehouseMap.grid(5, 2));

    const router = new PibtRouter(map);
    let agents: Agent[] = [
      { id: "A", at: "n0_0", goal: "n4_0", priority: 0 },
      { id: "B", at: "n4_0", goal: "n0_0", priority: 0 },
    ];

    const maxSteps = 12;
    let steps = 0;
    for (; steps < maxSteps; steps++) {
      if (agents.every((a) => a.at === a.goal)) break;

      const prev = new Map(agents.map((a) => [a.id, a.at]));
      const next = router.step(agents);

      expect(next.size).toBe(agents.length);
      assertNoConflicts(prev, next);

      agents = agents.map((a) => ({ ...a, at: next.get(a.id)! }));
    }

    expect(agents.every((a) => a.at === a.goal)).toBe(true);
    expect(steps).toBeLessThanOrEqual(maxSteps);
  });

  it("keeps a goal-reached agent in place when nobody is pushing it", () => {
    const map = WarehouseMap.fromJSON(WarehouseMap.grid(3, 3));
    const router = new PibtRouter(map);

    const agents: Agent[] = [{ id: "A", at: "n1_1", goal: "n1_1", priority: 0 }];
    const next = router.step(agents);

    expect(next.get("A")).toBe("n1_1");
  });

  it("keeps a goal-reached agent in place across repeated steps even while others move", () => {
    const map = WarehouseMap.fromJSON(WarehouseMap.grid(3, 3));
    const router = new PibtRouter(map);

    // B is already at its goal and sits away from A's path, so nothing
    // should ever push it off n2_2.
    let agents: Agent[] = [
      { id: "A", at: "n0_0", goal: "n0_1", priority: 0 },
      { id: "B", at: "n2_2", goal: "n2_2", priority: 0 },
    ];

    for (let i = 0; i < 3; i++) {
      const next = router.step(agents);
      expect(next.get("B")).toBe("n2_2");
      agents = agents.map((a) => ({ ...a, at: next.get(a.id)! }));
    }
  });

  it("routes 10 agents on a 20x10 grid for 200 steps with no conflicts at any step, all reaching goals", () => {
    const map = WarehouseMap.fromJSON(WarehouseMap.grid(20, 10));
    const router = new PibtRouter(map);

    const rng = mulberry32(1234);
    const shuffled = shuffle(map.nodeIds, rng);
    const starts = shuffled.slice(0, 10);
    const goals = shuffled.slice(10, 20);

    let agents: Agent[] = starts.map((at, i) => ({
      id: `r${i}`,
      at,
      goal: goals[i]!,
      priority: 0,
    }));

    const maxSteps = 200;
    let step = 0;
    for (; step < maxSteps; step++) {
      if (agents.every((a) => a.at === a.goal)) break;

      const prev = new Map(agents.map((a) => [a.id, a.at]));
      const next = router.step(agents);

      expect(next.size).toBe(agents.length);
      assertNoConflicts(prev, next);

      agents = agents.map((a) => ({ ...a, at: next.get(a.id)! }));
    }

    expect(agents.every((a) => a.at === a.goal)).toBe(true);
    expect(step).toBeLessThan(maxSteps);
  });

  it("resolves a 4-agent rotation on a 2x2 grid in one step (no permanent deadlock)", () => {
    // n0_0-n1_0-n1_1-n0_1-n0_0 is a 4-cycle. Every agent's goal is the next
    // node clockwise around the cycle, so all four cells are simultaneously
    // occupied and every agent's best move is "push the agent ahead of me."
    // This is the saturated-cycle case that a naive in-progress-cycle guard
    // deadlocks on forever: with tentative next-cell reservation set before
    // recursing, the push chain sees the ancestor already committed to
    // vacate and the whole rotation resolves in a single step.
    const map = WarehouseMap.fromJSON(WarehouseMap.grid(2, 2));
    const router = new PibtRouter(map);

    let agents: Agent[] = [
      { id: "A", at: "n0_0", goal: "n1_0", priority: 0 },
      { id: "B", at: "n1_0", goal: "n1_1", priority: 0 },
      { id: "C", at: "n1_1", goal: "n0_1", priority: 0 },
      { id: "D", at: "n0_1", goal: "n0_0", priority: 0 },
    ];

    const maxSteps = 5;
    let steps = 0;
    for (; steps < maxSteps; steps++) {
      if (agents.every((a) => a.at === a.goal)) break;

      const prev = new Map(agents.map((a) => [a.id, a.at]));
      const next = router.step(agents);

      expect(next.size).toBe(agents.length);
      assertNoConflicts(prev, next);

      agents = agents.map((a) => ({ ...a, at: next.get(a.id)! }));
    }

    expect(steps).toBe(1); // the whole rotation should close on the very first step
    expect(agents.every((a) => a.at === a.goal)).toBe(true);
  });

  it("resolves a 6-agent ring rotation on a 3x2 grid in one step (no permanent deadlock)", () => {
    // Boundary cycle of the 3x2 grid: n0_0-n1_0-n2_0-n2_1-n1_1-n0_1-n0_0.
    // (grid(3,2) also has a middle vertical chord n1_0-n1_1, which doesn't
    // interfere since it's never any agent's shortest move here.) Every
    // agent's goal is the next node clockwise, saturating the ring the same
    // way as the 4-agent case above, at a size where a naive cycle guard
    // would freeze permanently too.
    const map = WarehouseMap.fromJSON(WarehouseMap.grid(3, 2));
    const router = new PibtRouter(map);

    let agents: Agent[] = [
      { id: "A", at: "n0_0", goal: "n1_0", priority: 0 },
      { id: "B", at: "n1_0", goal: "n2_0", priority: 0 },
      { id: "C", at: "n2_0", goal: "n2_1", priority: 0 },
      { id: "D", at: "n2_1", goal: "n1_1", priority: 0 },
      { id: "E", at: "n1_1", goal: "n0_1", priority: 0 },
      { id: "F", at: "n0_1", goal: "n0_0", priority: 0 },
    ];

    const maxSteps = 5;
    let steps = 0;
    for (; steps < maxSteps; steps++) {
      if (agents.every((a) => a.at === a.goal)) break;

      const prev = new Map(agents.map((a) => [a.id, a.at]));
      const next = router.step(agents);

      expect(next.size).toBe(agents.length);
      assertNoConflicts(prev, next);

      agents = agents.map((a) => ({ ...a, at: next.get(a.id)! }));
    }

    expect(steps).toBe(1);
    expect(agents.every((a) => a.at === a.goal)).toBe(true);
  });

  it("lets a higher seeded base priority win a contested cell", () => {
    // A and B both want the empty center cell as their best first move.
    // A is inserted first in the array (which, under a pure
    // insertion-order priority scheme, would make it LOWER priority and
    // thus the loser) but is given a much higher `priority` seed value, so
    // if that field is actually wired up, A must win despite going first
    // in the array.
    const map = WarehouseMap.fromJSON(WarehouseMap.grid(3, 3));
    const router = new PibtRouter(map);

    const agents: Agent[] = [
      { id: "A", at: "n0_1", goal: "n2_1", priority: 100 },
      { id: "B", at: "n1_0", goal: "n1_2", priority: 1 },
    ];

    const next = router.step(agents);

    expect(next.get("A")).toBe("n1_1"); // A wins the contested center cell
    expect(next.get("B")).toBe("n1_0"); // B falls back to staying
  });

  it("keeps throughput under lifelong goal churn (20 agents, 300 steps, reassigned goals)", () => {
    // Whenever an agent reaches its goal it's immediately handed a new
    // random goal (deterministic via a seeded PRNG), which is the
    // "lifelong MAPF" usage pattern this router's priority reset/increment
    // scheme is designed for. This exercises many goal-reset events across
    // a long run, not just a single one-shot delivery.
    const width = 10;
    const height = 6;
    const map = WarehouseMap.fromJSON(WarehouseMap.grid(width, height));
    const router = new PibtRouter(map);

    const rng = mulberry32(42);
    const nodeIds = map.nodeIds;
    const randomNode = (): string => nodeIds[Math.floor(rng() * nodeIds.length)]!;

    const agentCount = 20;
    const shuffled = shuffle(nodeIds, rng);
    let agents: Agent[] = shuffled.slice(0, agentCount).map((at, i) => ({
      id: `r${i}`,
      at,
      goal: randomNode(),
      priority: 0,
    }));

    let goalsReached = 0;
    const steps = 300;
    for (let t = 0; t < steps; t++) {
      const prev = new Map(agents.map((a) => [a.id, a.at]));
      const next = router.step(agents);

      expect(next.size).toBe(agents.length);
      assertNoConflicts(prev, next);

      agents = agents.map((a) => {
        const at = next.get(a.id)!;
        if (at === a.goal) {
          goalsReached++;
          return { ...a, at, goal: randomNode() };
        }
        return { ...a, at };
      });
    }

    expect(goalsReached).toBeGreaterThan(100);
  });

  it("handles 50 agents on a 20x10 grid within a sane per-step time budget", () => {
    const map = WarehouseMap.fromJSON(WarehouseMap.grid(20, 10));
    const router = new PibtRouter(map);

    const rng = mulberry32(5678);
    const shuffled = shuffle(map.nodeIds, rng);
    const starts = shuffled.slice(0, 50);
    const goals = shuffled.slice(50, 100);

    let agents: Agent[] = starts.map((at, i) => ({
      id: `r${i}`,
      at,
      goal: goals[i]!,
      priority: 0,
    }));

    const stepCount = 30;
    let totalMs = 0;
    for (let i = 0; i < stepCount; i++) {
      const prev = new Map(agents.map((a) => [a.id, a.at]));
      const start = performance.now();
      const next = router.step(agents);
      totalMs += performance.now() - start;

      assertNoConflicts(prev, next);
      agents = agents.map((a) => ({ ...a, at: next.get(a.id)! }));
    }

    const avgMs = totalMs / stepCount;
    expect(avgMs).toBeLessThan(100);
  });
});

describe("boundary-corridor livelock regression (P1)", () => {
  function runUntilAllGoals(
    mapData: ReturnType<typeof WarehouseMap.grid>,
    starts: Array<[string, string]>,
    goals: Array<[string, string]>,
    maxSteps: number
  ): number {
    const map = WarehouseMap.fromJSON(mapData);
    const router = new PibtRouter(map);
    const pos = new Map(starts);
    const goal = new Map(goals);
    for (let t = 0; t < maxSteps; t++) {
      const agents: Agent[] = [...pos.entries()].map(([id, at]) => ({
        id: id as RobotId,
        at,
        goal: goal.get(id)!,
        priority: 0,
      }));
      const moves = router.step(agents);
      for (const [id, next] of moves) pos.set(id as string, next);
      if ([...goal.entries()].every(([id, g]) => pos.get(id) === g)) return t;
    }
    return -1;
  }

  it("two agents with opposite goals in the x=0 column of a 5x5 grid both reach their goals", () => {
    const reachedAt = runUntilAllGoals(
      WarehouseMap.grid(5, 5),
      [["r2", "n0_2"], ["r3", "n0_3"]],
      [["r2", "n0_4"], ["r3", "n0_0"]],
      40
    );
    expect(reachedAt).toBeGreaterThanOrEqual(0);
    expect(reachedAt).toBeLessThanOrEqual(30);
  });

  it("two agents swapping opposite ends of an 8x2 grid both reach their goals", () => {
    const reachedAt = runUntilAllGoals(
      WarehouseMap.grid(8, 2),
      [["a", "n0_0"], ["b", "n7_0"]],
      [["a", "n7_0"], ["b", "n0_0"]],
      60
    );
    expect(reachedAt).toBeGreaterThanOrEqual(0);
    expect(reachedAt).toBeLessThanOrEqual(40);
  });
});

describe("PibtRouter priorities prune (#8)", () => {
  it("priority state for vanished agents is pruned", () => {
    const map = WarehouseMap.grid(4, 4);
    const router = new PibtRouter(WarehouseMap.fromJSON(map));
    const a: Agent = { id: "a" as RobotId, at: "n0_0", goal: "n3_3", priority: 0 };
    const b: Agent = { id: "b" as RobotId, at: "n3_0", goal: "n0_3", priority: 0 };
    const c: Agent = { id: "c" as RobotId, at: "n0_3", goal: "n3_0", priority: 0 };

    router.step([a, b, c]);
    expect(router._prioritySize()).toBe(3);

    // c vanishes from the fleet (e.g. offline/removed) — every subsequent
    // step only ever sees [a, b]. Priority state for c must be pruned, not
    // retained forever: assert the live count matches the CURRENT agent
    // set after each step, not just once.
    for (let i = 0; i < 5; i++) {
      router.step([a, b]);
      expect(router._prioritySize()).toBe(2);
    }
  });
});
