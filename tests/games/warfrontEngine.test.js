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

// ---- Step 4: battle state --------------------------------------------------

test('createBattleState seeds armies, bases, pickups and the clock', () => {
  const map = E.buildFallbackMap('small', rngFor(3, 0));
  const roster = [
    { name: 'Ann', team: 'red', race: 'forge' },
    { name: 'Bob', team: 'blue', race: 'arcane' },
    { name: 'Cat', team: 'blue', race: 'horde' },
  ];
  const st = E.createBattleState(map, roster, { seed: 42, now: 1000, matchCapMs: 480000 });
  assert.equal(st.seed, 42);
  assert.equal(st.tick, 0);
  assert.equal(st.winner, null);
  assert.equal(st.bases.red.hp, E.TUNING.baseHp);
  assert.equal(st.bases.red.tileId, map.bases.find((b) => b.team === 'red').tileId);
  assert.equal(st.bases.blue.shieldUntil, 0);
  assert.deepEqual(st.clock, { startedAt: 1000, matchEndsAt: 481000, lastTickAt: 1000 });
  assert.equal(st.nextEventAt, 1000 + E.WF_EVENT_MS);

  assert.equal(st.armies.Ann.supply, E.TUNING.startSupply);
  assert.equal(st.armies.Ann.minerals, E.TUNING.startMinerals);
  assert.equal(st.armies.Ann.units.length, E.TUNING.startWorkers);
  assert.ok(st.armies.Ann.units.every((u) => u.type === 'laborer' && u.tileId === st.bases.red.tileId && u.owner === 'Ann'));
  assert.ok(st.armies.Bob.units.every((u) => u.type === 'acolyte' && u.tileId === st.bases.blue.tileId));
  assert.ok(st.armies.Cat.units.every((u) => u.type === 'peon' && u.class === 'worker' && u.hp === 5));

  const ids = Object.values(st.armies).flatMap((a) => a.units.map((u) => u.id));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(st.nextUnitId, Math.max(...ids) + 1);
  assert.deepEqual(st.pickups.weapons, map.weapons.map((w) => ({ tileId: w.tileId, weaponId: w.weaponId })));
  // Survives a JSON round trip unchanged (it's persisted as-is).
  assert.deepEqual(JSON.parse(JSON.stringify(st)), st);
});

test('createBattleState rejects an unknown race or team', () => {
  const map = E.buildFallbackMap('small', rngFor(3, 0));
  assert.throws(() => E.createBattleState(map, [{ name: 'A', team: 'red', race: 'elves' }], { seed: 1, now: 0 }), /race/);
  assert.throws(() => E.createBattleState(map, [{ name: 'A', team: 'green', race: 'forge' }], { seed: 1, now: 0 }), /team/);
});

// ---- Step 5: movement, pickups, fog ----------------------------------------

/**
 * A tiny hand-made battle. `rows` are strings, one char per tile:
 * . plains  f forest  h hills  ~ water  # rock  R red base  B blue base.
 * `units` = [{ owner, type, at: [x, y], hold }]; owners are 'Red' (red) and 'Blue' (blue);
 * `hold` puts the unit on Hold (it never falls back).
 * Returns { st, at(x, y) -> tileId, unit(owner, i) }.
 */
function makeBattle({ rows, units = [], weapons = [] }) {
  const height = rows.length;
  const width = rows[0].length;
  const terrain = { '.': 'plains', f: 'forest', h: 'hills', '~': 'water', '#': 'rock', R: 'plains', B: 'plains' };
  const tiles = [];
  const bases = {};
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    tiles.push(terrain[ch]);
    if (ch === 'R') bases.red = E.tileId(x, y, width);
    if (ch === 'B') bases.blue = E.tileId(x, y, width);
  }));
  const map = {
    theme: 'Test', lore: '', width, height, tiles,
    bases: [{ team: 'red', tileId: bases.red }, { team: 'blue', tileId: bases.blue }],
    supplySources: [], veins: [], chokepoints: [],
    weapons: weapons.map(([x, y, weaponId]) => ({ x, y, tileId: E.tileId(x, y, width), weaponId })),
  };
  const st = E.createBattleState(map, [
    { name: 'Red', team: 'red', race: 'horde' },
    { name: 'Blue', team: 'blue', race: 'forge' },
  ], { seed: 7, now: 0 });
  st.armies.Red.units = [];
  st.armies.Blue.units = [];
  for (const { owner, type, at, hold } of units) {
    const u = E.makeUnit(st.nextUnitId++, type, owner, E.tileId(at[0], at[1], width));
    if (hold) u.holding = true;
    st.armies[owner].units.push(u);
  }
  return {
    st,
    at: (x, y) => E.tileId(x, y, width),
    unit: (owner, i = 0) => st.armies[owner].units[i],
  };
}

/** Steps the sim from `from` to `to` (ms) in 200 ms ticks. */
function run(st, from, to, dt = 200) {
  for (let now = from + dt; now <= to; now += dt) E.stepSim(st, dt, { now });
}

