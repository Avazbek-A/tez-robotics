// PIBT (Priority Inheritance with Backtracking) multi-robot router.
//
// Algorithm: Okumura, Machida, Défago & Tamura, "Priority Inheritance with
// Backtracking for Iterative Multi-agent Path Finding", IJCAI 2019 / AIJ 2022.
// The processing structure here (priority-descending outer loop, recursive
// priority-inheritance search over distance-greedy candidates, in-progress
// cycle guard) is a TypeScript port of the approach used by Kei18/pypibt
// (MIT License, https://github.com/Kei18/pypibt) — reimplemented from the
// published algorithm description, not copied from the Python source.

import type { RobotId } from "@tez/shared";
import type { WarehouseMap } from "./map.js";

export interface Agent {
  id: RobotId;
  at: string;
  goal: string;
  priority: number;
}

interface PriorityState {
  /** Assigned once, in first-seen order. Used as a deterministic tie-break
   *  and as the value priority resets to whenever the agent is at its goal. */
  base: number;
  current: number;
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
    const nextOf = new Map<RobotId, string>(); // agentId -> its next node
    const assigned = new Set<RobotId>(); // agent has a final decided move
    const inProgress = new Set<RobotId>(); // agent is being decided further up the call stack

    const pibt = (agentId: RobotId): boolean => {
      if (assigned.has(agentId)) return true;
      // Cycle guard: an agent already being decided higher up this call
      // stack cannot be pushed again — treat it as immovable for now. This
      // guarantees termination (recursion depth is bounded by agent count)
      // at the cost of occasionally not resolving a full rotation in a
      // single step; priority inheritance resolves it over later steps.
      if (inProgress.has(agentId)) return false;
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
        return a < b ? -1 : a > b ? 1 : 0;
      });

      for (const candidate of candidates) {
        const claimant = nextClaimed.get(candidate);
        if (claimant !== undefined && claimant !== agentId) continue;

        const occupant = occupied.get(candidate);
        if (occupant !== undefined && occupant !== agentId) {
          const occupantNext = nextOf.get(occupant);
          if (occupantNext === agent.at) continue; // would be an edge swap
        }

        nextClaimed.set(candidate, agentId);

        if (occupant !== undefined && occupant !== agentId && !assigned.has(occupant)) {
          const pushed = pibt(occupant);
          if (!pushed) {
            nextClaimed.delete(candidate);
            continue;
          }
        }

        nextOf.set(agentId, candidate);
        assigned.add(agentId);
        inProgress.delete(agentId);
        return true;
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
        const base = this.priorities.size;
        state = { base, current: base };
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
    return pa.base - pb.base;
  }
}
