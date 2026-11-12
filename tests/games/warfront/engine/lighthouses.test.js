'use strict';

// Warfront engine tests: lighthouses (D15).
// Exercises server/games/warfront/engine/systems/lighthouses.js (+ its mapgen.js and vision.js parts).

const test = require('node:test');
const assert = require('node:assert/strict');

const E = require('../../../../server/games/warfront/engine');
const { rngFor } = require('../../../../server/lib/rng');
const { rawMap, SIZE, setTerrain, assertRejects, fight, lightBattle } = require('../fixtures');

test('lighthouses: validateMap marks the home ones with their team and the others neutral', () => {
  const map = E.validateMap(rawMap(), SIZE);
  assert.deepEqual(map.lighthouses.map((l) => [l.x, l.y, l.team]), [[2, 1, 'red'], [6, 1, 'blue'], [4, 3, null]]);
  assert.equal(map.lighthouses[0].tileId, E.tileId(2, 1, 9));
});

test('lighthouses: validateMap rejects bad placements', () => {
  assertRejects(rawMap({ lighthouses: [{ x: 2, y: 1 }] }), /2 to 4 lighthouses/);
  assertRejects(rawMap({ lighthouses: undefined }), /2 to 4 lighthouses/);
  assertRejects(rawMap({ lighthouses: [{ x: 2, y: 1 }, { x: 6, y: 1 }, { x: 4, y: 3 }, { x: 4, y: 1 }, { x: 3, y: 4 }] }), /2 to 4 lighthouses/);
  // None near the blue base: (4,1) is the contested middle, not blue's.
  assertRejects(rawMap({ lighthouses: [{ x: 2, y: 1 }, { x: 4, y: 1 }] }), /blue base needs a lighthouse/);
  // Two near the red base.
  assertRejects(rawMap({ lighthouses: [{ x: 2, y: 1 }, { x: 1, y: 3 }, { x: 6, y: 1 }] }), /red base has more than one lighthouse/);
  // A blue-side lighthouse within 4 of red doesn't count as red's home (wrong half).
  const wide = rawMap({ lighthouses: [{ x: 6, y: 1 }, { x: 5, y: 2 }] });
  assertRejects(wide, /red base needs a lighthouse/);
  // An unfair extra: much closer to red than to blue, and not part of a mirrored pair
  // (on a 13-wide map, where a spot can be far from both bases yet lopsided).
  const wideMap = (lighthouses) => rawMap({
    width: 13,
    tiles: Array.from({ length: 13 * 5 }, () => ({ terrain: 'plains' })),
    bases: [{ team: 'red', x: 0, y: 2 }, { team: 'blue', x: 12, y: 2 }],
    supplySources: [{ x: 1, y: 2 }, { x: 11, y: 2 }],
    veins: [{ x: 6, y: 0, richness: 2, contested: true }],
    weapons: [],
    chokepoints: [],
    lighthouses,
  });
  const W13 = { width: 13, height: 5 };
  assert.throws(() => E.validateMap(wideMap([{ x: 2, y: 1 }, { x: 10, y: 1 }, { x: 4, y: 4 }]), W13), /\(4,4\) is not fair/);
  // ... but as a mirrored pair it is fine.
  const pair = E.validateMap(wideMap([{ x: 2, y: 1 }, { x: 10, y: 1 }, { x: 4, y: 4 }, { x: 8, y: 4 }]), W13);
  assert.equal(pair.lighthouses.length, 4);
  assert.deepEqual(pair.lighthouses.map((l) => l.team), ['red', 'blue', null, null]);
  // On water, or on another feature.
  const wet = rawMap();
  setTerrain(wet, 4, 3, 'water');
  assertRejects(wet, /lighthouse at \(4,3\) is on impassable terrain/);
  assertRejects(rawMap({ lighthouses: [{ x: 2, y: 1 }, { x: 6, y: 1 }, { x: 4, y: 0 }] }), /shares a tile/);
  // Unreachable.
  const walled = rawMap({ lighthouses: [{ x: 2, y: 1 }, { x: 6, y: 1 }, { x: 4, y: 3 }] });
  for (const [x, y] of [[3, 3], [5, 3], [3, 4], [5, 4], [4, 2]]) setTerrain(walled, x, y, 'rock');
  walled.weapons = [];
  walled.chokepoints = [];
  assertRejects(walled, /lighthouse at \(4,3\) is unreachable/);
});

test('lighthouses: fallback maps carry valid ones across seeds and sizes', () => {
  for (const size of ['small', 'medium', 'large']) {
    let withPair = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const map = E.buildFallbackMap(size, rngFor(seed, 0));
      assert.ok(map.lighthouses.length >= 2 && map.lighthouses.length <= E.MAX_LIGHTHOUSES, `${size} ${seed}`);
      assert.deepEqual(map.lighthouses.filter((l) => l.team).map((l) => l.team).sort(), ['blue', 'red']);
      if (map.lighthouses.length === 4) withPair++;
      // Validation is idempotent on its own output.
      assert.doesNotThrow(() => E.validateMap({ ...map, tiles: map.tiles.map((t) => ({ terrain: t })) }, size));
    }
    assert.ok(withPair >= 90, `${size}: a mirrored contested pair on almost every map (${withPair}/100)`);
  }
});

