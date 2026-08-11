# Pre-Pilot Hardening — Design Spec

Approved by Avazbek 2026-08-11 (session dialogue). Scope: BACKLOG items #13, #14, #15, plus hygiene (#4, #5, #8, alarm cap) and test/doc closeout (#7, #9 verification, C1 test re-pin). Deferred by explicit decision: #2 build pipeline (until Plan 2 dashboard merges — avoid wiring dist twice), #10-12, #6 (keep as-is).

## Goals

1. Soak reaches 20/20 sustainably: parked idle robots yield instead of permanently blocking the only path (#13).
2. Physical-drift and stall failure modes are detected and recovered, not silently trusted (#14, #15).
3. Unbounded growth removed (alarms array, router priorities map, Vda5050Adapter tracking maps) (#8, alarm cap).
4. Docs/tests tell the truth (adapter contract #4, MAP_ID dedup #5, stale BACKLOG entries #7/#9 closed with evidence, diluted C1 test re-pinned).

Constraint throughout: NO public orchestrator API changes (Plan 2 dashboard session consumes submitOrder/snapshot/getAlarms/start/stop/tickOnce in parallel). New behavior via new optional `OrchestratorOpts` fields only.

## 1. Yield-leg dispatch (#13)

**Problem:** a parked IDLE robot owns its cell (by design, collision invariant) but is never commanded to move; PIBT pushes it only virtually. An order whose only path crosses that cell burns blockedTicks → backstop requeue ×3 → failed.

**Design:** new leg kind. `RobotLeg` gains `kind: "order" | "yield"` (existing creation sites set `"order"`).

- **Trigger:** in `runRouting()`'s two blocked branches, when a blocked ORDER leg's `blockedTicks` reaches `opts.yieldAfterTicks` (new, default 6 — well before the backstop at 20): identify a blocker = an online, un-quarantined, leg-less robot whose owned cell is the first cell adjacent to the blocked robot's frontier in distance-to-goal order (claim-denied case: the denied cell's owner, if it qualifies). No qualifying blocker → no yield; backstop remains the fallback.
- **Yield target:** BFS from the blocker's current node (depth cap 10): first node whose cell is unowned (or blocker-owned), not physically occupied by any robot, and not the blocked robot's needed cell. No target → skip.
- **Yield leg:** `kind:"yield"`, `orderId:""`, `phase:"pick"` (unused), `goalNode:` target, `missionId:` `yield:${blockerId}#${counter}` (monotonic per-orchestrator counter — adapter treats every yield as a fresh mission), `nodeIds:[blocker.currentNodeId]`, `sent:false`, `progressIndex:0`, `blockedTicks:0`. Set via `setLeg`. Routed/extended/claimed by the EXISTING leg machinery unchanged (PIBT gets a real goal; reservations gate extensions normally).
- **Completion:** `handleMissionDone`/`handleMissionFailed` handle yield legs explicitly BEFORE `parseMissionId`/order-book logic: matching missionId → `setLeg(rt, undefined)` (+ alarm on failure path). No order transitions ever touch a yield leg. `requeueBlockedLeg` on a blocked yield leg skips `book.requeue` (no order) but keeps cancel + releaseAll + own-cell re-claim + clear.
- **Anti-thrash:** `rt.lastYieldTick`; a robot is not re-yielded within `opts.yieldCooldownTicks` (default 20). One yield leg per robot at a time (rt.leg set ⇒ runDispatch already treats it busy; dispatch of real orders wins next idle cycle).
- **Safety argument:** yield legs obey the same reservation-gated extension as order legs, so the collision invariant is untouched; worst case a yield fails/expires and the backstop behaves exactly as today (strictly-better property).

## 2. Off-window reconciliation (#14)

After `runRouting()`'s progress scan: if a legged robot's `currentNodeId` appears NOWHERE in `leg.nodeIds.slice(leg.progressIndex)`, the robot is physically off its committed path (avoidance swerve, teleop, bump). Transient-snap tolerance: count consecutive off-window ticks in `leg.offWindowTicks`; at 2 consecutive → recover: alarm `off committed path`, cancel mission, requeue order (yield leg: just clear), releaseAll + own-cell re-claim (this is a post-resolveCurrentNodes path — the runTick ordering invariant comment applies; re-claim may legitimately empty-grant if the robot strayed onto foreign cells, which the existing invariant alarm surfaces).

## 3. Physical-progress watchdog (#15)

`RobotLeg` gains `lastProgressTick: number` (set at creation, updated whenever `progressIndex` advances). In `runRouting()`, any legged robot with `tickCount - leg.lastProgressTick >= opts.watchdogTicks` (new, default 40 = 2× blockedTicksLimit, so the contention backstop wins where both apply) → recover with the same shape as #14 (alarm `no physical progress`, cancel, requeue order / clear yield, releaseAll + re-claim). Covers the fully-extended-frontier stall AND the lag-capped stall the blocked branches can't see.

## 4. Hygiene

- **Alarm cap:** `alarms` becomes a ring buffer, cap 500: private `pushAlarm()` replaces every `this.alarms.push`; on overflow drop oldest and count; `getAlarms()` prepends one synthetic line `(<n> older alarms dropped)` when n > 0. Public signature unchanged (`string[]`).
- **Router priorities prune (#8):** at the end of `PibtRouter.step()`, delete priority entries whose ids are not in this step's agent set. (Re-appearing agents re-seed — acceptable; determinism within a run preserved.)
- **Vda5050Adapter.stop() (#8):** clear per-robot tracking maps (orders/attempt counters/etc. — whatever the implementation holds) so a stopped adapter doesn't pin memory.
- **MAP_ID (#5):** `export const DEFAULT_MAP_ID = "warehouse"` in @tez/shared; vda5050.ts and sim/fleet.ts import it.

## 5. Docs/tests closeout

- **#4 adapter contract:** rewrite the per-tick ordering JSDoc in adapter.ts to state the weak real-adapter guarantee (events may arrive in any cadence relative to ticks; missionDone may precede the orchestrator observing goal arrival) vs FakeAdapter's stronger lockstep guarantee; flag FakeAdapter's new-mission position teleport as fake-only.
- **#7:** verify fixed (denied-cell/owner computed from deduped window since fix-round 1) — mark closed in BACKLOG with commit ref.
- **#9:** verify no consecutive-duplicate (self-edge) nodes can be emitted post-rewrite (extension requires `nextNode !== frontierNode`; resume seeds single node); add a wire-level assertion or targeted test if cheap; close in BACKLOG with evidence.
- **C1 re-pin:** restore the "r1 not permanently excluded from dispatch" guarantee with a deterministic scenario (r2 held busy so r1 MUST take the follow-up order).
- **BACKLOG update:** #13/#14/#15/#5/#7/#8/#9 closed with commit refs; #2 note "deferred until Plan 2 merge".

## Acceptance

- Soak 20/20 with ZERO backstop-requeue alarms attributable to parked idle robots (yield alarms may appear); sustained collisions [] unchanged; failure-injection ≥ 90% unchanged; latency test unchanged.
- New unit tests: yield (parked robot vacates, order completes), off-window recovery, watchdog recovery, alarm cap, priorities prune, C1 re-pin.
- Full workspace suites green, tsc clean, no public API change (Plan 2 compatibility).

## Non-goals

Battery/charging orchestration, RobotId type unification, KPI extensions, build pipeline, multi-robot yield chains (yield one blocker at a time; chained blockage falls back to backstop).