const move = (st, owner, ids, toTileId, now) => E.applyCommand(st, owner, { kind: 'move', unitIds: ids, toTileId }, now);

test('move: walks around water, one tile at a time, and stops on the target', () => {
  const b = makeBattle({
    rows: [
      'R.~..',
      '..~..',
      '....B',
    ],
    units: [{ owner: 'Red', type: 'warrior', at: [0, 0] }],
  });
  const w = b.unit('Red');
  assert.deepEqual(move(b.st, 'Red', [w.id], b.at(3, 0), 0), { ok: true, moved: 1 });
  // Shortest way round the water: down to row 2, across, back up. 7 steps.
  assert.equal(w.path.length, 7);
  const visited = [];
  for (let now = 200; now <= 7 * E.WF_STEP_MS_BASE + 200; now += 200) {
    E.stepSim(b.st, 200, { now });
    if (visited[visited.length - 1] !== w.tileId) visited.push(w.tileId);
  }
  assert.equal(w.tileId, b.at(3, 0));
  assert.deepEqual(w.path, []);
  assert.equal(w.stepEndsAt, 0);
  for (const t of visited) assert.ok(E.isPassable(b.st.map, t));
  assert.ok(visited.includes(b.at(2, 2)), 'crossed below the water');
});

test('move: a forest step takes twice as long as a plains step', () => {
  const b = makeBattle({
    rows: ['R.f..B'],
    units: [{ owner: 'Red', type: 'warrior', at: [1, 0] }, { owner: 'Red', type: 'warrior', at: [3, 0] }],
  });
  const [onPlains, beforeForest] = b.st.armies.Red.units;
  assert.equal(E.stepMs(b.st.map, 'warrior', b.at(4, 0)), E.WF_STEP_MS_BASE);
  assert.equal(E.stepMs(b.st.map, 'warrior', b.at(2, 0)), 2 * E.WF_STEP_MS_BASE);
  move(b.st, 'Red', [onPlains.id], b.at(2, 0), 0); // into the forest
  move(b.st, 'Red', [beforeForest.id], b.at(4, 0), 0); // onto plains
  const P = E.WF_STEP_MS_BASE;
  E.stepSim(b.st, 200, { now: P });
  assert.equal(beforeForest.tileId, b.at(4, 0));
  assert.equal(onPlains.tileId, b.at(1, 0), 'still on its way into the forest');
  E.stepSim(b.st, 200, { now: 2 * P - 1 });
  assert.equal(onPlains.tileId, b.at(1, 0));
  E.stepSim(b.st, 1, { now: 2 * P });
  assert.equal(onPlains.tileId, b.at(2, 0));
});

test('move: a Raider (Move 3) walks twice as fast as a Warrior; an Outrider (Move 2) 1.5x (D16)', () => {
  const b = makeBattle({
    rows: ['R........B'],
    units: [{ owner: 'Red', type: 'warrior', at: [0, 0] }, { owner: 'Red', type: 'raider', at: [0, 0] }],
  });
  const [warrior, raider] = b.st.armies.Red.units;
  move(b.st, 'Red', [warrior.id, raider.id], b.at(8, 0), 0);
  assert.equal(E.stepMs(b.st.map, 'raider', b.at(1, 0)), Math.round(E.WF_STEP_MS_BASE / 2));
  assert.equal(E.stepMs(b.st.map, 'outrider', b.at(1, 0)), Math.round(E.WF_STEP_MS_BASE / 1.5));
  run(b.st, 0, 8 * Math.round(E.WF_STEP_MS_BASE / 2) + 200);
  assert.equal(E.tileXY(raider.tileId, 10).x, 8, 'raider: half a Warrior step a tile');
  assert.equal(E.tileXY(warrior.tileId, 10).x, 4, 'warrior: one full step a tile');
  // A Warrior crosses a medium map (14 tiles of plains) in about a minute.
  assert.ok(Math.abs(14 * E.WF_STEP_MS_BASE - 60000) < 1000);
});

test('move: re-issuing an order repaths; the step in progress finishes first', () => {
  const b = makeBattle({
    rows: [
      '.....',
      'R...B',
      '.....',
    ],
    units: [{ owner: 'Red', type: 'warrior', at: [1, 1] }],
  });
  const w = b.unit('Red');
  move(b.st, 'Red', [w.id], b.at(4, 0), 0);
  run(b.st, 0, 400);
  const next = w.path[0];
  assert.equal(w.tileId, b.at(1, 1));
  assert.deepEqual(move(b.st, 'Red', [w.id], b.at(0, 2), 400), { ok: true, moved: 1 });
  assert.equal(w.path[0], next, 'keeps the tile it is stepping onto');
  assert.equal(w.path[w.path.length - 1], b.at(0, 2));
  run(b.st, 400, 6 * E.WF_STEP_MS_BASE);
  assert.equal(w.tileId, b.at(0, 2));
});

