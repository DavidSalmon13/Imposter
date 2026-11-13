'use strict';

// Warfront engine tests: free-for-all knock-outs and placings (spec "Free-for-all mode", plan
// Step 27). Exercises victory.js (stepKnockouts, placeSurvivors), commands.js (an out side is
// refused) and view.js (an out player watches with the fog lifted).

const test = require('node:test');
const assert = require('node:assert/strict');

const E = require('../../../../server/games/warfront/engine');
const { makeBattle, plantBuilt } = require('../fixtures');

const THREE = ['R.......B', '.........', '.........', 'G........'];
const FOUR = ['R.......B', '.........', '.........', 'G.......Y'];

const step = (b, now) => E.stepSim(b.st, 200, { now }).events;
const places = (st) => Object.fromEntries(st.placings.map((p) => [p.side, p.place]));

test('knock-out: a fallen side crumbles, the match goes on, its lighthouse goes neutral', () => {
  const b = makeBattle({ rows: THREE, units: [
    { owner: 'Blue', type: 'laborer', at: [7, 1] },
    { owner: 'Blue', type: 'militiaman', at: [6, 2], hold: true },
    { owner: 'Red', type: 'warrior', at: [1, 1], hold: true },
    { owner: 'Green', type: 'apprentice', at: [0, 2], hold: true },
  ] });
  plantBuilt(b, 'Blue', 'tower', 8, 2);
  b.unit('Blue', 0).carrying = 3; // a loaded hauler: its cargo is lost, not dropped
  b.st.lighthouses = [{ tileId: b.at(4, 1), team: 'blue' }, { tileId: b.at(4, 2), team: 'red' }];
  b.st.armies.Blue.queues = { [b.at(8, 0)]: [{ unitType: 'militiaman', doneAt: 99999 }] };
  b.st.bases.blue.hp = 0;

  const events = step(b, 200);
  assert.equal(b.st.winner, null, 'red and green are still standing');
  assert.deepEqual(b.st.armies.Blue.units, []);
  assert.deepEqual(b.st.armies.Blue.facilities, []);
  assert.deepEqual(b.st.armies.Blue.queues, {});
  const deaths = events.filter((e) => e.type === 'death');
  assert.equal(deaths.length, 3);
  assert.ok(deaths.every((e) => e.owner === 'Blue' && e.team === 'blue' && e.crumbled));
  assert.deepEqual(b.st.pickups.mineralDrops, {}, 'no Mineral drops');
  assert.deepEqual(b.st.lighthouses.map((l) => l.team), [null, 'red']);
  assert.ok(!events.some((e) => e.type === 'lighthouse'), 'going neutral is not a capture');
  assert.deepEqual(events.find((e) => e.type === 'knockedOut'), { type: 'knockedOut', team: 'blue', place: 3 });
  assert.deepEqual(b.st.placings, [{ side: 'blue', place: 3 }]);
  // The other sides keep their armies.
  assert.equal(b.st.armies.Red.units.length, 1);
  assert.equal(b.st.armies.Green.units.length, 1);
  // Later steps don't knock blue out again.
  assert.ok(!step(b, 400).some((e) => e.type === 'knockedOut'));
  assert.equal(b.st.placings.length, 1);
});

test('knock-out: an out player can no longer command; the others still can', () => {
  const b = makeBattle({ rows: THREE, units: [{ owner: 'Red', type: 'warrior', at: [1, 1] }] });
  b.st.armies.Blue.arsenal = ['aegis'];
  b.st.bases.blue.hp = 0;
  step(b, 200);
  for (const cmd of [
    { kind: 'produce', unitType: 'militiaman', atTileId: b.at(8, 0) },
    { kind: 'weapon', weaponId: 'aegis', targetTileId: b.at(8, 0) },
    { kind: 'hold', unitIds: [1] },
  ]) {
    const res = E.applyCommand(b.st, 'Blue', cmd, 200);
    assert.equal(res.ok, false);
    assert.match(res.error, /out of this battle/);
  }
  assert.deepEqual(b.st.armies.Blue.arsenal, ['aegis'], 'nothing spent');
  assert.equal(E.applyCommand(b.st, 'Red', { kind: 'hold', unitIds: [b.unit('Red').id] }, 200).ok, true);
});

