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
