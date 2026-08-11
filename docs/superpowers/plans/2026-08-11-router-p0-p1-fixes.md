# P0 Extension-Flood + P1 PIBT Oscillation Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the two confirmed correctness gaps blocking real-hardware pilots: (P1) PIBT boundary-corridor livelock, and (P0) unconditional per-tick mission extension with advisory-only reservations.

**Architecture:** P1 is a 4-line deterministic tie-break change in the PIBT candidate sort (prefer unoccupied cells on equal distance) — already validated against both repros and the full 89-test core suite during root-cause investigation. P0 restructures `Orchestrator.runRouting()`: PIBT plans over each active leg's commanded FRONTIER node (a consistent virtual configuration) instead of the robot's true position; extension is gated on the robot being within `opts.horizon` nodes of the frontier; a `ReservationTable.claim()` covering the whole uncommitted window must be FULLY granted before any extension is sent; sustained claim failure requeues the order (deadlock backstop). Idle robots always hold their current cell so nobody is ever routed through a parked robot.

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, pnpm workspaces (`corepack pnpm` only), packages `@tez/core`, `@tez/orchestrator`, `@tez/robot-interface`, `@tez/sim`.

## Global Constraints

- Run all commands from the worktree root: `/Users/avazbek/Desktop/Repository/tez-robotics/.worktrees/fix-router-p0-p1`
- pnpm ONLY via `corepack pnpm`. `.npmrc` `workspace-concurrency=1` must stay.
- `tsc --noEmit` must stay clean in every package: `corepack pnpm -r exec tsc --noEmit`
- Mission extensions must remain STRICT PREFIX of the previously sent path — adapters throw otherwise (`packages/robot-interface/src/adapter.ts:21-26`). Gating pauses extension; it never rewrites a committed prefix.
- ReservationTable contract (`packages/core/src/reservations.ts`): claim set is the robot's complete desired hold-set in path order, robot's current cell FIRST; empty grant = strict no-op; non-empty grant releases all prior holds not in the granted prefix.
- Determinism: no `Math.random()`, no wall-clock dependence in core/orchestrator logic (tests use FakeAdapter lockstep + injected `now`).
- License gate: MIT/Apache/BSD/EPL only. The P1 fix is an original heuristic tie-break, no external code.
- Conventional commits. Do NOT push to GitHub (public repo; push is the owner's call).
- Existing test counts to protect: shared 1, core 89, robot-interface 26+1skip, orchestrator 15, sim 18.

---

### Task 1: P1 — PIBT occupancy-aware tie-break (livelock fix)

**Files:**
- Modify: `packages/core/src/router.ts:98-103` (candidate sort inside `step()`)
- Test: `packages/core/test/router.test.ts` (append two regression tests)

**Interfaces:**
- Consumes: existing `PibtRouter.step(agents: Agent[]): Map<RobotId, string>`, `WarehouseMap.fromJSON`, `WarehouseMap.grid(width, height)` (returns `RawMapData`), node ids shaped `n{x}_{y}`.
- Produces: no API change. Behavior change only: on equal BFS distance, candidate cells NOT currently occupied by another agent sort before occupied ones; lexicographic node-id order remains the final tie-break.

**Background (verified during root-cause investigation):** two agents in the x=0 boundary column of a 5x5 grid with opposite goals livelock in a repeating 10-step cycle: each agent reaches its goal only while the other is still traveling, then the off-goal agent's ever-growing priority lets it push the at-goal agent off, and the pattern mirrors forever. Mechanism: the candidate sort breaks distance ties lexicographically, so an agent walking toward a tied pair {occupied-goal-cell, free-parallel-cell} always picks the occupied cell and shoves its peer. Preferring the unoccupied cell on ties lets the traveler take the parallel column and the at-goal agent stay parked. Validated: both repros below reach goals (t=6 and t=8), all 89 existing core tests stay green.

- [ ] **Step 1: Write the two failing regression tests**

Append to `packages/core/test/router.test.ts` (match the file's existing import style — it already imports `WarehouseMap`, `PibtRouter`, `Agent`; reuse its helpers if equivalent ones exist):

```typescript
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
```

If `RobotId` is not already imported in the test file, add `import type { RobotId } from "@tez/shared";`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && corepack pnpm vitest run test/router.test.ts`
Expected: the two new tests FAIL (`reachedAt` is `-1`); all pre-existing tests PASS.

- [ ] **Step 3: Implement the tie-break**

In `packages/core/src/router.ts`, inside `step()`'s `pibt` closure, replace the candidate sort:

```typescript
      const candidates = [...this.map.neighbors(agent.at), agent.at].sort((a, b) => {
        const da = this.map.distance(a, agent.goal);
        const db = this.map.distance(b, agent.goal);
        if (da !== db) return da - db;
        // Tie-break 2: prefer cells not currently occupied by another agent.
        // Without this, an agent walking toward a distance-tied pair
        // {occupied cell, free cell} always picks the lexicographically
        // smaller one — which in boundary corridors is systematically the
        // occupied one, shoving an at-goal peer off its goal and producing
        // a deterministic livelock (two opposite-goal agents in one column
        // mirror each other forever). Preferring the free cell routes the
        // traveler around a parked agent whenever an equal-cost detour
        // exists, while full-occupancy scenarios (rotations, saturation)
        // are unaffected because then every candidate carries the penalty.
        const oa = occupied.has(a) && occupied.get(a) !== agentId ? 1 : 0;
        const ob = occupied.has(b) && occupied.get(b) !== agentId ? 1 : 0;
        if (oa !== ob) return oa - ob;
        return a < b ? -1 : a > b ? 1 : 0;
      });
```

Determinism is preserved: `occupied` is fixed for the whole step, so the sort key is stable and the final lexicographic tie-break still yields a strict order.

- [ ] **Step 4: Run the full core suite**

Run: `cd packages/core && corepack pnpm vitest run`
Expected: 91 tests pass (89 existing + 2 new). Pay attention to the saturation-rotation and churn tests — they must pass unchanged.

- [ ] **Step 5: Typecheck and commit**

Run: `corepack pnpm -r exec tsc --noEmit`
Expected: clean.

```bash
git add packages/core/src/router.ts packages/core/test/router.test.ts
git commit -m "fix(core): PIBT prefers unoccupied cells on distance ties, ending corridor livelock"
```

---

### Task 2: P0 — horizon-gated, reservation-blocked mission extension

**Files:**
- Modify: `packages/orchestrator/src/orchestrator.ts` (types `OrchestratorOpts`, `RobotLeg`; functions `runRouting`, `resolveCurrentNodes`, `runDispatch` leg creation, `handleMissionDone` leg creation, class JSDoc)
- Test: `packages/orchestrator/test/orchestrator.test.ts` (append tests; follow the file's existing FakeAdapter + tickOnce patterns)

**Interfaces:**
- Consumes: `ReservationTable.claim/owner/release/releaseAll` (contract in Global Constraints), `PibtRouter.step`, `OrderBook.requeue` (3rd requeue → order fails), `setLeg(rt, leg)` (the ONLY leg assignment path), `cellKey`, `FakeAdapter` (lockstep `tick()`), adapter strict-prefix rule.
- Produces: `RobotLeg` gains `progressIndex: number` and `blockedTicks: number` (both initialized `0` at every `setLeg` call site that creates a leg). `OrchestratorOpts` gains `blockedTicksLimit?: number` (default 20) — consecutive fully-blocked ticks after which the leg's order is requeued. `opts.horizon` (already present, default 5) becomes ACTIVE: max number of committed-but-untraversed nodes ahead of the robot.

**Design (from root-cause investigation — read before coding):**

Verified defects in current `runRouting()` (orchestrator.ts:656-706):
1. Extends the leg by one node EVERY tick regardless of robot progress → order-update flood, ~20s/cell beyond ~5-6 cell legs.
2. Appends PIBT's move computed from the robot's TRUE position onto the path's FRONTIER. When the robot lags the frontier (always, under wall-clock), the appended node is generally not adjacent to the frontier — the committed path becomes geometrically invalid, which is how two robots' commanded paths drift onto the same cell for real.
3. `claim()` failure only logs; mission sends anyway (advisory reservations, contradicts spec).
4. The contention alarm prints `owner(aheadCell)` which is usually `undefined`; the actual blocker is the first non-granted cell.

New `runRouting()` semantics:
- PIBT agents for legged robots use the leg's FRONTIER node as `at` (virtual configuration that plans ahead of the physical robots); idle/legless robots use their true current node with `goal === at`. The virtual configuration is kept collision-consistent by reservations, and appended moves are adjacent to the frontier by construction (fixes defect 2).
- Extension for a leg happens ONLY when `frontierIndex - progressIndex < opts.horizon` (fixes defect 1: once the robot falls `horizon` nodes behind the commanded frontier, extension pauses until it catches up; no resend happens while paused because nothing changed).
- Before committing an extension, claim the robot's whole uncommitted window `[nodeIds[progressIndex] .. candidate]` in path order. Commit ONLY on full grant (fixes defect 3). On partial/empty grant: no extension, no send; count `blockedTicks++`; on full grant or robot progress reset `blockedTicks = 0`.
- `blockedTicks >= opts.blockedTicksLimit` → deadlock backstop: alarm + `adapter.cancelMission` + `book.requeue(orderId, ...)` + `reservations.releaseAll` + `setLeg(rt, undefined)` (same recovery shape as `handleMissionFailed`). OrderBook's 3-retry cap then fails genuinely unroutable orders instead of hanging them forever.
- `progressIndex` advances monotonically: scan `nodeIds` forward from the current `progressIndex` for the first entry equal to `rt.currentNodeId`; never scan backward (paths may revisit nodes; VDA executes in order).
- Idle robots must own their current cell: in `resolveCurrentNodes()`, after the existing `release()` trim, a robot with NO leg claims `[currentCell]` so nobody can commit a path through a parked robot. (A legged robot must NOT do this — it would release its committed window.)

Known accepted limitation (document in class JSDoc, do not fix here): a parked idle robot on the only path blocks orders into backstop-requeue (PIBT pushes it only virtually; nothing dispatches parking moves). BACKLOG follow-up, not this task.

- [ ] **Step 1: Write failing tests**

Append to `packages/orchestrator/test/orchestrator.test.ts`. Use the file's existing setup helpers where present; the essential pattern is FakeAdapter + `tickOnce()`. Wrap the adapter to spy on sent missions:

```typescript
function spyMissions(adapter: FakeAdapter): Array<{ robotId: string; id: string; nodeIds: string[] }> {
  const sent: Array<{ robotId: string; id: string; nodeIds: string[] }> = [];
  const orig = adapter.sendMission.bind(adapter);
  adapter.sendMission = async (m, map) => {
    sent.push({ robotId: m.robotId as string, id: m.id, nodeIds: [...m.nodeIds] });
    return orig(m, map);
  };
  return sent;
}

describe("P0: horizon-gated, reservation-blocked extension", () => {
  it("stops extending when the robot lags horizon nodes behind the frontier", () => {
    const map = WarehouseMap.fromJSON(WarehouseMap.grid(12, 1));
    const adapter = new FakeAdapter([{ id: "r1" as RobotId, startNodeId: "n0_0" }], map);
    const sent = spyMissions(adapter);
    const orch = new Orchestrator(map, adapter, { horizon: 3 });
    adapter.tick(); // seed state event
    orch.tickOnce(); // registers robot
    orch.submitOrder("n11_0", "n0_0");
    // Drive many orchestrator ticks WITHOUT letting the robot move:
    for (let i = 0; i < 15; i++) orch.tickOnce();
    const last = sent[sent.length - 1]!;
    // Robot never moved from n0_0 (progressIndex 0) => frontier may be at
    // most `horizon` nodes ahead => path length at most 1 + 3.
    expect(last.nodeIds.length).toBeLessThanOrEqual(4);
    // And extension resumes once the robot catches up:
    for (let i = 0; i < 3; i++) { adapter.tick(); orch.tickOnce(); }
    const after = sent[sent.length - 1]!;
    expect(after.nodeIds.length).toBeGreaterThan(last.nodeIds.length);
  });

  it("every sent path is a chain of adjacent nodes", () => {
    const map = WarehouseMap.fromJSON(WarehouseMap.grid(6, 6));
    const adapter = new FakeAdapter(
      [
        { id: "r1" as RobotId, startNodeId: "n0_0" },
        { id: "r2" as RobotId, startNodeId: "n5_5" },
      ],
      map
    );
    const sent = spyMissions(adapter);
    const orch = new Orchestrator(map, adapter, { horizon: 5 });
    adapter.tick();
    orch.tickOnce();
    orch.submitOrder("n5_0", "n0_5");
    orch.submitOrder("n0_5", "n5_0");
    // Skewed cadence: adapter advances only every 2nd orchestrator tick.
    for (let i = 0; i < 80; i++) {
      if (i % 2 === 0) adapter.tick();
      orch.tickOnce();
    }
    for (const m of sent) {
      for (let i = 1; i < m.nodeIds.length; i++) {
        expect(
          map.neighbors(m.nodeIds[i - 1]!).includes(m.nodeIds[i]!),
          `${m.robotId} ${m.id}: ${m.nodeIds[i - 1]} -> ${m.nodeIds[i]} not adjacent`
        ).toBe(true);
      }
    }
  });

  it("two robots' committed windows never overlap a cell (skewed cadence)", () => {
    const map = WarehouseMap.fromJSON(WarehouseMap.grid(6, 6));
    const adapter = new FakeAdapter(
      [
        { id: "r1" as RobotId, startNodeId: "n0_0" },
        { id: "r2" as RobotId, startNodeId: "n5_0" },
      ],
      map
    );
    const sent = spyMissions(adapter);
    const orch = new Orchestrator(map, adapter, { horizon: 5 });
    adapter.tick();
    orch.tickOnce();
    // Crossing routes along the same row
    orch.submitOrder("n5_0", "n5_5"); // likely r1: crosses toward x=5
    orch.submitOrder("n0_0", "n0_5"); // likely r2: crosses toward x=0
    const latestByRobot = new Map<string, string[]>();
    for (let i = 0; i < 120; i++) {
      if (i % 3 !== 0) adapter.tick(); // robots run FASTER than planner some ticks, slower others
      orch.tickOnce();
      for (const m of sent.splice(0)) latestByRobot.set(m.robotId, m.nodeIds);
      // committed windows = suffix of each latest path from the robot's
      // current node onward; they must be cell-disjoint between robots.
      const windows: Array<Set<string>> = [];
      for (const [rid, nodeIds] of latestByRobot) {
        const state = adapter.robots().find((r) => r.id === rid)!;
        const curKey = `${state.pos.x},${state.pos.y}`;
        const idx = nodeIds.findIndex((n) => {
          const p = map.node(n).pos;
          return `${p.x},${p.y}` === curKey;
        });
        const from = idx === -1 ? 0 : idx;
        windows.push(new Set(nodeIds.slice(from)));
      }
      if (windows.length === 2) {
        for (const cell of windows[0]!) {
          expect(windows[1]!.has(cell), `tick ${i}: shared cell ${cell}`).toBe(false);
        }
      }
    }
  });

  it("sustained reservation contention requeues the order (deadlock backstop)", () => {
    // 3x1 corridor: r2 is idle and parked mid-corridor; r1's only path to
    // the pickup runs through it. Extension must block (r2 owns its cell),
    // and after blockedTicksLimit ticks the order must be requeued, and
    // after 3 requeues it must fail — never hang.
    const map = WarehouseMap.fromJSON(WarehouseMap.grid(3, 1));
    const adapter = new FakeAdapter(
      [
        { id: "r1" as RobotId, startNodeId: "n0_0" },
        { id: "r2" as RobotId, startNodeId: "n1_0" },
      ],
      map
    );
    const orch = new Orchestrator(map, adapter, { horizon: 3, blockedTicksLimit: 5 });
    adapter.tick();
    orch.tickOnce();
    const order = orch.submitOrder("n2_0", "n0_0");
    for (let i = 0; i < 60; i++) {
      adapter.tick();
      orch.tickOnce();
    }
    const snap = orch.snapshot();
    const o = snap.orders.find((x) => x.id === order.id)!;
    expect(o.status).toBe("failed");
    expect(orch.getAlarms().some((a) => a.includes("contention") || a.includes("blocked"))).toBe(true);
  });
});
```

Adjust identifiers to the test file's actual imports (`WarehouseMap`, `FakeAdapter`, `Orchestrator`, `RobotId`); dispatch may assign either order to either robot in the overlap test — the invariant holds regardless of assignment. If `submitOrder`'s dispatch in the backstop test assigns the order to r2 instead of r1 (r2 is closer to n2_0), pin the intended assignment by giving r2 a battery/status that excludes it OR simply place r2 offline via `adapter.setConnection("r2", false)` after registration — then r1 gets the order and r2 still owns its parked cell. Choose whichever the existing test file's patterns make cleanest, and note it in a comment.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/orchestrator && corepack pnpm vitest run`
Expected: the 4 new tests FAIL (unbounded growth, non-adjacent appends, overlapping windows, order stuck non-terminal). All 15 existing tests PASS.

- [ ] **Step 3: Implement**

In `packages/orchestrator/src/orchestrator.ts`:

3a. `OrchestratorOpts`: add below `horizon`:

```typescript
  /**
   * Deadlock backstop: consecutive fully-blocked routing ticks (robot
   * caught up to its frontier but the reservation claim for the next cell
   * keeps failing) after which the leg's order is requeued. Default 20
   * (= 10s at the default 500ms tick).
   */
  blockedTicksLimit?: number;
```

Wire it in the constructor: `blockedTicksLimit: opts?.blockedTicksLimit ?? 20,` and widen the `Required<Omit<...>>` accordingly (it already covers all non-`now` opts — no type change needed beyond the field).

Update the `horizon` doc comment: it is now active — "max committed-but-untraversed nodes ahead of the robot; extension pauses at this depth until the robot catches up".

3b. `RobotLeg`: add

```typescript
  /** Index into nodeIds of the robot's confirmed position on this path (monotonic). */
  progressIndex: number;
  /** Consecutive routing ticks the leg was extension-blocked by a failed claim. */
  blockedTicks: number;
```

Add `progressIndex: 0, blockedTicks: 0,` at BOTH leg-creating `setLeg` call sites (`runDispatch` assignment ~line 637, `handleMissionDone` pick→drop ~line 449).

3c. `resolveCurrentNodes()`: after the existing `this.reservations.release(id, cellKey(...))` line, add:

```typescript
      if (!rt.leg) {
        // Idle robots always own the cell they are parked on, so no other
        // robot's committed window can ever be granted through them.
        this.reservations.claim(id, [cellKey(this.map.node(nodeId).pos)]);
      }
```

3d. Replace `runRouting()` entirely:

```typescript
  private runRouting(): void {
    const agents: Agent[] = [];
    for (const [id, rt] of this.robots) {
      if (rt.quarantined || rt.currentNodeId === undefined) continue;
      if (rt.leg && rt.leg.nodeIds.length > 0) {
        // Plan from the leg's commanded FRONTIER, not the robot's true
        // position: appended moves are then adjacent to the frontier by
        // construction, and the planned configuration stays internally
        // consistent even when physical robots lag behind their frontiers.
        const frontier = rt.leg.nodeIds[rt.leg.nodeIds.length - 1]!;
        agents.push({ id, at: frontier, goal: rt.leg.goalNode, priority: 0 });
      } else {
        agents.push({ id, at: rt.currentNodeId, goal: rt.currentNodeId, priority: 0 });
      }
    }
    if (agents.length === 0) return;

    const moves = this.router.step(agents);

    for (const [id, rt] of this.robots) {
      if (!rt.leg || rt.currentNodeId === undefined) continue;
      const leg = rt.leg;
      if (leg.nodeIds.length === 0) continue; // seeded next resolveCurrentNodes pass

      // Advance monotonic progress: first match of the robot's current
      // node at or after the previous progress index (paths may revisit
      // nodes; the robot traverses them in order, so never scan backward).
      for (let j = leg.progressIndex; j < leg.nodeIds.length; j++) {
        if (leg.nodeIds[j] === rt.currentNodeId) {
          if (j > leg.progressIndex) {
            leg.progressIndex = j;
            leg.blockedTicks = 0; // physical progress = not deadlocked
          }
          break;
        }
      }

      const frontierIndex = leg.nodeIds.length - 1;
      const frontierNode = leg.nodeIds[frontierIndex]!;
      const lag = frontierIndex - leg.progressIndex;
      let changed = false;

      if (frontierNode !== leg.goalNode && lag < this.opts.horizon) {
        const nextNode = moves.get(id);
        if (nextNode !== undefined && nextNode !== frontierNode) {
          // Claim the ENTIRE uncommitted window [current .. candidate] in
          // path order (reservation contract: current cell first). Commit
          // the extension only on a FULL grant — reservations are the
          // source of truth for commanded paths, never advisory.
          const window = leg.nodeIds.slice(leg.progressIndex);
          window.push(nextNode);
          const claimCells = window.map((n) => cellKey(this.map.node(n).pos));
          const granted = this.reservations.claim(id, claimCells);
          if (granted.length === new Set(claimCells).size) {
            leg.nodeIds.push(nextNode);
            leg.blockedTicks = 0;
            changed = true;
          } else {
            leg.blockedTicks++;
            const deniedCell = claimCells[granted.length] ?? claimCells[0]!;
            this.alarms.push(
              `t=${this.tickCount} contention: robot ${id} blocked at ${deniedCell} ` +
                `(owner=${String(this.reservations.owner(deniedCell))}, blockedTicks=${leg.blockedTicks})`
            );
            if (leg.blockedTicks >= this.opts.blockedTicksLimit) {
              this.alarms.push(
                `t=${this.tickCount} robot ${id} blocked ${leg.blockedTicks} ticks at ${deniedCell} — requeueing order ${leg.orderId}`
              );
              void this.adapter.cancelMission(id).catch(() => {
                /* best-effort */
              });
              try {
                this.book.requeue(leg.orderId, "sustained reservation contention");
              } catch {
                /* already terminal */
              }
              this.reservations.releaseAll(id);
              setLeg(rt, undefined);
              continue;
            }
          }
        }
      }

      if (!leg.sent || changed) {
        const missionId = leg.missionId;
        const nodeIds = [...leg.nodeIds];
        void this.adapter
          .sendMission({ id: missionId, robotId: id, nodeIds }, this.map)
          .catch((err) => {
            this.alarms.push(`t=${this.tickCount} sendMission failed for ${id}: ${String(err)}`);
          });
        leg.sent = true;
      }
    }
  }
```

Note the grant check compares against `new Set(claimCells).size` because `claim()` dedupes path revisits — a full grant of a revisiting window is shorter than the raw window array.

Single-node legs (`nodeIds === [current]`, pick == current cell): frontier equals goal, no extension, `!leg.sent` still sends the 1-node mission once — preserved from the old code.

3e. Update the class-level JSDoc (orchestrator.ts:109-124) and the `runRouting` JSDoc (the "LOCKSTEP PRECONDITION" block, ~648-655): the collision invariant no longer rests on lockstep — committed paths are reservation-backed; PIBT plans over frontiers; document the parked-idle-robot backstop limitation from the Design section.

- [ ] **Step 4: Run orchestrator suite**

Run: `cd packages/orchestrator && corepack pnpm vitest run`
Expected: all 19 tests pass (15 existing + 4 new). If an existing test asserts the OLD per-tick extension cadence (e.g. expected mission lengths per tick), inspect whether the assertion encodes the defect; fix the assertion ONLY if it demonstrably tests flood behavior, and say so in the commit body.

- [ ] **Step 5: Run robot-interface + shared + core suites (cross-package safety)**

Run: `corepack pnpm -r --filter '!@tez/sim' test`
Expected: green (sim deferred to Task 3 — its soak takes ~6 min and its thresholds change next task).

- [ ] **Step 6: Typecheck and commit**

Run: `corepack pnpm -r exec tsc --noEmit`
Expected: clean.

```bash
git add packages/orchestrator/src/orchestrator.ts packages/orchestrator/test/orchestrator.test.ts
git commit -m "fix(orchestrator): horizon-gated frontier planning with blocking reservations and deadlock backstop"
```

---

### Task 3: Restore e2e regression gates + latency proof

**Files:**
- Modify: `packages/sim/test/e2e.test.ts` (restore sustained-collision gate ~line 319-345, raise completion threshold, update stale doc comments at lines 27-52; add a 1-robot latency test)

**Interfaces:**
- Consumes: fixed orchestrator from Task 2, existing e2e harness (`startDevBroker`, `Vda5050Adapter`, `spawnFleet`, `maps/demo-grid.json`), existing collision-tracking helpers in the file.
- Produces: re-enabled hard gates that future regressions trip.

- [ ] **Step 1: Restore the sustained-collision gate**

In `packages/sim/test/e2e.test.ts` (~line 319), replace the `console.warn` escape-valve block (and its long "known, pre-existing gap" comment) with the hard assertion the comment itself prescribes:

```typescript
        expect(collisions.sustained).toEqual([]);
```

Keep the transient-overlap handling exactly as is (only the SUSTAINED gate was disabled).

- [ ] **Step 2: Raise the completion threshold**

Find the completion-rate assertion below the gate (currently the honest-90% threshold; read the surrounding comment). Set the minimum to 95% and trim the comment to reflect that the extension-flood mechanism it documents is fixed (reference commit from Task 2). Also rewrite the stale paragraph in `seededOrderSpecs`'s doc comment (lines 27-52) that documents the per-tick flood as current behavior — keep the bounded-radius rationale, drop the "not fixable from within packages/sim" claim.

- [ ] **Step 3: Add the 1-robot 9-cell latency test**

Append (reuse the file's existing broker/adapter/fleet setup helpers and constants; model after the smallest existing e2e test in the file):

```typescript
  it("a single robot completes a 9-cell leg at seconds-per-cell pace (no extension flood)", async () => {
    // Pre-fix baseline: >180s for 9 cells (~20s/cell). Post-fix budget is
    // deliberately generous — 45s wall — while still impossible under the
    // flood regime.
    // Setup mirroring the file's existing single-fleet pattern:
    //   - fresh dev broker + Vda5050Adapter + spawnFleet with ONE robot
    //   - one order whose pickup is 9 grid cells from the robot's start,
    //     drop adjacent to pickup (keeps the measured section = the 9-cell leg)
    //   - orchestrator with default tickMs
    // Poll snapshot() until the order status is "completed", 45s timeout.
  }, 60_000);
```

This step intentionally gives structure rather than verbatim code: the file's helper signatures (fleet spawn options, map node naming) must be read and reused; copy the polling/teardown idiom of the neighboring tests, including broker/adapter cleanup in `finally`.

- [ ] **Step 4: Run the sim suite (long)**

Run: `cd packages/sim && corepack pnpm vitest run` (~6-7 min; `.npmrc` serialization applies)
Expected: all sim tests green, including the restored gate, the ≥95% completion assertion, and the new latency test.

If the soak still shows sustained collisions or <95% completion: STOP, do not weaken thresholds — capture the failing seed/log and report back for re-investigation (that is a Task 2 defect, not a threshold problem).

- [ ] **Step 5: Full workspace verification**

Run: `corepack pnpm -r test && corepack pnpm -r exec tsc --noEmit`
Expected: every package green, typecheck clean.

- [ ] **Step 6: Update BACKLOG and commit**

In `docs/BACKLOG.md`: mark the P0 extension-flood and P1 oscillation entries fixed (reference commits); add the new known limitation from Task 2 ("parked idle robot on the only path drives orders into backstop-requeue; needs parking/yield dispatch — P2").

```bash
git add packages/sim/test/e2e.test.ts docs/BACKLOG.md
git commit -m "test(sim): restore sustained-collision gate, 95% completion floor, 9-cell latency proof"
```

---

## Self-Review Notes

- Spec coverage: P0 fix direction (horizon gating, blocking claims, requeue on contention, strict-prefix preservation, alarm fix) → Task 2. P1 (deterministic livelock fix + both repro variants as committed tests + 89 tests kept) → Task 1. Acceptance criteria (collision gate restored, threshold toward 95-100%, 9-cell latency, full suites) → Task 3.
- The P1 mechanism was empirically validated in this worktree before planning (patch applied, both repros pass, 91/91 core tests, patch reverted).
- Type consistency: `progressIndex`/`blockedTicks` defined in Task 2 step 3b and used only within Task 2; `blockedTicksLimit` defined in opts and consumed in `runRouting`; no cross-task type references beyond the unchanged public APIs.
- Deliberate non-goals: no multi-node-per-tick lookahead (PIBT stays single-step), no parking dispatch for idle blockers (BACKLOG), no changes to Vda5050Adapter.