test('move: guards ownership, passability and non-moving units; bad orders change nothing', () => {
  const b = makeBattle({
    rows: ['R.~.B'],
    units: [{ owner: 'Red', type: 'warrior', at: [0, 0] }, { owner: 'Blue', type: 'militiaman', at: [4, 0] }, { owner: 'Blue', type: 'bastion', at: [3, 0] }],
  });
  const w = b.unit('Red');
  const enemy = b.unit('Blue');
  assert.equal(move(b.st, 'Red', [enemy.id], b.at(1, 0), 0).ok, false);
  assert.equal(move(b.st, 'Red', [w.id], b.at(2, 0), 0).ok, false, 'water');
  assert.equal(move(b.st, 'Red', [w.id], 999, 0).ok, false, 'off the map');
  assert.equal(move(b.st, 'Red', [w.id], b.at(4, 0), 0).ok, false, 'unreachable across the water');
  assert.equal(move(b.st, 'Red', [w.id], b.at(0, 0), 0).ok, false, 'already there');
  assert.equal(move(b.st, 'Blue', [b.unit('Blue', 1).id], b.at(4, 0), 0).ok, false, 'a Bastion cannot move');
  assert.equal(move(b.st, 'Red', [], b.at(1, 0), 0).ok, false);
  assert.equal(E.applyCommand(b.st, 'Nobody', { kind: 'move', unitIds: [w.id], toTileId: 1 }, 0).ok, false);
  assert.equal(E.applyCommand(b.st, 'Red', { kind: 'dance' }, 0).ok, false);
  assert.equal(E.applyCommand(b.st, 'Red', null, 0).ok, false);
  assert.deepEqual(w.path, []);
  assert.deepEqual(enemy.path, []);
});

test('move: a stalled loop does not fast-forward units through a backlog of steps', () => {
  const b = makeBattle({ rows: ['R........B'], units: [{ owner: 'Red', type: 'warrior', at: [0, 0] }] });
  const w = b.unit('Red');
  move(b.st, 'Red', [w.id], b.at(8, 0), 0);
  // 30 s pass in one call, clamped to WF_MAX_DT_MS: the unit finishes the step it was
  // on, then only walks what fits in that last second, not 30 s worth of tiles.
  E.stepSim(b.st, 30000, { now: 30000 });
  assert.equal(E.tileXY(w.tileId, 10).x, 1);
  assert.equal(w.stepEndsAt, 30000 - E.WF_MAX_DT_MS + E.WF_STEP_MS_BASE);
});

test('arriving on a weapon token or a mineral drop collects it', () => {
  const b = makeBattle({
    rows: ['R....B'],
    units: [{ owner: 'Red', type: 'warrior', at: [0, 0] }],
    weapons: [[2, 0, 'artillery']],
  });
  b.st.pickups.mineralDrops[b.at(3, 0)] = 3;
  const w = b.unit('Red');
  move(b.st, 'Red', [w.id], b.at(3, 0), 0);
  const events = [];
  for (let now = 200; now <= 3 * E.WF_STEP_MS_BASE + 200; now += 200) events.push(...E.stepSim(b.st, 200, { now }).events);
  assert.deepEqual(b.st.armies.Red.arsenal, ['artillery']);
  assert.deepEqual(b.st.pickups.weapons, []);
  assert.equal(b.st.armies.Red.minerals, 3);
  assert.deepEqual(b.st.pickups.mineralDrops, {});
  assert.deepEqual(events.map((e) => [e.type, e.weaponId || e.minerals]), [['pickup', 'artillery'], ['pickup', 3]]);
});

test('stepSim advances tick and the clock', () => {
  const b = makeBattle({ rows: ['R..B'] });
  E.stepSim(b.st, 200, { now: 200 });
  E.stepSim(b.st, 200, { now: 400 });
  assert.equal(b.st.tick, 2);
  assert.equal(b.st.clock.lastTickAt, 400);
});

test('fog: an enemy 3 tiles away is hidden, at 2 it shows', () => {
  const b = makeBattle({
    rows: ['R.........B'],
    units: [{ owner: 'Red', type: 'warrior', at: [5, 0] }, { owner: 'Blue', type: 'militiaman', at: [8, 0] }],
  });
  const enemy = b.unit('Blue');
  let view = E.viewForPlayer(b.st, 'Red');
  assert.deepEqual(view.units.map((u) => u.owner), ['Red']);
  assert.equal(view.visible[b.at(8, 0)], '0');
  assert.equal(view.visible[b.at(7, 0)], '1');
  enemy.tileId = b.at(7, 0);
  view = E.viewForPlayer(b.st, 'Red');
  assert.deepEqual(view.units.map((u) => u.owner).sort(), ['Blue', 'Red']);
  // The own base also gives vision.
  assert.equal(view.visible[b.at(2, 0)], '1');
  assert.equal(view.visible[b.at(3, 0)], '1', 'from the warrior at x=5');
  // Each side sees its own units no matter what.
  assert.ok(E.viewForPlayer(b.st, 'Blue').units.some((u) => u.owner === 'Blue'));
});