test('lighthouses: createBattleState starts home ones owned and contested ones neutral', () => {
  const map = E.validateMap(rawMap(), SIZE);
  const st = E.createBattleState(map, [{ name: 'A', team: 'red', race: 'horde' }, { name: 'B', team: 'blue', race: 'forge' }], { seed: 1, now: 0 });
  assert.deepEqual(st.lighthouses, [
    { tileId: E.tileId(2, 1, 9), team: 'red' },
    { tileId: E.tileId(6, 1, 9), team: 'blue' },
    { tileId: E.tileId(4, 3, 9), team: null },
  ]);
});

test('lighthouses: one team alone on it captures it at once; contested or empty, no change', () => {
  const b = lightBattle({ rows: ['R...........B'], lights: [[6, 0, null]] });
  const runner = E.makeUnit(b.st.nextUnitId++, 'raider', 'Red', b.at(5, 0));
  b.st.armies.Red.units.push(runner);
  // Nobody there yet.
  assert.equal(fight(b, 200).filter((e) => e.type === 'lighthouse').length, 0);
  assert.equal(b.st.lighthouses[0].team, null);
  // Red steps on: flips to red, once.
  runner.tileId = b.at(6, 0);
  const ev = fight(b, 400, 200).filter((e) => e.type === 'lighthouse');
  assert.deepEqual(ev, [{ type: 'lighthouse', tileId: b.at(6, 0), team: 'red' }]);
  assert.equal(fight(b, 600, 400).filter((e) => e.type === 'lighthouse').length, 0, 'no repeat event');
  // Blue joins: contested, red keeps it.
  const blue = E.makeUnit(b.st.nextUnitId++, 'bastion', 'Blue', b.at(6, 0));
  b.st.armies.Blue.units.push(blue);
  runner.holding = true;
  E.stepSim(b.st, 200, { now: 800 });
  assert.equal(b.st.lighthouses[0].team, 'red');
  // Red leaves: blue alone takes it.
  b.st.armies.Red.units = [];
  E.stepSim(b.st, 200, { now: 1000 });
  assert.equal(b.st.lighthouses[0].team, 'blue');
  // Blue leaves: empty, stays blue (never back to neutral).
  b.st.armies.Blue.units = [];
  E.stepSim(b.st, 200, { now: 1200 });
  assert.equal(b.st.lighthouses[0].team, 'blue');
});

test('lighthouses: an owned one gives vision radius 5; an enemy or neutral one gives none', () => {
  const rows = ['R...................', '....................', '....................', '....................', '....................', '....................', '....................', '...................B'];
  const b = lightBattle({ rows, lights: [[10, 4, 'red'], [16, 1, 'blue'], [4, 6, null]] });
  const red = E.visionFor(b.st, 'red');
  const lh = b.at(10, 4);
  for (let id = 0; id < 20 * 8; id++) {
    const d = E.manhattan(id, lh, 20);
    if (d <= 5) assert.ok(red.has(id), `tile ${id} at ${d} should be seen`);
  }
  assert.ok(!red.has(b.at(16, 0)) && !red.has(b.at(18, 2)), 'blue\'s lighthouse gives red nothing');
  assert.ok(!red.has(b.at(4, 6)) && !red.has(b.at(3, 7)), 'a neutral one gives no view round itself');
  const blue = E.visionFor(b.st, 'blue');
  assert.ok(blue.has(b.at(16, 6)) && blue.has(b.at(11, 1)), 'blue sees round its own');
  assert.ok(!blue.has(b.at(10, 4)), 'blue gets nothing from red\'s lighthouse');
  // An enemy inside the lighthouse's radius shows up in the fogged view; owners are public.
  b.st.armies.Blue.units.push(E.makeUnit(b.st.nextUnitId++, 'warrior', 'Blue', b.at(13, 6)));
  const view = E.viewForPlayer(b.st, 'Red');
  assert.ok(view.units.some((u) => u.owner === 'Blue'));
  assert.deepEqual(view.lighthouses.map((l) => l.team), ['red', 'blue', null]);
  assert.deepEqual(E.viewForPlayer(b.st, 'Blue').lighthouses.map((l) => l.team), ['red', 'blue', null]);
});

test('lighthouses: a flip reaches every player, even ones who can\'t see the tile', () => {
  const b = lightBattle({ rows: ['R...........B'], lights: [[6, 0, null]] });
  b.st.armies.Red.units.push(E.makeUnit(b.st.nextUnitId++, 'raider', 'Red', b.at(6, 0)));
  const { events } = E.stepSim(b.st, 200, { now: 200 });
  assert.ok(!E.visionFor(b.st, 'blue').has(b.at(6, 0)));
  assert.ok(E.eventsForPlayer(b.st, 'Blue', events).some((e) => e.type === 'lighthouse' && e.team === 'red'));
});

test('lighthouses: a fallback contested pair is never side by side', () => {
  for (const size of ['small', 'medium', 'large']) {
    for (let seed = 1; seed <= 100; seed++) {
      const map = E.buildFallbackMap(size, rngFor(seed, 0));
      const extras = map.lighthouses.filter((l) => !l.team);
      if (extras.length === 2) assert.ok(Math.abs(extras[0].x - extras[1].x) >= 3, `${size} ${seed}`);
    }
  }
});

test('lighthouses: fallback maps keep them out of the top row (the tower would be clipped)', () => {
  for (const size of ['small', 'medium', 'large']) {
    for (let seed = 1; seed <= 100; seed++) {
      const map = E.buildFallbackMap(size, rngFor(seed, 0));
      assert.ok(map.lighthouses.every((l) => l.y >= 1), `${size} ${seed}`);
    }
  }
});
