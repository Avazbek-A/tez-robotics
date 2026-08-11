# Cleanup Wave Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear the broken/destabilizing backlog before feature work: orchestrator hooks (cancelOrder, snapshot retention, #10 smalls), API wiring (DELETE route, demo ids, BROKER_URL), aedes ESM fix, build pipeline, hygiene closeout.

**Architecture:** Per spec `docs/superpowers/specs/2026-08-11-cleanup-wave-design.md` (committed; decisions 1-8 are binding — do not re-litigate them).

**Tech Stack:** TypeScript ESM, vitest, tsup (new devDep, Task 4 only), `corepack pnpm`.

## Global Constraints

- Worktree root: `/Users/avazbek/Desktop/Repository/tez-robotics/.worktrees/cleanup-wave`. pnpm ONLY via `corepack pnpm`. `.npmrc workspace-concurrency=1` stays.
- TDD where a task changes behavior: failing test first, RED evidence, then GREEN.
- Dashboard compatibility: `snapshot()` return SHAPE unchanged (orders array just bounded); `getAlarms()` untouched; no changes under packages/dashboard.
- Orchestrator invariants: setLeg() only leg path; release paths after resolveCurrentNodes re-claim own cell; strict-prefix missions; determinism, no Math.random.
- `corepack pnpm -r exec tsc --noEmit` clean before every commit. Per-task verification: affected package suites + `corepack pnpm -r --filter '!@tez/sim' test`; full sim suite only in Task 5.
- Baseline: shared 1, core 92, robot-interface 27+1skip, orchestrator 48, persistence 9, dashboard 42, api 31, sim 19.
- Conventional commits. Do NOT push.

---

### Task 1: Orchestrator hooks — cancelOrder, snapshot retention, #10 smalls

**Files:** Modify `packages/orchestrator/src/orchestrator.ts`; test `packages/orchestrator/test/orchestrator.test.ts`.

**Interfaces produced:** `cancelOrder(orderId: string): TransportOrder` (public; throws Error("order not found: ...") on unknown, Error("order already terminal: ...") on terminal); `OrchestratorOpts.terminalOrderRetention?: number` (default 200); dispatch excludes `!rt.online` robots; quarantined robots keep status "ERROR" through heartbeats.

- [ ] Step 1: Failing tests (spec decisions 1, 2, 5): (a) cancelOrder on queued order → status canceled, order returned; (b) cancelOrder on assigned order mid-leg → robot's mission cancelled (FakeAdapter mission cleared), leg cleared, robot re-enters idle pool next ticks and takes a new order, robot still owns its current cell (_reservationOwner); (c) cancelOrder unknown id throws; on completed order throws; (d) snapshot retention: submit+complete > retention orders (use small terminalOrderRetention like 5) → snapshot().orders contains all non-terminal + exactly 5 newest terminal; (e) offline-within-grace robot NOT dispatched (setConnection false, submit order, healthy robot takes it / or none if alone — assert no assignment to offline robot, no retry burned); (f) quarantined robot's status stays "ERROR" across subsequent state heartbeats until position recovers.
- [ ] Step 2: RED run.
- [ ] Step 3: Implement per spec decisions 1, 2, 5. cancelOrder shape mirrors existing recovery paths (cancelMission best-effort catch, book.transition(id,"canceled",reason), releaseAll + own-cell re-claim, setLeg undefined). Retention pruning happens where completions/failures/cancellations transition orders terminal (single helper; prune allOrders oldest-terminal-first beyond retention).
- [ ] Step 4: Orchestrator suite + cross-package (no sim) + tsc.
- [ ] Step 5: Commit `feat(orchestrator): cancelOrder API, bounded terminal orders in snapshot, dispatch/quarantine fixes`.

### Task 2: API wiring — DELETE route, demo ids, BROKER_URL log

**Files:** Modify `packages/api/src/routes/orders.ts`, `packages/api/src/main.ts`, api demo composition (find the FakeAdapter seed — `system.ts`/`demo-map.ts`); test `packages/api/test/` (follow existing route-test idiom).