test('fog: an enemy shows only the tile it steps onto, never its destination; own units show the path', () => {
  const b = makeBattle({
    rows: ['R......B'],
    units: [{ owner: 'Red', type: 'warrior', at: [2, 0] }, { owner: 'Blue', type: 'militiaman', at: [4, 0] }],
  });
  move(b.st, 'Blue', [b.unit('Blue').id], b.at(0, 0), 0);
  const seen = E.viewForPlayer(b.st, 'Red').units.find((u) => u.owner === 'Blue');
  assert.equal(seen.nextTileId, b.at(3, 0));
  assert.equal(seen.path, undefined);
  const own = E.viewForPlayer(b.st, 'Blue').units.find((u) => u.owner === 'Blue');
  assert.deepEqual(own.path, [3, 2, 1, 0].map((x) => b.at(x, 0)));
});

test('fog: an enemy hauler\'s carrying is absent outside vision and shown inside it', () => {
  const b = makeBattle({
    rows: ['R.........B'],
    units: [{ owner: 'Red', type: 'warrior', at: [3, 0] }, { owner: 'Blue', type: 'laborer', at: [8, 0] }],
  });
  b.unit('Blue').carrying = 4;
  const enemies = (view) => view.units.filter((u) => u.owner === 'Blue');
  assert.deepEqual(enemies(E.viewForPlayer(b.st, 'Red')), [], 'nothing about the hauler leaks');
  assert.ok(!JSON.stringify(E.viewForPlayer(b.st, 'Red')).includes('"carrying":4'));
  b.unit('Blue').tileId = b.at(5, 0);
  const seen = E.viewForPlayer(b.st, 'Red').units.find((u) => u.owner === 'Blue');
  assert.equal(seen.carrying, 4);
});

test('fog: a spectator with no army sees no units; events are filtered by team and vision', () => {
  const b = makeBattle({
    rows: ['R.........B'],
    units: [{ owner: 'Red', type: 'warrior', at: [1, 0] }, { owner: 'Blue', type: 'militiaman', at: [9, 0] }],
  });
  const view = E.viewForPlayer(b.st, 'Watcher');
  assert.deepEqual(view.units, []);
  assert.equal(view.me, null);
  assert.ok(!view.visible.includes('1'));
  const events = [{ type: 'pickup', tileId: b.at(9, 0), owner: 'Blue', team: 'blue' }];
  assert.deepEqual(E.eventsForPlayer(b.st, 'Red', events), []);
  assert.equal(E.eventsForPlayer(b.st, 'Blue', events).length, 1);
  assert.deepEqual(E.eventsForPlayer(b.st, 'Watcher', events), []);
});

test('the same orders and seed give the same world (no hidden clock or randomness)', () => {
  const play = () => {
    const b = makeBattle({
      rows: ['R..f..h..~', '.........B', '...#......'],
      units: [{ owner: 'Red', type: 'raider', at: [0, 1] }, { owner: 'Blue', type: 'outrider', at: [9, 1] }],
    });
    move(b.st, 'Red', [b.unit('Red').id], b.at(8, 2), 0);
    move(b.st, 'Blue', [b.unit('Blue').id], b.at(0, 0), 0);
    run(b.st, 0, 3000);
    move(b.st, 'Red', [b.unit('Red').id], b.at(2, 0), 3000);
    run(b.st, 3000, 12000);
    return JSON.stringify(b.st);
  };
  assert.equal(play(), play());
});

// ---- Step 6: combat --------------------------------------------------------

/** Runs the sim from `from` to `to` ms in 200 ms steps and returns every event. */
function fight(b, to, from = 0, dt = 200) {
  const events = [];
  for (let now = from + dt; now <= to; now += dt) events.push(...E.stepSim(b.st, dt, { now }).events);
  return events;
}

/** The damage of the first hit landing on `victimOwner`'s units, for each seed. */
function firstHitDamage(build, seeds, victimOwner = 'Blue') {
  return seeds.map((seed) => {
    const b = build();
    b.st.seed = seed;
    const hit = E.stepSim(b.st, 200, { now: 200 }).events.find((e) => e.type === 'underAttack' && e.owner === victimOwner);
    return hit.dmg;
  });
}

const SEEDS = Array.from({ length: 80 }, (_, i) => i * 7919 + 13);
const spread = (xs) => {
  const mean = xs.reduce((a, x) => a + x, 0) / xs.length;
  return (Math.max(...xs) - Math.min(...xs)) / mean;
};

test('combat: rock-paper-scissors decides duels across seeds (melee > mounted, ranged > melee)', () => {
  const duel = (redType, blueType, seed) => {
    const b = makeBattle({
      rows: ['R.........B'],
      units: [{ owner: 'Red', type: redType, at: [4, 0], hold: true }, { owner: 'Blue', type: blueType, at: [5, 0], hold: true }],
    });
    b.st.seed = seed;
    fight(b, 20000);
    return { red: b.st.armies.Red.units.length, blue: b.st.armies.Blue.units.length };
  };
  let meleeWins = 0;
  let rangedWins = 0;
  for (const seed of SEEDS) {
    const a = duel('warrior', 'outrider', seed); // horde melee vs forge mounted
    if (a.red && !a.blue) meleeWins++;
    const c = duel('militiaman', 'crossbow', seed); // melee vs ranged, same race
    if (c.blue && !c.red) rangedWins++;
  }
  assert.ok(meleeWins >= SEEDS.length * 0.95, `melee beat mounted ${meleeWins}/${SEEDS.length}`);
  assert.ok(rangedWins >= SEEDS.length * 0.95, `ranged beat melee ${rangedWins}/${SEEDS.length}`);
});

