'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const E = require('../../server/games/warfrontEngine');

// ---- Step 1: data tables -------------------------------------------------

test('every race has exactly one worker, matching RACES.workerType', () => {
  for (const race of Object.keys(E.RACES)) {
    const workers = Object.values(E.UNIT_TYPES).filter((u) => u.race === race && u.class === 'worker');
    assert.equal(workers.length, 1, `${race} workers`);
    assert.equal(workers[0].id, E.RACES[race].workerType);
  }
});

test('every unit belongs to a real race and a known class, keyed by its own id', () => {
  for (const [id, u] of Object.entries(E.UNIT_TYPES)) {
    assert.equal(u.id, id);
    assert.ok(E.RACES[u.race], `${id} race ${u.race}`);
    assert.ok(E.UNIT_CLASSES.includes(u.class), `${id} class ${u.class}`);
    assert.ok(u.hp > 0 && u.atk > 0 && u.range >= 0 && u.move >= 0 && u.attackMs > 0, id);
  }
});

test('workers and basic units cost Supply only; advanced units also cost Minerals', () => {
  for (const race of Object.keys(E.RACES)) {
    const fighters = E.producibleTypes(race)
      .map((id) => E.UNIT_TYPES[id])
      .filter((u) => u.class !== 'worker')
      .sort((a, b) => a.supply - b.supply);
    // The two cheapest fighters are the basic ones.
    assert.deepEqual(fighters.slice(0, 2).map((u) => u.minerals), [0, 0], race);
    for (const u of fighters.slice(2)) assert.ok(u.minerals > 0, `${u.id} needs minerals`);
    assert.equal(E.UNIT_TYPES[E.RACES[race].workerType].minerals, 0);
  }
});

test('spec price table (D2) is encoded exactly', () => {
  const prices = {
    laborer: [3, 0], peon: [3, 0], acolyte: [3, 0],
    militiaman: [3, 0], crossbow: [4, 0], outrider: [5, 2], bastion: [6, 3], ballista: [6, 4],
    warrior: [3, 0], skirmisher: [4, 0], raider: [5, 2], berserker: [5, 2], warchief: [8, 5],
    apprentice: [3, 0], mysticArcher: [4, 0], battlemage: [6, 3], summoner: [6, 4], archmage: [9, 6],
  };
  for (const [id, [s, m]] of Object.entries(prices)) {
    assert.equal(E.UNIT_TYPES[id].supply, s, `${id} supply`);
    assert.equal(E.UNIT_TYPES[id].minerals, m, `${id} minerals`);
  }
});

test('Golem is summoned, not producible; Bastion is Forge-only', () => {
  assert.equal(E.UNIT_TYPES.golem.producible, false);
  assert.ok(!E.producibleTypes('arcane').includes('golem'));
  assert.ok(E.UNIT_TYPES.summoner.flags.includes('summonsGolem'));
  const bastions = Object.values(E.UNIT_TYPES).filter((u) => u.id === 'bastion');
  assert.deepEqual(bastions.map((u) => u.race), ['forge']);
  assert.equal(E.UNIT_TYPES.bastion.range, 0);
});

test('each race has a valid airdrop unit of its own race', () => {
  for (const [race, r] of Object.entries(E.RACES)) {
    assert.equal(E.UNIT_TYPES[r.airdropUnit].race, race);
    assert.equal(E.UNIT_TYPES[r.airdropUnit].minerals, 0);
  }
});

test('RPS triangle: counter pairs multiply to ~1, the rest is flat', () => {
  const pairs = [['melee', 'mounted'], ['mounted', 'ranged'], ['ranged', 'melee']];
  for (const [a, b] of pairs) {
    assert.equal(E.rpsMultiplier(a, b), 1.5);
    assert.equal(E.rpsMultiplier(b, a), 0.67);
    assert.ok(Math.abs(E.rpsMultiplier(a, b) * E.rpsMultiplier(b, a) - 1) < 0.01);
  }
  for (const a of E.UNIT_CLASSES) {
    for (const b of E.UNIT_CLASSES) {
      if (!E.RPS_CLASSES.includes(a) || !E.RPS_CLASSES.includes(b) || a === b) {
        assert.equal(E.rpsMultiplier(a, b), 1, `${a} vs ${b}`);
      }
    }
  }
  // Accepts unit type ids too.
  assert.equal(E.rpsMultiplier('warrior', 'raider'), 1.5);
  assert.equal(E.rpsMultiplier('apprentice', 'raider'), 1);
});