**Interfaces consumed:** Task 1's cancelOrder. **Read first:** scripts/demo.mjs (exact BROKER_URL grep pattern it expects), docs/PLAN2-HOOK-REQUESTS.md §1, existing api tests.

- [ ] Step 1: Failing tests: DELETE /orders/:id → 200 + canceled order body; unknown → 404; already-completed → 409. Demo seed ids follow `sim-001..` (assert in whatever test covers the demo composition, or add a small one).
- [ ] Step 2: RED.
- [ ] Step 3: Implement: route calls orchestrator.cancelOrder, maps the two throw messages to 404/409 (match on message prefix; keep 501 gone). main.ts logs `BROKER_URL=<url>` in vda mode exactly matching demo.mjs's discovery pattern. Demo FakeAdapter robots renamed `sim-001..sim-003` (sweep api fixtures/tests referencing r1..r3 in the demo composition; do NOT touch orchestrator tests).
- [ ] Step 4: api suite + dashboard suite (its tests may reference demo fixtures) + cross-package (no sim) + tsc. Manual smoke: `pnpm demo` boots, ids consistent (capture a snapshot/logs excerpt in report).
- [ ] Step 5: Commit `fix(api): wire order cancellation, unify demo robot ids, log broker url`.

### Task 3: aedes ESM fix

**Files:** Modify `packages/robot-interface/src/dev-broker.ts`; test: existing broker tests must stay green; add bare-node repro proof in report (full smoke lands in Task 4).

- [ ] Step 1: Reproduce the failure first (systematic debugging): minimal `node -e "import('...')"` or scratch mjs importing the barrel under plain node from TS source is impossible — instead reproduce per BACKLOG Plan2 #13's description by importing aedes the current way under bare node (`node -e "import('aedes').then(...)"` + named-import failure demo). Record evidence.
- [ ] Step 2: Implement spec decision 3 (lazy import inside startDevBroker; barrel unchanged). Broker tests green (they exercise the real startDevBroker).
- [ ] Step 3: robot-interface suite + cross-package (no sim) + tsc. Commit `fix(robot-interface): lazy aedes import survives bare-node ESM`.

### Task 4: Build pipeline

**Files:** package.json of shared/core/robot-interface/orchestrator/persistence/api/sim (+ root), tsup config per package (or shared base), root README untouched here.

- [ ] Step 1: Read how tests/dev import packages (workspace deps via exports?). Then wire tsup transpile-only per spec decision 6. Dependency-ordered root `build` script.
- [ ] Step 2: Verify: `corepack pnpm build` succeeds; `node packages/sim/dist/cli.js` runs (whatever its CLI smoke is — --help or a 2s sim); a bare-node smoke importing `@tez/robot-interface` dist (incl. startDevBroker path — proves Task 3 under real node); `node packages/api/dist/main.js` boots demo mode and logs startup (kill after). Existing dev flows unaffected: vitest suites still green, `pnpm demo` still works.
- [ ] Step 3: Full cross-package suites (no sim) + tsc. Commit `build: tsup dist pipeline across node packages, runnable bins`.

### Task 5: Acceptance + closeout

**Files:** `docs/BACKLOG.md`, root `README.md`, one comment at orchestrator.ts RobotId cast bridge.

- [ ] Step 1: Full workspace `corepack pnpm -r test` twice (sim soak gate 20/20 must hold) + tsc.
- [ ] Step 2: Verify Plan2 #15 (root vitest workspace fix d6191e0) — confirm dashboard tests run under root runner with correct env; close item with ref.
- [ ] Step 3: README packages/ section; RobotId accepted-comment; BACKLOG: close #2, #10, #11 (cheap parts; note RobotId unification deferred), Plan2 #13/#14/#15/#17/#18 with commit refs.
- [ ] Step 4: Commit `docs: close cleanup-wave backlog items; README packages map`.

## Self-Review Notes

Spec decisions 1-8 map to Tasks 1(1,2,5) / 2(2,4) / 3(3) / 4(6,+3 smoke) / 5(7,8). Deferred set named in spec. cancelOrder produced in Task 1, consumed in Task 2 (explicit dependency). No dashboard files touched anywhere.