test('combat: a defender on hills survives longer than the same defender on plains', () => {
  const timeToDie = (terrain) => {
    const b = makeBattle({
      rows: [`R...${terrain}${terrain}....B`],
      units: [
        { owner: 'Red', type: 'warrior', at: [4, 0], hold: true },
        { owner: 'Blue', type: 'militiaman', at: [5, 0], hold: true },
      ],
    });
    for (let now = 200; now <= 30000; now += 200) {
      if (E.stepSim(b.st, 200, { now }).events.some((e) => e.type === 'death' && e.owner === 'Blue')) return now;
    }
    return Infinity;
  };
  assert.ok(timeToDie('h') > timeToDie('.'), `hills ${timeToDie('h')} ms vs plains ${timeToDie('.')} ms`);
});

test('combat: Horde\'s luck swing is narrower than Arcane\'s', () => {
  const shooter = (type) => () => makeBattle({
    rows: ['R...........B'],
    units: [{ owner: 'Red', type, at: [5, 0], hold: true }, { owner: 'Blue', type: 'militiaman', at: [6, 0], hold: true }],
  });
  const horde = spread(firstHitDamage(shooter('warrior'), SEEDS));
  const arcane = spread(firstHitDamage(shooter('apprentice'), SEEDS));
  assert.ok(horde < arcane * 0.75, `horde ${horde.toFixed(3)} vs arcane ${arcane.toFixed(3)}`);
});

test('combat: a team that counters the dominant class hits with no luck at all (strategyEdge = 1)', () => {
  // Red warriors (melee) against a Blue raider (mounted, the only class near them):
  // every Red RPS unit counters it, so the swing is 0 and the hit is exact.
  const dmg = firstHitDamage(() => makeBattle({
    rows: ['R.........B'],
    units: [
      { owner: 'Red', type: 'warrior', at: [4, 0], hold: true },
      { owner: 'Red', type: 'warrior', at: [3, 0], hold: true },
      { owner: 'Blue', type: 'raider', at: [5, 0], hold: true },
    ],
  }), SEEDS.slice(0, 20));
  const exact = Math.round(5 * E.TUNING.rpsCounter * E.TUNING.hordeAtkMult * 100) / 100;
  assert.deepEqual(new Set(dmg), new Set([exact]));
});

test('combat: an Archmage near the shooter halves its luck swing (D6)', () => {
  const build = (withArchmage) => () => makeBattle({
    rows: ['R...........B'],
    units: [
      ...(withArchmage ? [{ owner: 'Red', type: 'archmage', at: [3, 0], hold: true }] : []),
      { owner: 'Red', type: 'apprentice', at: [5, 0], hold: true },
      { owner: 'Blue', type: 'militiaman', at: [7, 0], hold: true },
    ],
  });
  const plain = spread(firstHitDamage(build(false), SEEDS));
  const bent = spread(firstHitDamage(build(true), SEEDS));
  assert.ok(Math.abs(bent / plain - E.TUNING.archmageOwnLuckMult) < 0.1, `ratio ${(bent / plain).toFixed(3)}`);
});

test('combat: a Battlemage hits every enemy on its target\'s tile and none on the next', () => {
  const b = makeBattle({
    rows: ['R.........B'],
    units: [
      { owner: 'Red', type: 'battlemage', at: [4, 0], hold: true },
      { owner: 'Blue', type: 'militiaman', at: [5, 0], hold: true },
      { owner: 'Blue', type: 'militiaman', at: [5, 0], hold: true },
      { owner: 'Blue', type: 'militiaman', at: [6, 0], hold: true },
    ],
  });
  const events = E.stepSim(b.st, 200, { now: 200 }).events;
  const hitIds = events.filter((e) => e.type === 'underAttack' && e.owner === 'Blue').map((e) => e.unitId);
  const [a, c, far] = b.st.armies.Blue.units;
  assert.deepEqual(hitIds.sort(), [a.id, c.id].sort());
  assert.ok(a.hp < E.UNIT_TYPES.militiaman.hp && c.hp < E.UNIT_TYPES.militiaman.hp);
  assert.equal(far.hp, E.UNIT_TYPES.militiaman.hp);
});

