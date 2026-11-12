'use strict';

// Warfront engine, layer 4: path search over the grid (flood fill, BFS, weighted findPath).
// Must NOT contain: unit orders or movement stepping (systems/movement.js).
// Spec: "Movement" (quickest route, terrain costs).

const { manhattan, neighbors, isPassable, moveCostAt } = require('./grid');

/** Every passable tile reachable from `from` (Set of ids). */
function floodFill(map, from) {
  const seen = new Set();
  if (!isPassable(map, from)) return seen;
  seen.add(from);
  const queue = [from];
  for (let i = 0; i < queue.length; i++) {
    for (const n of neighbors(queue[i], map.width, map.height)) {
      if (!seen.has(n) && isPassable(map, n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return seen;
}

/**
 * Shortest path over passable tiles (unweighted BFS, N/E/S/W tie-break).
 * Returns the tile ids to walk, excluding `from` and ending at `to`; [] when
 * already there, when `to` is impassable, or when it can't be reached.
 */
function bfsPath(map, from, to) {
  if (from === to || !isPassable(map, to)) return [];
  const prev = new Map([[from, -1]]);
  const queue = [from];
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    for (const n of neighbors(cur, map.width, map.height)) {
      if (prev.has(n) || !isPassable(map, n)) continue;
      prev.set(n, cur);
      if (n === to) {
        const path = [];
        for (let t = to; t !== from; t = prev.get(t)) path.push(t);
        return path.reverse();
      }
      queue.push(n);
    }
  }
  return [];
}

/**
 * Fastest path over passable tiles: A* weighted by the move cost of every tile
 * entered (so a unit walks around a hill when that's quicker than climbing it),
 * with a Manhattan heuristic (admissible: no tile costs less than 1). Among
 * equally fast paths the choice is deterministic (lowest f, then lowest h, then
 * N/E/S/W discovery order). Same contract as bfsPath: the tile ids to walk,
 * excluding `from`, ending at `to`; [] when already there or unreachable.
 */
function findPath(map, from, to) {
  if (from === to || !isPassable(map, to) || !isPassable(map, from)) return [];
  const { width, height } = map;
  const h = (id) => manhattan(id, to, width);
  const g = new Map([[from, 0]]);
  const prev = new Map([[from, -1]]);
  const closed = new Set();
  // Binary min-heap of [f, h, seq, id].
  const heap = [];
  let seq = 0;
  const less = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const push = (item) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (less(heap[i], heap[p]) >= 0) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && less(heap[l], heap[m]) < 0) m = l;
        if (r < heap.length && less(heap[r], heap[m]) < 0) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    }
    return top;
  };
  push([h(from), h(from), seq++, from]);
  while (heap.length) {
    const cur = pop()[3];
    if (closed.has(cur)) continue;
    if (cur === to) {
      const path = [];
      for (let t = to; t !== from; t = prev.get(t)) path.push(t);
      return path.reverse();
    }
    closed.add(cur);
    const gc = g.get(cur);
    for (const n of neighbors(cur, width, height)) {
      if (closed.has(n) || !isPassable(map, n)) continue;
      const gn = gc + moveCostAt(map, n);
      if (g.has(n) && g.get(n) <= gn) continue;
      g.set(n, gn);
      prev.set(n, cur);
      const hn = h(n);
      push([gn + hn, hn, seq++, n]);
    }
  }
  return [];
}

/** Total move cost of walking `path` (0 for []). */
function pathCost(map, path) {
  let c = 0;
  for (const id of path) c += moveCostAt(map, id);
  return c;
}

module.exports = {
  floodFill,
  bfsPath,
  findPath,
  pathCost,
};
