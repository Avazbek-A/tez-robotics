# Handoff: cleanup-wave execution

Written 2026-08-11 (end of hardening session). Self-contained — no prior conversation needed.

## State

- Branch `cleanup-wave` exists in worktree `.worktrees/cleanup-wave` (base main @ c968d20 — post P0/P1 fixes + Plan 2 dashboard + hardening wave, all pushed).
- Spec + plan COMMITTED @ 5591ea4, NOTHING implemented yet:
  - Spec (decisions 1-8, binding): `docs/superpowers/specs/2026-08-11-cleanup-wave-design.md`
  - Plan (5 tasks): `docs/superpowers/plans/2026-08-11-cleanup-wave.md`
- SDD workspace seeded: `.superpowers/sdd/2026-08-11-cleanup-wave/` (ledger `progress.md`, `task-1-brief.md` extracted). Resume = dispatch Task 1 implementer.

## Scope (user-approved: "fix broken/destabilizing before features")

Task 1 orchestrator: `cancelOrder()` public API (per docs/PLAN2-HOOK-REQUESTS.md §1), `snapshot()` terminal-order retention (Plan2 finding #18 — WS frames grow unboundedly, threatens PTA filming), #10 smalls (offline-in-grace dispatch exclusion; quarantine ERROR clobber).
Task 2 api: wire DELETE /orders/:id (kill the 501), unify demo ids to sim-00N, BROKER_URL log line matching scripts/demo.mjs's grep.
Task 3 robot-interface: aedes ESM lazy import (bare-node crash).
Task 4 build pipeline: tsup transpile dist across node packages, runnable `node packages/sim/dist/cli.js` + `node packages/api/dist/main.js`.
Task 5 acceptance: full suite x2 (soak gate 20/20 HARD), verify Plan2 #15 closed (d6191e0), README packages map, BACKLOG closeout.

Deferred (do NOT do): battery #12, alarm i18n, production serving #19, order-lifecycle event hook, RobotId unification, dts emission.

## Process

Superpowers subagent-driven-development: fresh implementer per task + adversarial reviewer per task (they catch real bugs — this session's reviews caught 3 Criticals) + scoped re-reviews, ledger in .superpowers/sdd/, final whole-branch review on strongest model, ONE final fix wave. Model tiers: implementers sonnet (haiku only for pure transcription), task reviewers sonnet/opus by risk, final review top model. Worktree already exists — do not recreate.

## Environment facts (hard-won)

- pnpm ONLY via `corepack pnpm`; `.npmrc workspace-concurrency=1` required (vda-5050-lib race). No docker on this Mac — dev broker = in-repo aedes.
- Full `pnpm -r test` ≈ 2-3 min now (soak fast post-fixes); sim soak gate = 20/20 at 1.0, NEVER lower any threshold — a failed gate is a real regression, capture alarm histogram and stop.
- Baseline tests: shared 1, core 92, robot-interface 27+1skip, orchestrator 48, persistence 9, dashboard 42, api 31, sim 19 (269 total). tsc --noEmit clean everywhere.
- Orchestrator invariants (documented in runTick/class JSDoc): setLeg() only leg path; release paths after resolveCurrentNodes must re-claim robot's own cell; strict-prefix missions; reservation contract current-cell-first, empty grant = no-op; determinism, no Math.random.
- snapshot()/getAlarms() shapes consumed by @tez/dashboard — shape stays, content may be bounded per spec decision 1.
- Known env flake (rare): "Unhandled Rejection: Client is not started" from vda-5050-lib teardown in robot-interface tests — retry once, treat as flake, don't chase.
- Merge: to local main after final review + green merged suite; PUSH only with owner's explicit word (repo public, prior pushes were each explicitly approved).

## After this wave

Feature roadmap per docs/HANDOFF-feature-gap-research.md (RDS gap donors) + strategy in memory (sell turnkey project; 3 validation letters before deep build). Plan 3 = 1C connector.
