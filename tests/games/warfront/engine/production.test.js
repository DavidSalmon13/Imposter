'use strict';

// Warfront engine tests: produce orders and queues.
// Exercises server/games/warfront/engine/systems/production.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const E = require('../../../../server/games/warfront/engine');
const { makeBattle, run, produce } = require('../fixtures');

test('produce: debits Supply now (and Minerals for advanced units), spawns after buildMsPerCost × cost', () => {
  const b = makeBattle({ rows: ['R.....B'] });
  const red = b.st.armies.Red;
  red.supply = 5;
  red.minerals = 1;
  const base = b.at(0, 0);
  assert.equal(produce(b.st, 'Red', 'raider', 0).ok, false, 'a Raider needs 2 Minerals');
  assert.equal(red.supply, 5);
  red.minerals = 2;
  assert.equal(produce(b.st, 'Red', 'raider', 0, base).ok, true);
  assert.equal(red.supply, 0);
  assert.equal(red.minerals, 0);
  assert.equal(produce(b.st, 'Red', 'warrior', 0).ok, false, 'out of Supply');
  assert.deepEqual(red.queues[base], [{ unitType: 'raider', doneAt: 5 * E.TUNING.buildMsPerCost }]);
  const events = [];
  run(b.st, 0, 5 * E.TUNING.buildMsPerCost - 200);
  assert.equal(red.units.length, 0, 'not yet');
  events.push(...E.stepSim(b.st, 200, { now: 5 * E.TUNING.buildMsPerCost }).events);
  assert.equal(red.units.length, 1);
  assert.equal(red.units[0].type, 'raider');
  assert.equal(red.units[0].tileId, base);
  assert.deepEqual(red.queues, {});
  assert.ok(events.some((e) => e.type === 'spawn' && e.owner === 'Red' && e.unitType === 'raider' && e.tileId === base));
  // Basic units cost Supply only.
  red.supply = 3;
  red.minerals = 0;
  assert.equal(produce(b.st, 'Red', 'warrior', 6000).ok, true);
  assert.equal(red.supply, 0);
});

test('produce: each spawn point builds one unit at a time (sequential queue)', () => {
  const b = makeBattle({ rows: ['R.....B'] });
  const red = b.st.armies.Red;
  red.supply = 20;
  const T = 3 * E.TUNING.buildMsPerCost; // a Warrior
  assert.equal(produce(b.st, 'Red', 'warrior', 0).ok, true);
  assert.equal(produce(b.st, 'Red', 'warrior', 0).ok, true);
  assert.deepEqual(red.queues[b.at(0, 0)].map((q) => q.doneAt), [T, 2 * T]);
  run(b.st, 0, T);
  assert.equal(red.units.length, 1);
  run(b.st, T, 2 * T - 200);
  assert.equal(red.units.length, 1, 'the second starts only when the first is done');
  run(b.st, 2 * T - 200, 2 * T);
  assert.equal(red.units.length, 2);
  // Ordered into an empty queue later, a unit's timer starts then, not back at the last finish.
  run(b.st, 2 * T, 10 * T);
  assert.equal(produce(b.st, 'Red', 'warrior', 10 * T).ok, true);
  assert.equal(red.queues[b.at(0, 0)][0].doneAt, 11 * T);
});

test('produce: another race\'s unit, a Golem, an unknown type or a foreign tile is a no-op', () => {
  const b = makeBattle({ rows: ['R.....B'] });
  const red = b.st.armies.Red; // Horde
  red.supply = 50;
  red.minerals = 50;
  for (const unitType of ['militiaman', 'apprentice', 'golem', 'dragon']) {
    assert.equal(produce(b.st, 'Red', unitType, 0).ok, false, unitType);
  }
  assert.equal(produce(b.st, 'Red', 'warrior', 0, b.at(3, 0)).ok, false, 'not a spawn point');
  assert.equal(produce(b.st, 'Red', 'warrior', 0, b.at(6, 0)).ok, false, 'the enemy base');
  assert.equal(red.supply, 50);
  assert.equal(red.minerals, 50);
  assert.deepEqual(red.queues, {});
});

test('produce: the unit cap counts units and queued orders; a Summoner needs room for its Golem (D12)', () => {
  const b = makeBattle({ rows: ['R.....B'], races: { Red: 'arcane' } });
  const red = b.st.armies.Red;
  red.supply = 500;
  red.minerals = 500;
  for (let i = 0; i < E.WF_MAX_UNITS_PER_PLAYER - 2; i++) red.units.push(E.makeUnit(b.st.nextUnitId++, 'apprentice', 'Red', b.at(0, 0)));
  assert.equal(produce(b.st, 'Red', 'apprentice', 0).ok, true, '29 of 30');
  assert.equal(produce(b.st, 'Red', 'summoner', 0).ok, false, 'Summoner + Golem would make 31');
  assert.equal(produce(b.st, 'Red', 'apprentice', 0).ok, true, '30 of 30');
  const before = red.supply;
  assert.equal(produce(b.st, 'Red', 'acolyte', 0).ok, false, 'at the cap');
  assert.equal(red.supply, before);
});

test('produce: a Summoner also brings a Golem to the base', () => {
  const b = makeBattle({ rows: ['R.....B'], races: { Red: 'arcane' } });
  const red = b.st.armies.Red;
  red.supply = 6;
  red.minerals = 4;
  assert.equal(produce(b.st, 'Red', 'summoner', 0).ok, true);
  const events = [];
  for (let now = 200; now <= 6 * E.TUNING.buildMsPerCost; now += 200) events.push(...E.stepSim(b.st, 200, { now }).events);
  assert.deepEqual(red.units.map((u) => u.type).sort(), ['golem', 'summoner']);
  assert.ok(red.units.every((u) => u.tileId === b.at(0, 0)));
  assert.deepEqual(events.filter((e) => e.type === 'spawn').map((e) => e.unitType), ['summoner', 'golem']);
});
