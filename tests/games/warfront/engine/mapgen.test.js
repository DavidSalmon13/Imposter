'use strict';

// Warfront engine tests: map validation and fallback maps.
// Exercises server/games/warfront/engine/mapgen.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const E = require('../../../../server/games/warfront/engine');
const { rngFor } = require('../../../../server/lib/rng');
const { rawMap, SIZE, setTerrain, assertRejects } = require('../fixtures');

test('validateMap: a supply wall leaves out flank tiles that are off the map, impassable or a feature', () => {
  const raw = rawMap({ lighthouses: [{ x: 1, y: 1 }, { x: 7, y: 1 }, { x: 4, y: 3 }] });
  setTerrain(raw, 1, 3, 'water');
  const map = E.validateMap(raw, SIZE);
  assert.deepEqual(map.supplyWalls.filter((w) => w.team === 'red').map((w) => [w.x, w.y]), [[1, 2]]);
  const edge = E.validateMap(rawMap({ bases: [{ team: 'red', x: 0, y: 0 }, { team: 'blue', x: 8, y: 0 }], supplySources: [{ x: 0, y: 1 }, { x: 8, y: 1 }], lighthouses: [{ x: 2, y: 1 }, { x: 6, y: 1 }, { x: 4, y: 3 }] }), SIZE);
  assert.deepEqual(edge.supplyWalls.filter((w) => w.team === 'red').map((w) => [w.x, w.y]), [[0, 1], [1, 1]]);
});

test('validateMap accepts a good map and normalizes it', () => {
  const map = E.validateMap(rawMap(), SIZE);
  assert.equal(map.tiles.length, 45);
  assert.equal(map.tiles[0], 'plains');
  assert.equal(map.bases[0].tileId, E.tileId(0, 2, 9));
  assert.deepEqual(map.supplySources.map((s) => s.team), ['red', 'blue']);
  // Each supply source grows into a 3-tile wall across the line from its base.
  const wall = (team) => map.supplyWalls.filter((w) => w.team === team).map((w) => [w.x, w.y]);
  assert.deepEqual(wall('red'), [[1, 2], [1, 1], [1, 3]]);
  assert.deepEqual(wall('blue'), [[7, 2], [7, 1], [7, 3]]);
  assert.equal(map.veins[0].tileId, 4);
  assert.equal(map.weapons[0].weaponId, 'artillery');
  assert.equal(map.chokepoints.length, 1);
  // Also accepts a MAP_SIZES key and plain-string tiles.
  const small = E.buildFallbackMap('small', rngFor(1, 0));
  assert.deepEqual(E.validateMap(small, 'small').tiles, small.tiles);
});

test('validateMap: wrong size or tile count', () => {
  assertRejects(rawMap({ width: 10 }), /expected 9x5/);
  assertRejects(rawMap({ tiles: rawMap().tiles.slice(1) }), /exactly 45 tiles/);
});

test('validateMap: bad terrain enum', () => {
  const raw = rawMap();
  setTerrain(raw, 3, 3, 'lava');
  assertRejects(raw, /unknown terrain "lava"/);
});

test('validateMap: base rules', () => {
  assertRejects(rawMap({ bases: [{ team: 'red', x: 0, y: 2 }] }), /exactly two bases/);
  assertRejects(rawMap({ bases: [{ team: 'red', x: 0, y: 2 }, { team: 'red', x: 8, y: 2 }] }), /two red bases/);
  assertRejects(rawMap({ bases: [{ team: 'red', x: 0, y: 2 }, { team: 'green', x: 8, y: 2 }] }), /unknown team/);
  assertRejects(
    rawMap({
      bases: [{ team: 'red', x: 0, y: 2 }, { team: 'blue', x: 2, y: 2 }],
      supplySources: [{ x: 0, y: 1 }, { x: 2, y: 1 }],
    }),
    /opposite halves/,
  );
  const water = rawMap();
  setTerrain(water, 8, 2, 'water');
  assertRejects(water, /blue base .* impassable/);
});

test('validateMap: missing or misplaced supply source', () => {
  assertRejects(rawMap({ supplySources: [{ x: 1, y: 2 }] }), /exactly two supply sources/);
  assertRejects(rawMap({ supplySources: [{ x: 1, y: 2 }, { x: 6, y: 2 }] }), /blue base needs exactly one adjacent supply source/);
});

test('validateMap: vein and weapon rules', () => {
  assertRejects(rawMap({ veins: [] }), /one or two mineral veins/);
  assertRejects(rawMap({ veins: [{ x: 4, y: 0, richness: 5 }] }), /bad richness/);
  assertRejects(rawMap({ veins: [{ x: 7, y: 0, richness: 2 }] }), /not mirror-fair/);
  assertRejects(rawMap({ weapons: [{ x: 4, y: 4, weaponId: 'nuke' }] }), /unknown id "nuke"/);
  assertRejects(rawMap({ weapons: [{ x: 4, y: 0, weaponId: 'emp' }] }), /shares a tile/);
  const rocky = rawMap();
  setTerrain(rocky, 4, 4, 'rock');
  assertRejects(rocky, /weapon token .* impassable/);
});

test('validateMap: disconnected base and unreachable vein', () => {
  const split = rawMap();
  for (let y = 0; y < 5; y++) setTerrain(split, 5, y, 'water');
  assertRejects(split, /bases are not connected/);
  const boxed = rawMap();
  setTerrain(boxed, 3, 0, 'rock');
  setTerrain(boxed, 5, 0, 'rock');
  setTerrain(boxed, 4, 1, 'rock');
  assertRejects(boxed, /vein at \(4,0\) is unreachable/);
});

test('validateMap drops invalid chokepoints instead of failing', () => {
  const map = E.validateMap(rawMap({ chokepoints: [{ x: 99, y: 0 }, { x: 'a' }, { x: 4, y: 2 }] }), SIZE);
  assert.deepEqual(map.chokepoints.map((c) => c.tileId), [E.tileId(4, 2, 9)]);
});

test('buildFallbackMap: valid, mirror-symmetric maps across 200 seeds and all sizes', () => {
  for (const size of Object.keys(E.MAP_SIZES)) {
    const { width, height } = E.MAP_SIZES[size];
    for (let seed = 0; seed < 200; seed++) {
      const map = E.buildFallbackMap(size, rngFor(seed, 0));
      assert.doesNotThrow(() => E.validateMap(map, size), `${size} seed ${seed}`);
      assert.equal(map.width, width);
      assert.equal(map.height, height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          assert.equal(map.tiles[E.tileId(x, y, width)], map.tiles[E.tileId(width - 1 - x, y, width)]);
        }
      }
    }
  }
});

test('buildFallbackMap is deterministic for a given rng', () => {
  assert.deepEqual(E.buildFallbackMap('medium', rngFor(7, 0)), E.buildFallbackMap('medium', rngFor(7, 0)));
});

test('buildFallbackMap falls back to the plain map when every attempt fails', () => {
  // An rng that always returns ~1 makes every random tile rock; the plain map must still pass.
  const map = E.buildFallbackMap('small', () => 0.999999);
  assert.doesNotThrow(() => E.validateMap(map, 'small'));
  assert.ok(map.tiles.every((t) => t === 'plains'));
});
