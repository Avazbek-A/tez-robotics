# Backlog — after orchestrator-core (Plan 1)

Triaged by final whole-branch review, 2026-08-11. Plan 1 delivered: headless orchestration core, sim fleet on real VDA 5050/MQTT, PIBT routing + Hungarian dispatch + reservations, order lifecycle, 150+ tests green.

## P0 — prerequisite for any real-hardware pilot

1. **~~Extension-flood / horizon gating / reservation enforcement.~~ FIXED** (commits `9f5d78f`, `30355ee`, `a808916`, `290d976`, `085288d`). `Orchestrator.runRouting()` (packages/orchestrator/src/orchestrator.ts:642-692) used to append one node + re-send a stitching order EVERY tick regardless of robot catch-up. Consequences (measured in sim soak): throughput collapse ~20s/cell on legs >5 cells; sustained same-cell overlaps under wall-clock (45 in one run); occasional permanent reservation deadlock (foreign-owned current cell → empty grant forever). Reservation claims were advisory (didn't block sendMission) — contradicted spec's "router optimism never bypasses reservations". Fixed via horizon-gated frontier extension (only extends when the robot is within `opts.horizon` nodes of its commanded frontier), reservation claims now block extension (full-grant-or-nothing), a deadlock backstop force-requeues genuinely stuck robots (`opts.blockedTicksLimit` consecutive blocked ticks), and a frontier-race resume path (using both `rt.currentNodeId` and `rt.lastVdaNodeId` as signals) so a robot that's genuinely on its committed path resumes instead of being wrongly requeued. The regression gate at packages/sim/test/e2e.test.ts (`expect(collisions.sustained).toEqual([])`) is restored and green: 0 sustained/soft collisions across repeated runs. The 10-robot/20-order soak sits at exactly the 95% completion gate (19/20) — the one non-completing order in every observed run is the parked-idle-robot limitation, see new P2 item below, not a recurrence of the extension flood. A new 1-robot/9-cell latency test (packages/sim/test/e2e.test.ts) proves the fix directly: ~9.0-9.1s wall for a leg that took >180s (~20s/cell) pre-fix.

## P1 — before Plan 2 features build on top

2. **Build pipeline.** No package emits JS; `node packages/sim/dist/cli.js` fails (ERR_MODULE_NOT_FOUND — workspace deps point at TS source). tsc project references or tsup across packages; then `tez-sim` bin works.
3. **~~PIBT boundary-corridor oscillation~~ FIXED** (commit `9f5d78f`) on uncurated layouts (two agents swapping through narrow boundary corridor could oscillate). Fixed by having PIBT prefer unoccupied cells on distance ties, ending the corridor livelock. Verified by the restored soak/latency tests in packages/sim/test/e2e.test.ts (see P0 item 1 above).
4. **Adapter contract doc drift** (packages/robot-interface/src/adapter.ts:29-34): per-tick ordering text only FakeAdapter can honor; orchestrator compensates (premature-done guard). Rewrite contract to state the weaker real guarantee + FakeAdapter's stronger one; flag FakeAdapter's new-mission position teleport as fake-only. Matters before writing adapter #3 (seer-tcp).
5. **MAP_ID "warehouse"** duplicated in vda5050.ts:106 + sim/src/fleet.ts:16 → move to @tez/shared export.

## P2 — hygiene / operational

6. `.npmrc workspace-concurrency=1` — keep (vda-5050-lib stop-race under parallel vitest); CI note: `pnpm -r test` serialized ~8-10 min.
7. Contention alarm prints wrong cell's owner (orchestrator.ts:678 — prints owner(aheadCell)=undefined; actual blocker = foreign-owned current cell).
8. Router `priorities` map never pruned (stale agent ids); `attemptCounters` unbounded growth (documented); `Vda5050Adapter.stop()` doesn't clear tracking maps.
9. Self-edge `[A,A]` wire orders on PIBT stay-moves — VirtualAgvAdapter tolerates, real vendors may reject.
10. Offline-within-grace robot still dispatchable (burns a retry); quarantine ERROR status clobbered by next heartbeat (observability).
11. `RobotId` defined twice (shared plain vs core branded, cast bridge orchestrator.ts:57-59); root README doesn't mention packages/; edge-midpoint snap = early reservation release (subsumed by P0 fix).
12. Battery/charging: sim uses VirtualAgvAdapter defaults; explicit charge-action orchestration unimplemented. Spec KPIs distance/queue-depth not in snapshot().
13. **Parked idle robot on the only path drives orders into backstop-requeue.** A parked IDLE robot sitting on the only path into an order's pickup/drop permanently owns that cell but is never itself commanded to move out of the way — PIBT only ever pushes it virtually (treats it as an obstacle for planning), never dispatches an actual parking/yield move. Such an order blocks every extension attempt until the deadlock backstop (`opts.blockedTicksLimit` consecutive fully-blocked ticks, default 20) requeues it; after 3 requeues `OrderBook` fails it outright rather than ever routing around the parked robot (documented as an accepted limitation in orchestrator.ts:131-138). This is the exact cause of the 10-robot/20-order soak's one non-completing order (19/20 = 95.0%, sitting exactly at the regression gate) — alarm histogram shows 4 `robot <id> blocked 20 ticks at <cell>` entries per soak run. Needs a parking/yield dispatch: command idle robots off contested cells rather than leaving them as permanent planning obstacles.

## Ticket seeds for Plan 2 (from design spec)
- Postgres persistence + REST/WS API (Fastify) + dead-letter table + broker auth/ACL
- PixiJS dashboard (mine rmf-web patterns)
- Plan 3: 1C OData connector (mock + 1C:Fresh live)