test('combat: a contested base takes no damage; once the defender is gone it does', () => {
  const b = makeBattle({
    rows: ['R........B'],
    units: [
      { owner: 'Red', type: 'skirmisher', at: [7, 0], hold: true },
      { owner: 'Blue', type: 'bastion', at: [9, 0] },
    ],
  });
  fight(b, 2000);
  assert.equal(b.st.bases.blue.hp, E.TUNING.baseHp, 'the Bastion on the base tile contests it');
  assert.ok(b.unit('Blue').hp < E.UNIT_TYPES.bastion.hp, 'the Bastion is the target instead');
  b.st.armies.Blue.units = [];
  E.stepSim(b.st, 200, { now: 2200 });
  E.stepSim(b.st, 200, { now: 2400 });
  E.stepSim(b.st, 200, { now: 2600 });
  E.stepSim(b.st, 200, { now: 2800 });
  E.stepSim(b.st, 200, { now: 3000 });
  assert.ok(b.st.bases.blue.hp < E.TUNING.baseHp);
});

test('combat: a base shoots an adjacent raider every baseAttackMs, but never across the cliff', () => {
  const b = makeBattle({ rows: ['R........B'], units: [{ owner: 'Red', type: 'raider', at: [8, 0], hold: true }] });
  const events = fight(b, 3000);
  const fromBase = events.filter((e) => e.type === 'underAttack' && e.owner === 'Red' && e.fromTileId === b.at(9, 0));
  assert.equal(fromBase.length, 2, 'at 200 ms and 1800 ms');
  assert.ok(b.unit('Red').hp < E.UNIT_TYPES.raider.hp);
  assert.ok(events.some((e) => e.type === 'baseHit' && e.team === 'blue'), 'and the raider hits back');

  const high = makeBattle({ rows: ['R.......hB'], units: [{ owner: 'Red', type: 'raider', at: [8, 0], hold: true }] });
  assert.deepEqual(fight(high, 3000), [], 'raider on a hill, base below: nobody reaches');
});

test('combat: siege deals ×3 to a base (a Ballista out-cracks a Crossbow despite less attack)', () => {
  const mean = (type) => {
    const xs = SEEDS.map((seed) => {
      const b = makeBattle({ rows: ['R........B'], units: [{ owner: 'Red', type, at: [7, 0], hold: true }] });
      b.st.seed = seed;
      return E.stepSim(b.st, 200, { now: 200 }).events.find((e) => e.type === 'baseHit').dmg;
    });
    return xs.reduce((a, x) => a + x, 0) / xs.length;
  };
  const ballista = mean('ballista');
  const crossbow = mean('crossbow');
  // 4 atk ×3 vs 5 atk, both ÷ structureDefense: ≈ 8 vs ≈ 3.33.
  assert.ok(Math.abs(ballista - (4 * 3) / E.TUNING.structureDefense) < 0.5, `ballista ${ballista}`);
  assert.ok(Math.abs(crossbow - 5 / E.TUNING.structureDefense) < 0.3, `crossbow ${crossbow}`);
});

test('combat: identical seed and orders give an identical fight; another seed differs', () => {
  const brawl = (seed) => {
    const b = makeBattle({
      rows: ['R..h.....B', '...f..f...', '.....h....'],
      units: [
        { owner: 'Red', type: 'warrior', at: [2, 1] }, { owner: 'Red', type: 'skirmisher', at: [3, 0] },
        { owner: 'Red', type: 'battlemage', at: [2, 2] }, { owner: 'Red', type: 'archmage', at: [1, 1] },
        { owner: 'Blue', type: 'militiaman', at: [7, 1] }, { owner: 'Blue', type: 'crossbow', at: [8, 0] },
        { owner: 'Blue', type: 'outrider', at: [7, 2] }, { owner: 'Blue', type: 'ballista', at: [8, 1] },
      ],
    });
    b.st.seed = seed;
    for (const u of b.st.armies.Red.units) move(b.st, 'Red', [u.id], b.at(6, 1), 0);
    fight(b, 20000);
    return JSON.stringify(b.st);
  };
  assert.equal(brawl(42), brawl(42));
  assert.notEqual(brawl(42), brawl(43));
});

test('combat: a unit at 0 HP dies at once and a loaded Worker drops its cargo', () => {
  const b = makeBattle({
    rows: ['R.........B'],
    units: [{ owner: 'Red', type: 'warchief', at: [4, 0], hold: true }, { owner: 'Blue', type: 'laborer', at: [5, 0], hold: true }],
  });
  b.unit('Blue').hp = 1;
  b.unit('Blue').carrying = 3;
  const events = E.stepSim(b.st, 200, { now: 200 }).events;
  assert.deepEqual(b.st.armies.Blue.units, []);
  assert.deepEqual(b.st.pickups.mineralDrops, { [b.at(5, 0)]: 3 });
  assert.ok(events.some((e) => e.type === 'death' && e.owner === 'Blue' && e.unitType === 'laborer' && e.tileId === b.at(5, 0)));
});

