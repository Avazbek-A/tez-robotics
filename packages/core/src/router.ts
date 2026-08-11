// PIBT (Priority Inheritance with Backtracking) multi-robot router.
//
// Algorithm: Okumura, Machida, Défago & Tamura, "Priority Inheritance with
// Backtracking for Iterative Multi-agent Path Finding", IJCAI 2019 / AIJ 2022.
// The processing structure here (priority-descending outer loop, recursive
// priority-inheritance search over distance-greedy candidates, tentative
// next-cell reservation before recursing so closed push-cycles/rotations
// resolve in one step) is a TypeScript port of the approach used by
// Kei18/pypibt (MIT License, https://github.com/Kei18/pypibt) —
// reimplemented from the published algorithm description, not copied from
// the Python source.

import type { RobotId } from "@tez/shared";
import type { WarehouseMap } from "./map.js";

export interface Agent {
  id: RobotId;
  at: string;
  goal: string;
  /**
   * Seed/base priority hint. Used as the agent's base priority the first
   * time its id is seen by a router instance (higher wins ties on a
   * contested cell). If omitted/non-finite, or if it ties with another
   * agent's base, ties fall back to insertion order and then to a
   * lexicographic id comparison, keeping a strict deterministic order.
   * After the first sighting, priority is managed internally by the
   * router (incremented each step the agent is off-goal, reset to its
   * base on reaching goal) — this field is not re-read on later steps.
   */
  priority: number;
}

interface PriorityState {
  /** Seeded from Agent.priority on first sight (or insertion order if
   *  absent/non-finite). The value priority resets to whenever the agent
   *  is at its goal. */
  base: number;
  current: number;
  /** First-seen sequence number; deterministic tie-break when base/current
   *  are equal (e.g. every caller passes the same default priority). */
  insertionOrder: number;
}

export class PibtRouter {
  private readonly map: WarehouseMap;

  // Priority state persists across step() calls, keyed by agent id, because
  // the caller may rebuild the Agent[] array from scratch every timestep.
  private readonly priorities = new Map<RobotId, PriorityState>();

  constructor(map: WarehouseMap) {
    this.map = map;
  }

  /**
   * One timestep for all agents. Returns the node each agent occupies next.
   * Guarantees: no vertex conflicts, no edge swaps. Agents at goal may stay.
   */
  step(agents: Agent[]): Map<RobotId, string> {
    const byId = new Map<RobotId, Agent>();
    for (const agent of agents) byId.set(agent.id, agent);

    this.updatePriorities(agents);

    const order = [...agents].sort((a, b) => this.comparePriority(a.id, b.id));

    // Current occupancy, fixed for the duration of this step.
    const occupied = new Map<string, RobotId>();
    for (const agent of agents) occupied.set(agent.at, agent.id);

    const nextClaimed = new Map<string, RobotId>(); // nodeId -> agent claiming it next
    const nextOf = new Map<RobotId, string>(); // agentId -> its (possibly tentative) next node
    const assigned = new Set<RobotId>(); // agent has a final decided move
    const inProgress = new Set<RobotId>(); // agent is being decided further up the call stack

    const pibt = (agentId: RobotId): boolean => {
      if (assigned.has(agentId)) return true;
      if (inProgress.has(agentId)) {
        // We looped back onto an ancestor still being decided further up
        // this call stack — i.e. the push chain closes a cycle/rotation.
        // That ancestor already reserved a tentative next cell for itself
        // (we always set nextOf before recursing further, below), and the
        // caller already verified that reservation isn't a 2-agent edge
        // swap with us before invoking this call. So the ancestor is
        // vacating its current cell; let the rotation close successfully
        // instead of failing, which is what lets an n-agent rotation
        // resolve in a single step.
        return true;
      }
      inProgress.add(agentId);

      const agent = byId.get(agentId);
      if (!agent) {
        inProgress.delete(agentId);
        return false;
      }

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

      for (const candidate of candidates) {
        const claimant = nextClaimed.get(candidate);
        if (claimant !== undefined && claimant !== agentId) continue;

        const occupant = occupied.get(candidate);
        if (occupant !== undefined && occupant !== agentId) {
          // occupant's tentative/final next cell, if it has committed to one
          // yet (set eagerly below, before recursing, so this also catches
          // occupants that are mid-recursion ancestors).
          const occupantNext = nextOf.get(occupant);
          if (occupantNext === agent.at) continue; // would be an edge swap
        }

        // Reserve the candidate tentatively BEFORE recursing into its
        // occupant. This is what lets a push chain that loops back onto an
        // ancestor see that ancestor already committed to vacate, instead
        // of only discovering that after the whole chain unwinds.
        nextClaimed.set(candidate, agentId);
        nextOf.set(agentId, candidate);

        let ok = true;
        if (occupant !== undefined && occupant !== agentId && !assigned.has(occupant)) {
          ok = pibt(occupant);
        }

        if (ok) {
          assigned.add(agentId);
          inProgress.delete(agentId);
          return true;
        }

        // Backtrack: undo the tentative reservation and try the next
        // candidate. This keeps the invariant that a failed pibt() call
        // leaves nextClaimed/nextOf exactly as it found them.
        nextClaimed.delete(candidate);
        nextOf.delete(agentId);
      }

      inProgress.delete(agentId);
      return false;
    };

    for (const agent of order) {
      if (!assigned.has(agent.id)) pibt(agent.id);
    }

    return nextOf;
  }

  private updatePriorities(agents: Agent[]): void {
    for (const agent of agents) {
      let state = this.priorities.get(agent.id);
      if (!state) {
        const insertionOrder = this.priorities.size;
        const base = Number.isFinite(agent.priority) ? agent.priority : insertionOrder;
        state = { base, current: base, insertionOrder };
        this.priorities.set(agent.id, state);
      }
      if (agent.at === agent.goal) {
        state.current = state.base;
      } else {
        state.current += 1;
      }
    }
  }

  private comparePriority(a: RobotId, b: RobotId): number {
    const pa = this.priorities.get(a)!;
    const pb = this.priorities.get(b)!;
    if (pa.current !== pb.current) return pb.current - pa.current;
    if (pa.insertionOrder !== pb.insertionOrder) return pa.insertionOrder - pb.insertionOrder;
    return a < b ? -1 : a > b ? 1 : 0;
  }
}
