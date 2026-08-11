# Handoff: P0 extension-flood + P1 PIBT oscillation fixes

Written 2026-08-11 at end of the session that built and merged Plan 1 (orchestrator core, main @ 0b2d06e). Self-contained — no prior conversation needed. Companion: `docs/BACKLOG.md` (triaged by final whole-branch review), `docs/specs/2026-08-10-orchestrator-design.md` (spec), `docs/superpowers/plans/2026-08-10-orchestrator-core.md` (how Plan 1 was built).

## Scope of this fix session

Two confirmed correctness gaps, measured and documented, both MUST-FIX before any real-hardware pilot. Work on a fresh branch off `main` (the old orchestrator-core worktree is deleted; history is in git).

### P0 — extension flood / missing horizon gating / advisory reservations

**Root cause:** `Orchestrator.runRouting()` (packages/orchestrator/src/orchestrator.ts:642-692) appends one node to the robot's leg and re-sends a VDA stitching order EVERY tick, regardless of whether the robot has caught up to the previously commanded frontier. Additionally, `ReservationTable.claim()` failure does NOT block `sendMission` (orchestrator.ts:672-689) — reservations are advisory, contradicting the spec's "router optimism never bypasses reservations; deadlock backstop".

**Measured symptoms** (sim soak, packages/sim/test/e2e.test.ts):
- Throughput collapse: ~20s/cell once a leg exceeds ~5-6 cells (isolated 1-robot repro: 9-cell trip >180s). Mechanism documented at e2e.test.ts:27-52.
- Sustained same-cell overlaps under wall-clock: 13-45 per soak run (two robots' released frontiers drift onto the same cell for real time).
- One permanent reservation deadlock observed: robot's own current cell foreign-owned → `claim` returns empty grant forever (`could not claim 2:2` loop), order stuck non-terminal.
- Architecture context in `Orchestrator` class JSDoc (orchestrator.ts:109-124): "LOCKSTEP PRECONDITION" — zero-collision guarantee currently only holds for FakeAdapter lockstep tests, not `start()` wall-clock with real adapters (VDA base nodes are auto-driven by the AGV without waiting for ticks).

**Fix direction (from final review):** gate frontier extension on robot progress (extend only when robot is within k nodes of the commanded frontier — `opts.horizon` exists, currently unused); make claim failure actually block extension; on sustained contention, requeue/replan. **Constraint trap:** mission extensions must remain STRICT PREFIX (adapter throws on non-prefix — see packages/robot-interface/src/adapter.ts JSDoc). Gating pauses extension, never rewrites committed prefix. A genuine reroute requires cancel + fresh mission id (Vda5050Adapter supports this since the per-attempt orderId fix — vda5050.ts tracks `${missionId}#n`).

**Acceptance:** restore the disabled regression gate at packages/sim/test/e2e.test.ts:319 (`expect(collisions.sustained).toEqual([])`); raise soak completion threshold back toward 95-100% (currently honest-90%); isolated 1-robot 9-cell leg completes in reasonable time (~seconds/cell, not 20s); fix the misleading contention alarm (orchestrator.ts:678 prints `owner(aheadCell)`=undefined instead of the actual foreign-owned current cell).

### P1 — PIBT boundary-corridor oscillation

**Repro** (throwaway, not committed): `WarehouseMap.fromJSON(WarehouseMap.grid(5,5))`, agent r2 at n0_2 goal n0_4, agent r3 at n0_3 goal n0_0 (opposite directions through boundary column x=0), loop `router.step()` 20 iterations → same 10-step cycle forever, neither reaches goal. Symmetric off-goal agents: the per-step priority increment never breaks the symmetry.

**File:** packages/core/src/router.ts (PIBT port, Kei18/pypibt attribution — tentative-assignment cycle resolution already implemented and proven; this is a different failure mode: livelock, not deadlock).

**Fix directions (pick via investigation):** cycle detection (position-pattern hash over recent steps → forced priority escalation for one agent); randomized tie-break perturbation (must stay deterministic — seeded); or bounded-window lookahead for swap conflicts. Keep: determinism (seeded), all 9 existing router tests incl. saturation-rotation and churn tests, per-step invariants (no vertex conflict, no edge swap).

**Acceptance:** committed regression test with the exact repro above — both agents reach goals ≤ some bound; plus a second boundary-corridor variant (grid(8,2) opposite ends); full core suite (89) green.

## Environment facts (hard-won, do not rediscover)

- Mac has NO container runtime (no docker/podman/colima; brew install blocked by /usr/local perms). Dev broker = in-repo aedes via `startDevBroker({port:0, wsPort:0})` from @tez/robot-interface. Mosquitto compose = deploy artifact only.
- pnpm only via `corepack pnpm`. `.npmrc` has `workspace-concurrency=1` (required — vda-5050-lib stop-race under parallel vitest). Full `pnpm -r test` ≈ 10 min serialized (sim soak ~6 min).
- tsc --noEmit clean across all packages (keep it that way).
- Tests: shared 1, core 89, robot-interface 26+1skip, orchestrator 15, sim 18.
- OrderBook API: `assign(orderId, robotId)` is the ONLY robotId setter; `byRobot` returns active orders only; requeue clears robotId; 3rd retry → failed.
- Reservation contract: caller includes robot's CURRENT cell as first element of every claim; empty grant = strict no-op.
- Premature-done guard: orchestrator accepts missionDone only when robot's batch-fresh node (inline-updated during event drain, `lastVdaNodeId` leg-scoped via `setLeg()`) equals leg goal.
- License gate: MIT/Apache/BSD/EPL only; NEVER copy RHCR/EECBS/MAPF-LNS/PBS code (research license), GPL tools, unlicensed repos.

## Process

Superpowers flow: systematic-debugging → writing-plans (small plan, ~2-3 tasks) → subagent-driven-development (fresh implementer per task, adversarial reviewer per task, scoped re-reviews, ledger in .superpowers/sdd/). Worktree via `git worktree add .worktrees/<branch> -b <branch>` (.worktrees is gitignored). Conventional commits. Do NOT push without the owner's say-so (repo is public).
