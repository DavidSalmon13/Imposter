'use strict';

// Warfront engine tests: grid helpers and path search.
// Exercises server/games/warfront/engine/grid.js + pathing.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const E = require('../../../../server/games/warfront/engine');
const { rawMap, SIZE, makeBattle, move } = require('../fixtures');

test('tileId / tileXY / manhattan / neighbors', () => {
  assert.equal(E.tileId(3, 2, 9), 21);
  assert.deepEqual(E.tileXY(21, 9), { x: 3, y: 2 });
  assert.equal(E.manhattan(E.tileId(0, 0, 9), E.tileId(3, 2, 9), 9), 5);
  assert.deepEqual(E.neighbors(E.tileId(0, 0, 9), 9, 5), [1, 9]);
  // N, E, S, W order
  assert.deepEqual(E.neighbors(E.tileId(4, 2, 9), 9, 5), [13, 23, 31, 21]);
});

test('bfsPath walks around water, excludes start, and is deterministic', () => {
  const map = E.validateMap(rawMap(), SIZE);
  // Wall of water at x=2 except y=4.
  for (let y = 0; y < 4; y++) map.tiles[E.tileId(2, y, 9)] = 'water';
  const from = E.tileId(0, 0, 9);
  const to = E.tileId(4, 0, 9);
  const path = E.bfsPath(map, from, to);
  assert.equal(path[path.length - 1], to);
  assert.ok(!path.includes(from));
  assert.equal(path.length, 12); // down 4, across 4, up 4
  for (const id of path) assert.ok(E.isPassable(map, id));
  for (let i = 1; i < path.length; i++) assert.equal(E.manhattan(path[i - 1], path[i], 9), 1);
  assert.deepEqual(E.bfsPath(map, from, to), path);
});

test('bfsPath returns [] for same tile, impassable target, or unreachable target', () => {
  const map = E.validateMap(rawMap(), SIZE);
  assert.deepEqual(E.bfsPath(map, 0, 0), []);
  map.tiles[E.tileId(4, 2, 9)] = 'rock';
  assert.deepEqual(E.bfsPath(map, 0, E.tileId(4, 2, 9)), []);
  // Enclose (8,0) with rock.
  map.tiles[E.tileId(7, 0, 9)] = 'rock';
  map.tiles[E.tileId(8, 1, 9)] = 'rock';
  assert.deepEqual(E.bfsPath(map, 0, E.tileId(8, 0, 9)), []);
});

test('findPath walks around a hill ridge when that is quicker than climbing it', () => {
  const map = E.validateMap(rawMap(), SIZE);
  // A column of hills at x=4 for y=0..2: straight over costs 2 extra, around (via y=3) costs 6 extra plains.
  for (let y = 0; y < 3; y++) map.tiles[E.tileId(4, y, 9)] = 'hills';
  const from = E.tileId(2, 0, 9);
  const to = E.tileId(6, 0, 9);
  const over = E.findPath(map, from, to);
  assert.equal(over[over.length - 1], to);
  assert.equal(E.pathCost(map, over), 5, 'climbing one hill (4 steps, one costs 2) beats a 10-step detour');
  // A wider ridge (x=3..5): over costs 7, still less than the 10-step walk around.
  for (let y = 0; y < 3; y++) {
    map.tiles[E.tileId(3, y, 9)] = 'hills';
    map.tiles[E.tileId(5, y, 9)] = 'hills';
  }
  const best = E.findPath(map, from, E.tileId(6, 0, 9));
  const straight = E.bfsPath(map, from, to);
  assert.ok(E.pathCost(map, best) <= E.pathCost(map, straight));
  for (let i = 1; i < best.length; i++) assert.equal(E.manhattan(best[i - 1], best[i], 9), 1);
  assert.deepEqual(E.findPath(map, from, to), best, 'deterministic');
});

test('findPath prefers plains around forest, matches bfsPath length on open ground', () => {
  const map = E.validateMap(rawMap(), SIZE);
  const from = E.tileId(0, 1, 9);
  const to = E.tileId(4, 1, 9);
  assert.equal(E.findPath(map, from, to).length, E.bfsPath(map, from, to).length);
  // Three forest tiles on the straight line: over costs 7, a one-row sidestep costs 6.
  for (let x = 1; x <= 3; x++) map.tiles[E.tileId(x, 1, 9)] = 'forest';
  const path = E.findPath(map, from, to);
  assert.equal(E.pathCost(map, path), 6);
  assert.ok(path.every((id) => map.tiles[id] !== 'forest'));
  assert.deepEqual(E.findPath(map, 0, 0), []);
});

test('move: units take the quickest route, not the fewest tiles', () => {
  const b = makeBattle({
    rows: ['R.hhh.B', '.......'],
    units: [{ owner: 'Red', type: 'warrior', at: [1, 0] }],
  });
  const [w] = b.st.armies.Red.units;
  move(b.st, 'Red', [w.id], b.at(5, 0), 0);
  // Over the hills: 4 steps costing 2+2+2+1 = 7; around through row 2: 6 plains steps = 6.
  assert.equal(E.pathCost(b.st.map, w.path), 6);
  assert.ok(w.path.every((id) => b.st.map.tiles[id] !== 'hills'));
});