test('combat: a marching unit fires on the way and keeps marching; arrived, it stays put', () => {
  const b = makeBattle({
    rows: ['R.........B', '...........'],
    units: [{ owner: 'Red', type: 'skirmisher', at: [2, 0] }, { owner: 'Blue', type: 'bastion', at: [5, 1] }],
  });
  const s = b.unit('Red');
  move(b.st, 'Red', [s.id], b.at(7, 0), 0);
  const arrive = 5 * E.WF_STEP_MS_BASE + 200;
  const events = fight(b, arrive);
  const shots = events.filter((e) => e.type === 'underAttack' && e.owner === 'Blue');
  assert.ok(shots.length >= 2, 'fired while walking past');
  assert.equal(s.tileId, b.at(7, 0), 'and still arrived');
  assert.deepEqual(s.path, []);
  fight(b, arrive + 3000, arrive);
  assert.equal(s.tileId, b.at(7, 0), 'an idle unit never chases');
});

// ---- Step 6: high ground (D13) ---------------------------------------------

test('high ground: a Crossbow on a hill hits a target 3 tiles away; on plains it does not', () => {
  const shot = (row) => {
    const b = makeBattle({
      rows: [row],
      units: [{ owner: 'Red', type: 'crossbow', at: [4, 0], hold: true }, { owner: 'Blue', type: 'laborer', at: [7, 0], hold: true }],
    });
    return E.stepSim(b.st, 200, { now: 200 }).events.some((e) => e.type === 'underAttack');
  };
  assert.equal(shot('R...h.......B'), true);
  assert.equal(shot('R...........B'), false);
  const map = { width: 5, height: 1, tiles: ['hills', 'plains', 'plains', 'plains', 'hills'] };
  assert.equal(E.effectiveRange(map, { tileId: 0, range: 2 }, 3), 3, 'down from the hill');
  assert.equal(E.effectiveRange(map, { tileId: 2, range: 2 }, 4), 1, 'up at the hill');
  assert.equal(E.effectiveRange(map, { tileId: 0, range: 2 }, 4), 2, 'hill to hill');
  assert.equal(E.effectiveRange(map, { tileId: 1, range: 1 }, 0), 1, 'melee never changes');
});

test('high ground: a ground Crossbow cannot hit a hill target 2 tiles away, but can at 1', () => {
  const shot = (row, at) => {
    const b = makeBattle({
      rows: [row],
      units: [{ owner: 'Red', type: 'crossbow', at: [4, 0], hold: true }, { owner: 'Blue', type: 'laborer', at: [at, 0], hold: true }],
    });
    return E.stepSim(b.st, 200, { now: 200 }).events.some((e) => e.type === 'underAttack' && e.owner === 'Blue');
  };
  assert.equal(shot('R.....h.....B', 6), false);
  assert.equal(shot('R....h......B', 5), true);
});

test('high ground: melee only fights on its own level (Warrior, Battlemage)', () => {
  const clash = (row, redType = 'warrior') => {
    const b = makeBattle({
      rows: [row],
      units: [{ owner: 'Red', type: redType, at: [4, 0], hold: true }, { owner: 'Blue', type: 'militiaman', at: [5, 0], hold: true }],
    });
    const hits = fight(b, 1000).filter((e) => e.type === 'underAttack');
    return { red: hits.some((e) => e.owner === 'Blue'), blue: hits.some((e) => e.owner === 'Red') };
  };
  assert.deepEqual(clash('R....h.....B'), { red: false, blue: false }, 'warrior below, militiaman on the hill');
  assert.deepEqual(clash('R...hh.....B'), { red: true, blue: true }, 'both up on the hill');
  assert.deepEqual(clash('R...h......B'), { red: false, blue: false }, 'warrior on the hill, militiaman below');
  assert.deepEqual(clash('R....h.....B', 'battlemage'), { red: false, blue: false }, 'range 1 = melee rule');
  assert.equal(clash('R...hh.....B', 'battlemage').red, true);
});

// ---- Step 6: under attack (D14) -------------------------------------------

test('under attack: an idle Warrior shot by a Crossbow it cannot reach walks out of range; a holding one stays', () => {
  const setup = (hold) => makeBattle({
    rows: ['R.........B'],
    units: [{ owner: 'Red', type: 'warrior', at: [3, 0], hold }, { owner: 'Blue', type: 'crossbow', at: [5, 0], hold: true }],
  });
  const b = setup(false);
  const w = b.unit('Red');
  w.hp = 100; // tough enough to survive the bolts during its 4.3 s step away
  E.stepSim(b.st, 200, { now: 200 });
  assert.ok(w.hp < 100);
  assert.deepEqual(w.path, [b.at(2, 0)], 'one step west is out of reach');
  const away = E.WF_STEP_MS_BASE + 400;
  fight(b, away, 200);
  const later = fight(b, away + 5000, away).filter((e) => e.type === 'underAttack' && e.owner === 'Red');
  assert.equal(w.tileId, b.at(2, 0));
  assert.equal(w.path.length, 0, 'idle again');
  assert.equal(E.manhattan(w.tileId, b.unit('Blue').tileId, 11), 3);
  assert.deepEqual(later, [], 'no more hits once it left');

  const held = setup(true);
  fight(held, 1000); // one bolt: a second would kill it
  assert.equal(held.unit('Red').tileId, held.at(3, 0));
  assert.deepEqual(held.unit('Red').path, []);
});

