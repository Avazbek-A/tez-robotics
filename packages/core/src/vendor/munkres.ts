/**
 * Hungarian algorithm (Kuhn–Munkres). Original clean-room TypeScript implementation for this project.
 * Solves the assignment problem for rectangular matrices in O(n³) time.
 */

/**
 * Finds the optimal assignment of rows to columns minimizing total cost.
 * Returns array of [row, col] assignments.
 * @param costMatrix - rectangular matrix where costMatrix[row][col] is the cost
 * @returns array of [row, col] assignments
 */
export function hungarianAssignment(
  costMatrix: number[][]
): Array<[row: number, col: number]> {
  const m = costMatrix.length;
  if (m === 0) return [];

  const n = costMatrix[0]!.length;
  if (n === 0) return [];

  // Pad to square matrix
  const size = Math.max(m, n);
  const cost: number[][] = Array.from({ length: size }, () =>
    Array(size).fill(1e9)
  );

  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      cost[i]![j] = costMatrix[i]![j]!;
    }
  }

  // Potentials (dual variables)
  const u = new Array(size + 1).fill(0);
  const v = new Array(size + 1).fill(0);
  const p = new Array(size + 1).fill(0);
  const way = new Array(size + 1).fill(0);

  // Process each row
  for (let i = 1; i <= size; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(size + 1).fill(Infinity);
    const used = new Array(size + 1).fill(false);

    do {
      used[j0] = true;
      const i0 = p[j0]!;
      let delta = Infinity;
      let j1 = 0;

      for (let j = 1; j <= size; j++) {
        if (!used[j]) {
          const cur = cost[i0 - 1]![j - 1]! - u[i0]! - v[j]!;
          if (cur < minv[j]) {
            minv[j] = cur;
            way[j] = j0;
          }
          if (minv[j] < delta) {
            delta = minv[j];
            j1 = j;
          }
        }
      }

      for (let j = 0; j <= size; j++) {
        if (used[j]) {
          u[p[j]!] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }

      j0 = j1;
    } while (p[j0] !== 0);

    do {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
    } while (j0 > 0);
  }

  // Extract result
  const result: Array<[row: number, col: number]> = [];
  for (let j = 1; j <= size; j++) {
    if (p[j]! > 0 && p[j]! <= m && j <= n) {
      result.push([p[j]! - 1, j - 1]);
    }
  }

  return result;
}
