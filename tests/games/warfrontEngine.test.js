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