test('under attack: a unit that can hit back stays and fights', () => {
  const b = makeBattle({
    rows: ['R.........B'],
    units: [{ owner: 'Red', type: 'warrior', at: [4, 0] }, { owner: 'Blue', type: 'crossbow', at: [5, 0], hold: true }],
  });
  const events = fight(b, 1000);
  assert.deepEqual(b.unit('Red').path, []);
  assert.equal(b.unit('Red').tileId, b.at(4, 0));
  assert.ok(events.some((e) => e.type === 'underAttack' && e.owner === 'Blue'));
});

test('under attack: nowhere to go within fallBackMaxTiles means it stays put', () => {
  const b = makeBattle({
    rows: ['R~~~~~~~~~B', '#~.....~~~#', '#~~~~~~~~~#'],
    units: [{ owner: 'Red', type: 'warrior', at: [4, 1] }, { owner: 'Blue', type: 'skirmisher', at: [6, 1], hold: true }],
  });
  b.st.map.tiles[E.tileId(5, 1, 11)] = 'hills'; // the skirmisher shoots past it; still 2 tiles
  const w = b.unit('Red');
  w.tileId = b.at(4, 1);
  E.stepSim(b.st, 200, { now: 200 });
  // Out of a range-2 shooter's reach within 3 steps along this strip = x <= 3, which is (3,1) or (2,1).
  assert.deepEqual(w.path, [b.at(3, 1)]);
  const boxed = makeBattle({
    rows: ['R~~~~~~~~~B', '#~~~..~~~~#', '#~~~~~~~~~#'],
    units: [{ owner: 'Red', type: 'warrior', at: [4, 1] }, { owner: 'Blue', type: 'skirmisher', at: [5, 1], hold: true }],
  });
  boxed.st.map.tiles[E.tileId(5, 1, 11)] = 'hills';
  E.stepSim(boxed.st, 200, { now: 200 });
  assert.deepEqual(boxed.unit('Red').path, []);
});

test('under attack: a fogged shooter shows in the victim team\'s view for WF_REVEAL_MS, then hides', () => {
  const b = makeBattle({
    rows: ['R....h....B'],
    units: [{ owner: 'Red', type: 'warrior', at: [2, 0] }, { owner: 'Blue', type: 'crossbow', at: [5, 0], hold: true }],
  });
  const xbow = b.unit('Blue');
  b.unit('Red').hp = 100; // survives the bolts while it steps away
  const seen = () => E.viewForPlayer(b.st, 'Red').units.find((u) => u.id === xbow.id);
  assert.equal(seen(), undefined, 'three tiles off: beyond vision');
  E.stepSim(b.st, 200, { now: 200 });
  assert.equal(b.unit('Red').hp < 100, true, 'shot from the hill');
  assert.equal(seen().revealed, true);
  assert.equal(E.viewForPlayer(b.st, 'Red').visible[xbow.tileId], '0', 'the tile itself stays fogged');
  // The warrior falls back out of reach (one 4.3 s step), taking a bolt each second until it's
  // there; the shooter stays revealed until WF_REVEAL_MS after the last one.
  let lastHit = 200;
  const leaves = E.WF_STEP_MS_BASE + 200;
  for (let now = 400; now <= leaves + 200; now += 200) {
    if (E.stepSim(b.st, 200, { now }).events.some((e) => e.type === 'underAttack')) lastHit = now;
  }
  assert.equal(b.unit('Red').tileId, b.at(1, 0));
  const closes = lastHit + E.WF_REVEAL_MS;
  for (let now = leaves + 400; now < closes; now += 200) E.stepSim(b.st, 200, { now });
  assert.ok(seen(), 'still revealed just before the window closes');
  E.stepSim(b.st, 200, { now: closes });
  assert.equal(seen(), undefined);
});

test('hold: stops at the end of the current step, clears any march, and a move clears it', () => {
  const b = makeBattle({ rows: ['R........B'], units: [{ owner: 'Red', type: 'warrior', at: [1, 0] }] });
  const w = b.unit('Red');
  move(b.st, 'Red', [w.id], b.at(6, 0), 0);
  assert.deepEqual(E.applyCommand(b.st, 'Red', { kind: 'hold', unitIds: [w.id] }, 100), { ok: true, held: 1 });
  assert.equal(w.holding, true);
  assert.deepEqual(w.path, [b.at(2, 0)]);
  const t = E.WF_STEP_MS_BASE + 2000;
  fight(b, t, 100);
  assert.equal(w.tileId, b.at(2, 0));
  assert.equal(E.viewForPlayer(b.st, 'Red').units[0].holding, true);
  move(b.st, 'Red', [w.id], b.at(4, 0), t);
  assert.equal(w.holding, false);
  assert.equal(E.applyCommand(b.st, 'Red', { kind: 'hold', unitIds: [] }, 0).ok, false);
  assert.equal(E.applyCommand(b.st, 'Blue', { kind: 'hold', unitIds: [w.id] }, 0).ok, false);
});
