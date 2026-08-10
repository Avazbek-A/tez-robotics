import type { GridPos } from "@tez/shared";

export interface MapNode {
  id: string;
  pos: GridPos;
  charger?: boolean;
}

export interface MapEdge {
  from: string;
  to: string;
}

interface RawEdge {
  from: string;
  to: string;
  bidirectional?: boolean;
}

interface RawMapData {
  nodes: MapNode[];
  edges: RawEdge[];
}

export class WarehouseMap {
  private nodeMap: Map<string, MapNode> = new Map();
  private adjacencyList: Map<string, Set<string>> = new Map();
  private distanceCache: Map<string, Map<string, number>> = new Map();

  constructor(nodeMap: Map<string, MapNode>, adjacencyList: Map<string, Set<string>>) {
    this.nodeMap = nodeMap;
    this.adjacencyList = adjacencyList;
  }

  static fromJSON(json: unknown): WarehouseMap {
    const data = json as RawMapData;

    if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
      throw new Error("Invalid map data: must have nodes and edges arrays");
    }

    const nodeMap = new Map<string, MapNode>();
    const adjacencyList = new Map<string, Set<string>>();

    // Build node map and initialize adjacency lists
    for (const node of data.nodes) {
      nodeMap.set(node.id, node);
      adjacencyList.set(node.id, new Set());
    }

    // Process edges
    for (const edge of data.edges) {
      if (!nodeMap.has(edge.from)) {
        throw new Error(`Orphan edge: source node "${edge.from}" not found`);
      }
      if (!nodeMap.has(edge.to)) {
        throw new Error(`Orphan edge: target node "${edge.to}" not found`);
      }

      adjacencyList.get(edge.from)!.add(edge.to);

      if (edge.bidirectional) {
        adjacencyList.get(edge.to)!.add(edge.from);
      }
    }

    return new WarehouseMap(nodeMap, adjacencyList);
  }

  static grid(width: number, height: number): RawMapData {
    const nodes: MapNode[] = [];
    const edges: RawEdge[] = [];

    // Create nodes
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const id = `n${x}_${y}`;
        nodes.push({
          id,
          pos: { x, y },
          charger: x === 0 ? true : undefined,
        });
      }
    }

    // Create 4-neighbor edges
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const id = `n${x}_${y}`;

        // Right neighbor
        if (x + 1 < width) {
          edges.push({
            from: id,
            to: `n${x + 1}_${y}`,
            bidirectional: true,
          });
        }

        // Down neighbor
        if (y + 1 < height) {
          edges.push({
            from: id,
            to: `n${x}_${y + 1}`,
            bidirectional: true,
          });
        }
      }
    }

    return { nodes, edges };
  }

  neighbors(nodeId: string): string[] {
    const neighbors = this.adjacencyList.get(nodeId);
    if (!neighbors) {
      throw new Error(`Node "${nodeId}" not found`);
    }
    return Array.from(neighbors);
  }

  node(nodeId: string): MapNode {
    const node = this.nodeMap.get(nodeId);
    if (!node) {
      throw new Error(`Node "${nodeId}" not found`);
    }
    return node;
  }

  distance(fromId: string, toId: string): number {
    if (!this.nodeMap.has(fromId)) {
      throw new Error(`Source node "${fromId}" not found`);
    }
    if (!this.nodeMap.has(toId)) {
      throw new Error(`Target node "${toId}" not found`);
    }

    // Check if we've already computed distances from this source
    if (!this.distanceCache.has(fromId)) {
      this.distanceCache.set(fromId, this.bfsDistances(fromId));
    }

    const distances = this.distanceCache.get(fromId)!;
    return distances.get(toId) ?? Infinity;
  }

  private bfsDistances(startId: string): Map<string, number> {
    const distances = new Map<string, number>();
    const queue: string[] = [startId];
    distances.set(startId, 0);

    let head = 0;
    while (head < queue.length) {
      const current = queue[head]!;
      head++;

      const neighbors = this.adjacencyList.get(current);
      if (!neighbors) continue;

      for (const neighbor of neighbors) {
        if (!distances.has(neighbor)) {
          distances.set(neighbor, distances.get(current)! + 1);
          queue.push(neighbor);
        }
      }
    }

    return distances;
  }

  nearestNode(pos: GridPos): string {
    let nearest = "";
    let minDistance = Infinity;

    for (const node of this.nodeMap.values()) {
      const dx = node.pos.x - pos.x;
      const dy = node.pos.y - pos.y;
      const distance = dx * dx + dy * dy;

      if (distance < minDistance) {
        minDistance = distance;
        nearest = node.id;
      }
    }

    return nearest;
  }

  get nodeIds(): string[] {
    return Array.from(this.nodeMap.keys());
  }
}
