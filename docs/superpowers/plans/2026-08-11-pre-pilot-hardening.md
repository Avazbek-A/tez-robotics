# Pre-Pilot Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the pre-hardware-pilot BACKLOG: yield dispatch for parked blockers (#13), off-path reconciliation (#14), physical-progress watchdog (#15), unbounded-growth hygiene (#8 + alarm cap), MAP_ID dedup (#5), adapter contract doc (#4), stale-entry closeout (#7/#9), C1 test re-pin.

**Architecture:** All behavior lands inside the existing leg/reservation machinery — a yield is just a leg with `kind:"yield"` and no order; reconciliation and watchdog are new recovery triggers reusing the `requeueBlockedLeg` recovery shape. Spec: `docs/superpowers/specs/2026-08-11-pre-pilot-hardening-design.md` (committed, approved).

**Tech Stack:** TypeScript ESM, vitest, `corepack pnpm` workspaces.

## Global Constraints

- Worktree root: `/Users/avazbek/Desktop/Repository/tez-robotics/.worktrees/harden-pre-pilot` — run everything from here.
- pnpm ONLY via `corepack pnpm`; `.npmrc workspace-concurrency=1` stays.
- **NO public orchestrator API changes** (parallel Plan 2 session consumes `submitOrder/snapshot/getAlarms/start/stop/tickOnce`). New opts fields optional-only. `getAlarms(): string[]` signature unchanged.
- Reservation contract: claim set in path order, current cell FIRST; empty grant = strict no-op; non-empty grant releases non-granted prior holds.
- runTick ordering invariant (documented on runTick): release paths running AFTER `resolveCurrentNodes` must re-claim the robot's own current cell themselves.
- `setLeg()` is the ONLY leg assignment path. Mission extensions stay STRICT PREFIX.
- Determinism: no `Math.random()`, no wall-clock in logic.
- `corepack pnpm -r exec tsc --noEmit` clean before every commit.
- Baseline test counts: shared 1, core 91, robot-interface 26+1skip, orchestrator 24, sim 19. Existing tests may be MODIFIED only where an assertion demonstrably encodes behavior this plan changes (justify in commit body).
- Do NOT run the full sim suite per-task (it belongs to Task 5); per-task verification = own package suite + `corepack pnpm -r --filter '!@tez/sim' test`.
- Conventional commits. Do NOT push (owner's call).

---

### Task 1: Yield-leg dispatch (#13)

**Files:**
- Modify: `packages/orchestrator/src/orchestrator.ts` (`OrchestratorOpts`, `RobotLeg`, `RobotRuntime`, `runRouting`, `handleMissionDone`, `handleMissionFailed`, `requeueBlockedLeg`, class JSDoc "Known accepted limitation" block)
- Test: `packages/orchestrator/test/orchestrator.test.ts`

**Interfaces:**
- Consumes: existing leg machinery (see orchestrator.ts:839-1003), `setLeg`, `ReservationTable.owner`, `WarehouseMap.neighbors/node/distance`, FakeAdapter + `tickOnce` test idiom, `_reservationOwner` test hook.
- Produces: `RobotLeg.kind: "order" | "yield"`; `OrchestratorOpts.yieldAfterTicks?` (default 6), `yieldCooldownTicks?` (default 20); `RobotRuntime.lastYieldTick?: number`; private `tryDispatchYield(...)` and yield-aware `requeueBlockedLeg`. Task 2/3 rely on `kind` existing on every leg.

- [ ] **Step 1: Write failing tests**

Append to `packages/orchestrator/test/orchestrator.test.ts` (reuse the file's `grid`, `spyMissions`, `injectEvent` helpers where they exist):

```typescript
describe("yield dispatch (#13)", () => {
  it("a parked idle robot yields out of the only corridor and the order completes", () => {
    // 3x1 corridor: r1 at n0_0 must reach n2_0; r2 idle parked at n1_0.
    // 3x1 has NO side-step cell, so use 3x2: r2 can yield to n1_1.
    const map = WarehouseMap.fromJSON(WarehouseMap.grid(3, 2));
    const adapter = new FakeAdapter(
      [
        { id: "r1" as RobotId, startNodeId: "n0_0" },
        { id: "r2" as RobotId, startNodeId: "n1_0" },
      ],
      map
    );
    const orch = new Orchestrator(map, adapter, {
      horizon: 3,
      yieldAfterTicks: 3,
      blockedTicksLimit: 30, // backstop far away: yield must be what resolves this
    });
    adapter.tick();
    orch.tickOnce();
    // r2 must NOT take the order: exclude via offline? No — offline robots
    // can't execute yield missions either. Instead give r2 a bad battery/
    // status? Simplest deterministic exclusion: submit the order when r1 is
    // nearer the pickup (dispatch is distance-based Hungarian): pickup n2_0
    // is distance 1 from r2 — r2 WOULD win. So park r2 by marking it
    // CHARGING via its state? FakeAdapter has no hook. Pragmatic approach:
    // 2 orders — r2 gets one that starts and ends at its own cell region?
    // Cleanest deterministic setup: make r2's cell the pickup itself is
    // wrong too. USE THIS: submit order pickup n0_0 (r1's cell) drop n2_0.
    // Hungarian assigns r1 (distance 0). r1's pick leg completes instantly
    // (already there), then the DROP leg n0_0->n2_0 must cross r2 at n1_0.
    const order = orch.submitOrder("n0_0", "n2_0");
    let completed = false;
    for (let i = 0; i < 120 && !completed; i++) {
      adapter.tick();
      orch.tickOnce();
      completed =
        orch.snapshot().orders.find((o) => o.id === order.id)?.status === "completed";
    }
    expect(completed).toBe(true);
    const alarms = orch.getAlarms();
    expect(alarms.some((a) => a.includes("yield"))).toBe(true);
    // The yield must have resolved it BEFORE any backstop requeue:
    expect(alarms.some((a) => a.includes("requeueing order"))).toBe(false);
    // r2 ended up somewhere, still owns its own cell (invariant):
    const r2 = adapter.robots().find((r) => r.id === "r2")!;
    const r2cell = `${r2.pos.x},${r2.pos.y}`;
    expect(orch._reservationOwner(r2cell as CellKey)).toBe("r2");
  });

  it("yield legs never touch the order book and clear on completion", () => {
    // Same setup; assert after completion: r2 has no active order ever
    // (book.byRobot stays undefined for r2 throughout), r2's leg is
    // cleared at the end (r2 becomes dispatchable again: submit a second
    // order at r2's side and see r2 take it).
    // ... same corridor setup as above ...
    // after first order completes:
    //   const order2 = orch.submitOrder(<node near r2>, <other node>);
    //   drive ticks; expect order2 completed and its robotId === "r2".
  });

  it("no qualifying blocker means no yield and the backstop still fires", () => {
    // Blocker is OFFLINE (setConnection(false) after registration): yield
    // must NOT be dispatched to an offline robot; order eventually fails
    // via backstop (blockedTicksLimit small, e.g. 5) — the strictly-better
    // property: behavior degrades to pre-yield behavior, never worse.
    // Assert: no "yield" alarm for r2; order status "failed"; alarms
    // include "requeueing order".
  });
});
```

Flesh out the second and third tests fully — the sketch above defines their required assertions; write real code following the first test's shape. If `_reservationOwner` or `CellKey` import is missing in the test file, add imports matching existing usage.

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/orchestrator && corepack pnpm vitest run -t "yield"`
Expected: test 1 fails (order fails via backstop requeues — no yield exists), test 2/3 fail correspondingly.

- [ ] **Step 3: Implement**

3a. `OrchestratorOpts` — add:

```typescript
  /**
   * Blocked-tick count at which a blocked ORDER leg tries to dispatch a
   * yield mission to a parked idle robot standing in its way, well before
   * the deadlock backstop (blockedTicksLimit) gives up on the order.
   * Default 6.
   */
  yieldAfterTicks?: number;
  /**
   * Minimum ticks between two yield dispatches to the SAME robot, so a
   * yielded robot is not ping-ponged. Default 20.
   */
  yieldCooldownTicks?: number;
```

Wire defaults in the constructor (`yieldAfterTicks: opts?.yieldAfterTicks ?? 6`, `yieldCooldownTicks: opts?.yieldCooldownTicks ?? 20`).

3b. `RobotLeg` — add `kind: "order" | "yield";` as the FIRST field. Set `kind: "order"` at the two order-leg creation sites (`runDispatch`, `handleMissionDone` pick→drop) and in the resume branch if it recreates a leg object (it mutates in place — verify; mutation needs no change). `RobotRuntime` — add `lastYieldTick?: number;`. Add a private `yieldCounter = 0;` field on the class.

3c. New private method (place after `requeueBlockedLeg`):

```typescript
  /**
   * #13 yield dispatch: when an ORDER leg has been blocked for
   * yieldAfterTicks, look for a parked idle robot standing on the first
   * cell the blocked robot needs next, and command it out of the way with
   * a yield leg — an ordinary leg (kind "yield") with no order attached,
   * routed and reservation-gated by the same machinery as any other leg.
   * Returns true if a yield was dispatched this tick.
   */
  private tryDispatchYield(blockedId: RobotId, blockedLeg: RobotLeg): boolean {
    // 1. The cell the blocked robot needs: its frontier's neighbors sorted
    //    by distance to the leg goal — first one owned by a QUALIFYING
    //    blocker (online, not quarantined, leg-less, resolved node, not
    //    itself the blocked robot, cooldown expired) wins.
    const frontier = blockedLeg.nodeIds[blockedLeg.nodeIds.length - 1]!;
    const wanted = [...this.map.neighbors(frontier)].sort(
      (a, b) => this.map.distance(a, blockedLeg.goalNode) - this.map.distance(b, blockedLeg.goalNode)
    );
    for (const nodeId of wanted) {
      const cell = cellKey(this.map.node(nodeId).pos);
      const ownerId = this.reservations.owner(cell);
      if (ownerId === undefined || ownerId === blockedId) continue;
      const blocker = this.robots.get(ownerId);
      if (
        !blocker ||
        blocker.leg ||
        blocker.quarantined ||
        !blocker.online ||
        blocker.currentNodeId === undefined ||
        (blocker.lastYieldTick !== undefined &&
          this.tickCount - blocker.lastYieldTick < this.opts.yieldCooldownTicks)
      ) {
        continue;
      }
      const target = this.findYieldTarget(ownerId, blocker.currentNodeId, nodeId);
      if (target === undefined) continue;
      blocker.lastYieldTick = this.tickCount;
      this.yieldCounter++;
      setLeg(blocker, {
        kind: "yield",
        orderId: "",
        phase: "pick",
        goalNode: target,
        missionId: `yield:${ownerId}#${this.yieldCounter}`,
        nodeIds: [blocker.currentNodeId],
        sent: false,
        progressIndex: 0,
        blockedTicks: 0,
      });
      this.pushAlarm(
        `t=${this.tickCount} yield: robot ${ownerId} at ${nodeId} asked to vacate to ${target} (blocking ${blockedId})`
      );
      return true;
    }
    return false;
  }

  /**
   * BFS from the blocker's node (depth cap 10) for the nearest node whose
   * cell is unowned (or the blocker's own), not physically occupied by any
   * robot, and not the cell being vacated. Undefined when nothing suitable
   * is reachable.
   */
  private findYieldTarget(
    blockerId: RobotId,
    from: string,
    vacating: string
  ): string | undefined {
    const occupiedNodes = new Set<string>();
    for (const [, rt] of this.robots) {
      if (rt.currentNodeId !== undefined) occupiedNodes.add(rt.currentNodeId);
    }
    const seen = new Set<string>([from]);
    let frontier = [from];
    for (let depth = 0; depth < 10; depth++) {
      const next: string[] = [];
      for (const nodeId of frontier) {
        for (const nb of this.map.neighbors(nodeId)) {
          if (seen.has(nb)) continue;
          seen.add(nb);
          const cell = cellKey(this.map.node(nb).pos);
          const ownerId = this.reservations.owner(cell);
          if (
            nb !== vacating &&
            nb !== from &&
            !occupiedNodes.has(nb) &&
            (ownerId === undefined || ownerId === blockerId)
          ) {
            return nb;
          }
          next.push(nb);
        }
      }
      frontier = next;
    }
    return undefined;
  }
```

NOTE: this snippet references `this.pushAlarm` which lands in Task 4. Until Task 4 executes, use `this.alarms.push(...)` here — Task 4 sweeps every push site. (If Task 4 already landed because tasks were reordered, use `pushAlarm`.)

3d. Trigger wiring in `runRouting()`: in BOTH blocked branches (claim-denied ~line 904 and no-forward-candidate ~line 927), after incrementing `blockedTicks` and BEFORE the backstop check, add:

```typescript
            if (
              leg.kind === "order" &&
              leg.blockedTicks === this.opts.yieldAfterTicks
            ) {
              this.tryDispatchYield(id, leg);
            }
```

(`===` not `>=`: one yield attempt per blocked episode; blockedTicks keeps counting and the cooldown prevents hammering on later episodes. If the yield robot moves, the blocked robot's next successful extension resets blockedTicks and the episode ends.)

3e. Yield-aware completion. In `handleMissionDone(robotId, missionId)`, add FIRST (before `parseMissionId`):

```typescript
    const rtYield = this.robots.get(robotId);
    if (rtYield?.leg?.kind === "yield") {
      if (rtYield.leg.missionId === missionId) {
        setLeg(rtYield, undefined); // yield done (or harmlessly cut short)
      }
      return; // yield missions never touch the order book
    }
```

Same guard at the top of `handleMissionFailed` (plus an alarm noting the failed yield). The premature-done guard and order transitions below stay untouched for order legs.

3f. `requeueBlockedLeg`: skip `book.requeue` for yield legs (`if (leg.kind === "order") { try { this.book.requeue(...) } catch {} }`); the alarm text for a yield leg should say `abandoning yield` instead of `requeueing order`. Cancel/releaseAll/re-claim/clear stay for both kinds.

3g. `verifyReportingRobot` is only reached for order legs now (yield handled earlier) — confirm no other order-book path can see a yield leg (search `leg.orderId` uses; `book.byRobot` keyed by robot returns real orders only — a yielding robot has no order, fine).

3h. Update the class JSDoc "Known accepted limitation" block (~line 831-837): parked-robot limitation now mitigated by yield dispatch; remaining accepted gap = multi-robot chained blockage (yield targets one blocker; chains fall back to the backstop).

- [ ] **Step 4: Run orchestrator suite**

Run: `cd packages/orchestrator && corepack pnpm vitest run`
Expected: all green (24 existing + 3 new). The existing backstop test used a parked robot — it set `blockedTicksLimit: 3`; with `yieldAfterTicks` default 6 the backstop fires first, so it should still pass unchanged. If it flakes because yield now resolves its scenario, pin its opts with `yieldAfterTicks: 999` and note why in a comment (that test pins the BACKSTOP; disabling yield there is scenario isolation, not weakening).

- [ ] **Step 5: Cross-package + typecheck + commit**

Run: `corepack pnpm -r --filter '!@tez/sim' test && corepack pnpm -r exec tsc --noEmit`

```bash
git add packages/orchestrator/src/orchestrator.ts packages/orchestrator/test/orchestrator.test.ts
git commit -m "feat(orchestrator): yield dispatch commands parked idle robots out of blocked paths"
```

---

### Task 2: Off-window reconciliation (#14) + physical-progress watchdog (#15)

**Files:**
- Modify: `packages/orchestrator/src/orchestrator.ts` (`OrchestratorOpts`, `RobotLeg`, `runRouting`, shared recovery helper)
- Test: `packages/orchestrator/test/orchestrator.test.ts`

**Interfaces:**
- Consumes: `RobotLeg.kind` from Task 1; `requeueBlockedLeg` recovery shape; FakeAdapter `injectEvent`/state-event mechanics from existing tests.
- Produces: `OrchestratorOpts.watchdogTicks?` (default 40); `RobotLeg.offWindowTicks: number` and `lastProgressTick: number`; private `recoverLeg(id, rt, leg, reason)` used by both new triggers (and refactored into `requeueBlockedLeg`'s body if that is clean — implementer's call, no behavior change).

- [ ] **Step 1: Write failing tests**

```typescript
describe("off-window reconciliation (#14)", () => {
  it("a robot reported off its committed path gets its order requeued and cell re-claimed", () => {
    // Drive r1 partway down a leg, then inject two consecutive state
    // events snapping it to a node NOT on its committed window (grid(4,4),
    // teleport to the far corner). Expect: "off committed path" alarm,
    // order requeued (retries incremented, order back to queued or
    // reassigned), robot's holds released, its ACTUAL current cell
    // re-claimed (use _reservationOwner).
  });
  it("a single-tick stale snap does NOT trigger recovery", () => {
    // One off-window state event followed by an on-window one: no alarm,
    // leg intact, order completes normally.
  });
});

describe("physical-progress watchdog (#15)", () => {
  it("a connected robot that stops moving on a fully-extended path is recovered", () => {
    // 1 robot, order with a short leg so frontier reaches goal quickly;
    // stop calling adapter.tick() (robot frozen, still online, state
    // events optional) while ticking the orchestrator watchdogTicks+2
    // times (use small watchdogTicks, e.g. 8, blockedTicksLimit high so
    // the watchdog is what fires). Expect: "no physical progress" alarm,
    // cancelMission called (FakeAdapter mission cleared), order requeued,
    // own-cell re-claimed.
  });
  it("normal slow progress does not trip the watchdog", () => {
    // adapter.tick() every 3rd orchestrator tick, watchdogTicks 8: order
    // completes, no watchdog alarm (each progress event resets the clock).
  });
});
```

Write these fully with the file's established helpers; the sketches define required assertions.

- [ ] **Step 2: Verify failure** — `corepack pnpm vitest run -t "off-window|watchdog"`, all 4 fail.

- [ ] **Step 3: Implement**

3a. Opts: `watchdogTicks?: number` (default 40) with JSDoc: "ticks without physical progress (progressIndex advance) after which a legged robot's mission is presumed stuck and recovered; must exceed blockedTicksLimit so the contention backstop wins where both apply."

3b. `RobotLeg`: add `offWindowTicks: number` and `lastProgressTick: number`. Initialize `offWindowTicks: 0, lastProgressTick: this.tickCount` at ALL leg-creation sites (both order sites, the yield site from Task 1). In the progress scan, when `progressIndex` advances also set `leg.lastProgressTick = this.tickCount` and `leg.offWindowTicks = 0`. The resume branch in `handleMissionDone` (which reseeds `nodeIds = [frontierNode]`) must also refresh `lastProgressTick` and zero `offWindowTicks` (a resume IS progress).

3c. Shared recovery. Generalize `requeueBlockedLeg(id, rt, leg, deniedCell)` → keep its name/signature but route its body through the reason string, or add a sibling; either way the recovery sequence (alarm, cancelMission, conditional requeue for `kind==="order"`, releaseAll, own-cell re-claim, setLeg undefined) must exist exactly ONCE in the file. New triggers in `runRouting()`'s per-robot loop, placed right after the progress scan, before the extension logic:

```typescript
      // #14: robot's reported node is nowhere on its committed window —
      // physical drift (avoidance swerve, teleop, bump). Two consecutive
      // ticks required: a single stale positional snap is routine (see
      // lastVdaNodeId doc) and must not kill a healthy leg.
      const windowNodes = leg.nodeIds.slice(leg.progressIndex);
      if (!windowNodes.includes(rt.currentNodeId)) {
        leg.offWindowTicks++;
        if (leg.offWindowTicks >= 2) {
          this.recoverLeg(id, rt, leg, `off committed path at ${rt.currentNodeId}`);
          continue;
        }
      } else {
        leg.offWindowTicks = 0;
      }

      // #15: no physical progress for watchdogTicks — stuck-but-connected
      // robot (fully-extended frontier, or lag-capped stall) that neither
      // blocked-branch counter can see.
      if (this.tickCount - leg.lastProgressTick >= this.opts.watchdogTicks) {
        this.recoverLeg(id, rt, leg, "no physical progress (watchdog)");
        continue;
      }
```

CAREFUL — interaction check the implementer must verify with a test run, not assume: the resume branch keeps legs alive at the frontier while extension is contention-paused; during that pause `progressIndex` does not advance, so `lastProgressTick` ages. `watchdogTicks` (40) > `blockedTicksLimit` (20) guarantees the contention backstop or a successful extension happens first in every blocked scenario; the watchdog only catches the cases where extension is NOT blocked (frontier==goal, or claims keep succeeding but the robot doesn't move). State this in a comment.

3d. Alarm strings: `t=<n> robot <id> <reason> — recovering (order requeued|yield abandoned)`.

- [ ] **Step 4: Suites** — orchestrator suite green (24+3+4), then `corepack pnpm -r --filter '!@tez/sim' test`, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/orchestrator.ts packages/orchestrator/test/orchestrator.test.ts
git commit -m "feat(orchestrator): off-path reconciliation and physical-progress watchdog"
```

---

### Task 3: Growth hygiene — alarm ring buffer, router prune, adapter stop cleanup, MAP_ID (#8, #5, alarm cap)

**Files:**
- Modify: `packages/orchestrator/src/orchestrator.ts` (alarm buffer), `packages/core/src/router.ts` (prune), `packages/robot-interface/src/vda5050.ts` (stop cleanup + MAP_ID import), `packages/shared/src/index.ts` or types file (DEFAULT_MAP_ID), `packages/sim/src/fleet.ts` (MAP_ID import)
- Test: `packages/orchestrator/test/orchestrator.test.ts`, `packages/core/test/router.test.ts`, `packages/robot-interface/test/vda5050.test.ts`

**Interfaces:**
- Consumes: current `alarms: string[]` + `getAlarms()`; `PibtRouter.priorities` map; Vda5050Adapter internal maps (read the file to enumerate — orders/attempt counters/last-state tracking).
- Produces: `@tez/shared` export `DEFAULT_MAP_ID = "warehouse"`; orchestrator private `pushAlarm(msg: string)` (cap 500, drop-oldest, dropped counter); `getAlarms()` returns `[...(dropped>0 ? [note] : []), ...alarms]` — still `string[]`, public shape unchanged.

- [ ] **Step 1: Failing tests**

```typescript
// orchestrator.test.ts
it("alarm log is capped and reports how many were dropped", () => {
  // Reach 500+ alarms cheaply: construct orchestrator, call a scenario that
  // alarms every tick (e.g. permanent contention with yieldAfterTicks 999,
  // blockedTicksLimit 999) OR — far simpler and equally valid — drive the
  // private path via many ticks is slow; instead assert the mechanism:
  // push 600 alarms through the real path by running ~300 blocked ticks
  // (2 alarms/tick). Assert getAlarms().length <= 501 and first line
  // matches /^\(\d+ older alarms dropped\)$/.
});

// router.test.ts
it("priority state for vanished agents is pruned", () => {
  // step() with agents [a,b,c]; then step() with [a,b] repeatedly; expose
  // via a new test-only accessor _prioritySize() (add it — mirrors the
  // orchestrator's _reservationOwner precedent) and assert it equals the
  // live agent count after each step.
});

// vda5050.test.ts
it("stop() clears per-robot tracking state", () => {
  // start, run a mission to accumulate state, stop(); assert the internal
  // maps are empty via a test-only accessor _trackingSizes() returning
  // counts, all 0 after stop().
});
```

- [ ] **Step 2: Verify failures** (the two accessors won't exist → compile fail counts as RED for those; the alarm test fails on unbounded growth).

- [ ] **Step 3: Implement**

3a. Orchestrator: `private droppedAlarms = 0; private static readonly ALARM_CAP = 500;` and

```typescript
  private pushAlarm(msg: string): void {
    this.alarms.push(msg);
    if (this.alarms.length > Orchestrator.ALARM_CAP) {
      this.alarms.splice(0, this.alarms.length - Orchestrator.ALARM_CAP);
      this.droppedAlarms += /* number removed */;
    }
  }
```

(Compute the removed count before splicing.) Replace EVERY `this.alarms.push(` call site with `this.pushAlarm(` (grep — there are ~15). `getAlarms()`:

```typescript
  getAlarms(): string[] {
    const head = this.droppedAlarms > 0 ? [`(${this.droppedAlarms} older alarms dropped)`] : [];
    return [...head, ...this.alarms];
  }
```

3b. Router: at the end of `step()`, prune:

```typescript
    if (this.priorities.size > byId.size) {
      for (const id of this.priorities.keys()) {
        if (!byId.has(id)) this.priorities.delete(id);
      }
    }
```

Plus `_prioritySize(): number { return this.priorities.size; }` test hook with a JSDoc marking it test-only (match `_snapshot` precedent in reservations.ts).

3c. Vda5050Adapter: read the class's fields; in `stop()`, after the existing teardown, `.clear()` every per-robot Map/Set (orders, attempt counters, any last-node/last-state tracking). Add `_trackingSizes(): Record<string, number>` test hook. Do NOT clear during normal operation.

3d. Shared: `export const DEFAULT_MAP_ID = "warehouse";` in the package's main export module. Replace the literal in `vda5050.ts` (~line 106) and `sim/src/fleet.ts` (~line 16) with the import. Grep for other `"warehouse"` literals; replace where they mean the map id.

- [ ] **Step 4: Suites** — affected package suites + `corepack pnpm -r --filter '!@tez/sim' test`, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator packages/core packages/robot-interface packages/shared packages/sim/src/fleet.ts
git commit -m "fix: cap alarm log, prune router priorities, clear adapter state on stop, share DEFAULT_MAP_ID"
```

---

### Task 4: Docs + closeout — adapter contract (#4), stale entries (#7, #9), C1 re-pin

**Files:**
- Modify: `packages/robot-interface/src/adapter.ts` (contract JSDoc), `packages/orchestrator/test/orchestrator.test.ts` (C1 re-pin), `docs/BACKLOG.md`
- Possibly add: one targeted test for #9 (see below)

**Interfaces:**
- Consumes: everything landed in Tasks 1-3.
- Produces: truthful docs; #7/#9 closed with evidence; C1 guard restored.

- [ ] **Step 1: #9 verification.** Verify no self-edge `[A,A]` (consecutive duplicate nodes) can be emitted post-P0-rewrite: extension appends only when `nextNode !== frontierNode` (orchestrator.ts:883); initial legs are single-node; resume reseeds single-node. Add a cheap permanent guard to the existing adjacency e2e/unit test or as a unit test: for every spied `sendMission`, assert `nodeIds[i] !== nodeIds[i+1]` for all i. Run it. If it passes, close #9; if it fails, STOP and report (that's a real bug, not a doc task).

- [ ] **Step 2: C1 re-pin.** In the C1 stale-report test, restore the "r1 not permanently excluded" guarantee deterministically: after the existing assertions, submit a follow-up order while r2 is still mid-mission on its current order (so Hungarian can only pick r1) and assert the new order's `robotId === "r1"` and completes. If the existing test's timeline makes this awkward, add it as a separate `it()` reusing the setup.

- [ ] **Step 3: Adapter contract rewrite (#4).** In `adapter.ts` (~lines 28-34), rewrite the `on()` contract JSDoc: real adapters guarantee only per-robot event ORDER (a robot's missionProgress precedes its missionDone for the same mission) — NOT tick alignment; missionDone may arrive before the orchestrator has observed goal arrival via state (the premature-done guard + resume path in Orchestrator compensate). Document FakeAdapter's stronger lockstep guarantee and its new-mission position teleport as FAKE-ONLY test affordances (cross-reference fake.ts). Update fake.ts's own JSDoc to match.

- [ ] **Step 4: BACKLOG.md.** Close #5, #7 (fixed in `a808916`, denied-cell from deduped window), #8, #9 (evidence from step 1), #13, #14, #15 with commit refs; note on #2: "deferred until Plan 2 dashboard merge (decision 11 Aug) — wire dist for all packages incl. @tez/api/@tez/dashboard at once".

- [ ] **Step 5: Suites + commit**

Run: `corepack pnpm -r --filter '!@tez/sim' test && corepack pnpm -r exec tsc --noEmit`

```bash
git add packages/robot-interface/src/adapter.ts packages/robot-interface/src/fake.ts packages/orchestrator/test docs/BACKLOG.md
git commit -m "docs: truthful adapter contract; close stale BACKLOG entries; re-pin C1 dispatch guard"
```

---

### Task 5: Full-suite acceptance + soak gate tightening

**Files:**
- Modify: `packages/sim/test/e2e.test.ts` (only if step 2 says so), `docs/BACKLOG.md` (soak note)

- [ ] **Step 1: Full workspace run.** `corepack pnpm -r test` (sim soak included, ~2-8 min). Expected: all green.

- [ ] **Step 2: Soak inspection.** Read the soak stdout: completion should be 20/20 with ZERO `requeueing order` backstop alarms from parked robots (yield alarms are fine and expected). If 20/20 holds across 2 consecutive runs, raise the soak completion gate from 0.95 to 1.0 ONLY if both runs are 20/20 AND deterministic (same completion both runs); otherwise leave 0.95 and record observed numbers in the BACKLOG soak note. Never lower anything.

- [ ] **Step 3: tsc + commit**

```bash
git add packages/sim/test/e2e.test.ts docs/BACKLOG.md
git commit -m "test(sim): acceptance run for hardening wave; tighten soak gate per observed determinism"
```

(If nothing changed in step 2, commit only the BACKLOG note.)

---

## Self-Review Notes

- Spec coverage: #13→Task 1, #14/#15→Task 2, #8/#5/alarm cap→Task 3, #4/#7/#9/C1→Task 4, acceptance→Task 5. Deferred set (#2, #10-12, #6) documented in spec + BACKLOG note.
- Type consistency: `kind` defined Task 1, consumed Tasks 2/4; `offWindowTicks/lastProgressTick` defined Task 2 and initialized at Task 1's yield site — Task 2 explicitly lists "ALL leg-creation sites (both order sites, the yield site from Task 1)". `pushAlarm` defined Task 3 but referenced by Task 1's snippet — Task 1 carries an explicit note to use `alarms.push` until Task 3 sweeps.
- Known judgment points delegated with guardrails: recovery-helper refactor shape (Task 2 3c), Vda5050Adapter field enumeration (Task 3 3c), C1 timeline (Task 4 step 2), soak gate tightening criteria (Task 5 step 2).