test('terrain, facilities, menus and host options match the spec', () => {
  assert.deepEqual(Object.keys(E.TERRAIN_TYPES).sort(), ['forest', 'hills', 'plains', 'rock', 'water']);
  assert.equal(E.TERRAIN_TYPES.water.passable, false);
  assert.equal(E.TERRAIN_TYPES.forest.moveCost, 2);
  assert.deepEqual(Object.keys(E.FACILITIES).sort(), ['barracks', 'refinery', 'tower', 'workshop']);
  assert.deepEqual(Object.keys(E.WEAPON_EFFECTS).sort(), ['aegis', 'airdrop', 'artillery', 'bombard', 'emp']);
  assert.deepEqual(Object.keys(E.EVENT_EFFECTS).sort(), ['calm', 'mineralRush', 'reinforcements', 'sandstorm', 'supplyDrop']);
  assert.deepEqual(
    Object.values(E.MAP_SIZES).map((s) => [s.width, s.height]),
    [[12, 8], [16, 11], [20, 13]],
  );
  assert.deepEqual(Object.values(E.MATCH_LENGTHS).map((l) => l.ms / 60000), [8, 12, 16]);
  assert.equal(E.MATCH_LENGTHS[E.DEFAULT_MATCH_LENGTH].ms, E.WF_MATCH_CAP_MS);
  assert.ok(E.MAP_SIZES[E.DEFAULT_MAP_SIZE]);
  assert.ok(Object.keys(E.TEAM_PHRASES).length > 0);
});

test('tables are frozen', () => {
  assert.ok(Object.isFrozen(E.TUNING));
  assert.ok(Object.isFrozen(E.UNIT_TYPES) && Object.isFrozen(E.UNIT_TYPES.warrior));
});

test('engine source has no non-deterministic or I/O calls', () => {
  const src = require('node:fs')
    .readFileSync(require.resolve('../../server/games/warfrontEngine'), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  for (const banned of ['Math.random', 'Date.now', 'setInterval', 'setTimeout', "require('socket.io", 'fetch(']) {
    assert.ok(!src.includes(banned), banned);
  }
});

// ---- Step 2: map helpers, validation, fallback ----------------------------

const { rngFor } = require('../../server/lib/rng');

// A small hand-made valid map: 9x5 plains, bases at the ends of the middle row.
function rawMap(overrides = {}) {
  const width = 9;
  const height = 5;
  return {
    theme: 'Test Field',
    lore: 'A test.',
    width,
    height,
    tiles: Array.from({ length: width * height }, () => ({ terrain: 'plains' })),
    bases: [{ team: 'red', x: 0, y: 2 }, { team: 'blue', x: 8, y: 2 }],
    supplySources: [{ x: 1, y: 2 }, { x: 7, y: 2 }],
    veins: [{ x: 4, y: 0, richness: 2, contested: true }],
    weapons: [{ x: 4, y: 4, weaponId: 'artillery' }],
    chokepoints: [{ x: 4, y: 2 }],
    ...overrides,
  };
}
const SIZE = { width: 9, height: 5 };
function setTerrain(raw, x, y, terrain) {
  raw.tiles[y * raw.width + x] = { terrain };
}

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

test('validateMap accepts a good map and normalizes it', () => {
  const map = E.validateMap(rawMap(), SIZE);
  assert.equal(map.tiles.length, 45);
  assert.equal(map.tiles[0], 'plains');
  assert.equal(map.bases[0].tileId, E.tileId(0, 2, 9));
  assert.deepEqual(map.supplySources.map((s) => s.team), ['red', 'blue']);
  assert.equal(map.veins[0].tileId, 4);
  assert.equal(map.weapons[0].weaponId, 'artillery');
  assert.equal(map.chokepoints.length, 1);
  // Also accepts a MAP_SIZES key and plain-string tiles.
  const small = E.buildFallbackMap('small', rngFor(1, 0));
  assert.deepEqual(E.validateMap(small, 'small').tiles, small.tiles);
});

function assertRejects(raw, pattern) {
  assert.throws(() => E.validateMap(raw, SIZE), pattern);
}

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