test('knock-out: an out player watches with the fog lifted and hears every event', () => {
  const b = makeBattle({ rows: THREE, units: [
    { owner: 'Red', type: 'warrior', at: [3, 3], hold: true },
    { owner: 'Green', type: 'warrior', at: [8, 3], hold: true },
  ] });
  b.st.bases.blue.hp = 0;
  const events = step(b, 200);

  const blue = E.viewForPlayer(b.st, 'Blue');
  assert.equal(blue.out, true);
  assert.equal(blue.visible, '1'.repeat(36));
  assert.deepEqual(blue.units.map((u) => u.owner).sort(), ['Green', 'Red']);
  assert.ok(blue.units.every((u) => !u.path), "no one's route is shown, only where they stand");

  const red = E.viewForPlayer(b.st, 'Red');
  assert.equal(red.out, undefined);
  assert.ok(!red.units.some((u) => u.owner === 'Green'), 'a standing side keeps its fog');

  const far = { type: 'underAttack', team: 'green', owner: 'Green', tileId: b.at(8, 3) };
  assert.deepEqual(E.eventsForPlayer(b.st, 'Blue', [far]), [far]);
  assert.deepEqual(E.eventsForPlayer(b.st, 'Red', [far]), []);
  // Everyone hears that a side is out.
  assert.ok(E.eventsForPlayer(b.st, 'Red', events).some((e) => e.type === 'knockedOut'));
});

test('placings: the last side standing wins; the final board is left as it stands', () => {
  const b = makeBattle({ rows: THREE, units: [{ owner: 'Green', type: 'warrior', at: [0, 2], hold: true }] });
  b.st.bases.blue.hp = 0;
  step(b, 200);
  b.st.bases.green.hp = 0;
  const events = step(b, 400);
  assert.equal(b.st.winner, 'red');
  assert.deepEqual(places(b.st), { blue: 3, green: 2, red: 1 });
  assert.equal(b.st.armies.Green.units.length, 1, 'no crumbling once the match is over');
  assert.ok(events.some((e) => e.type === 'knockedOut' && e.team === 'green' && e.place === 2));
});

test('placings: sides falling in the same step share a place; the last ones together share 1st (a draw)', () => {
  const b = makeBattle({ rows: FOUR });
  b.st.bases.blue.hp = 0;
  b.st.bases.gold.hp = 0;
  step(b, 200);
  assert.equal(b.st.winner, null);
  assert.deepEqual(places(b.st), { blue: 3, gold: 3 });
  b.st.bases.red.hp = 0;
  b.st.bases.green.hp = 0;
  step(b, 400);
  assert.equal(b.st.winner, 'draw');
  assert.deepEqual(places(b.st), { blue: 3, gold: 3, red: 1, green: 1 });
});

test('placings: at the match cap survivors are ranked by base HP (equal HP share a place)', () => {
  const b = makeBattle({ rows: FOUR });
  b.st.bases.gold.hp = 0;
  step(b, 200);
  Object.assign(b.st.bases.red, { hp: 50 });
  Object.assign(b.st.bases.blue, { hp: 80 });
  Object.assign(b.st.bases.green, { hp: 50 });
  b.st.clock.matchEndsAt = 400;
  step(b, 400);
  assert.equal(b.st.winner, 'blue');
  assert.deepEqual(places(b.st), { gold: 4, blue: 1, red: 2, green: 2 });
  assert.deepEqual(E.finalView(b.st).placings, b.st.placings);
});

test('placings: a team battle places both sides and leaves the loser on the board', () => {
  const b = makeBattle({ rows: ['R.......B'], units: [{ owner: 'Blue', type: 'warrior', at: [6, 0], hold: true }] });
  b.st.bases.blue.hp = 0;
  step(b, 200);
  assert.equal(b.st.winner, 'red');
  assert.deepEqual(places(b.st), { blue: 2, red: 1 });
  assert.equal(b.st.armies.Blue.units.length, 1);
});
