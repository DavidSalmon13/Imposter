'use strict';

// Warfront engine tests: win check and battle stats.
// Exercises server/games/warfront/engine/systems/victory.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const E = require('../../../../server/games/warfront/engine');
const { makeBattle, fight } = require('../fixtures');

test('win: a base at 0 HP ends the match at once; later steps do nothing', () => {
  const b = makeBattle({ rows: ['R........B'], units: [{ owner: 'Red', type: 'warchief', at: [8, 0], hold: true }] });
  b.st.bases.blue.hp = 1;
  const events = fight(b, 200);
  assert.equal(b.st.bases.blue.hp, 0);
  assert.equal(b.st.winner, 'red');
  assert.equal(b.st.clock.endedAt, 200);
  assert.deepEqual(events.find((e) => e.type === 'gameOver'), { type: 'gameOver', winner: 'red', reason: 'base' });

  const tick = b.st.tick;
  const hp = b.unit('Red').hp;
  const after = E.stepSim(b.st, 200, { now: 400 });
  assert.deepEqual(after.events, []);
  assert.equal(b.st.tick, tick, 'no step runs after the match is decided');
  assert.equal(b.unit('Red').hp, hp);
});

test('win: at the match cap the higher base HP wins; equal HP is a draw', () => {
  const b = makeBattle({ rows: ['R........B'] });
  b.st.clock.matchEndsAt = 1000;
  b.st.bases.blue.hp = 80;
  fight(b, 800);
  assert.equal(b.st.winner, null, 'not before the cap');
  const events = fight(b, 1000, 800);
  assert.equal(b.st.winner, 'red');
  assert.equal(b.st.clock.endedAt, 1000);
  assert.ok(events.some((e) => e.type === 'gameOver' && e.reason === 'time' && e.winner === 'red'));

  const blue = makeBattle({ rows: ['R........B'] });
  blue.st.clock.matchEndsAt = 400;
  blue.st.bases.red.hp = 30;
  fight(blue, 400);
  assert.equal(blue.st.winner, 'blue');

  const draw = makeBattle({ rows: ['R........B'] });
  draw.st.clock.matchEndsAt = 400;
  fight(draw, 400);
  assert.equal(draw.st.winner, 'draw');
  assert.equal(E.winnerByBaseHp(draw.st), 'draw');
});

test('win: both bases at 0 HP after the same step is a draw', () => {
  const b = makeBattle({ rows: ['R........B'] });
  b.st.bases.red.hp = 0;
  b.st.bases.blue.hp = 0;
  E.stepSim(b.st, 200, { now: 200 });
  assert.equal(b.st.winner, 'draw');
  assert.deepEqual(E.checkWinner(b.st, 200), { winner: 'draw', reason: 'base' });
});

test('stats: kills go to the hit that drops a unit, losses to its owner, base damage to the attacker', () => {
  const b = makeBattle({
    rows: ['R....B'],
    units: [
      { owner: 'Red', type: 'warchief', at: [2, 0], hold: true },
      { owner: 'Blue', type: 'laborer', at: [3, 0], hold: true },
    ],
  });
  fight(b, 4000);
  assert.equal(b.st.armies.Blue.units.length, 0, 'the Laborer died');
  assert.equal(b.st.armies.Red.stats.kills, 1);
  assert.equal(b.st.armies.Blue.stats.lost, 1);
  assert.equal(b.st.armies.Red.stats.lost, 0);
  assert.equal(b.st.armies.Blue.stats.kills, 0);

  const siege = makeBattle({ rows: ['R........B'], units: [{ owner: 'Red', type: 'raider', at: [8, 0], hold: true }] });
  fight(siege, 3000);
  const dealt = E.TUNING.baseHp - siege.st.bases.blue.hp;
  assert.ok(dealt > 0);
  assert.ok(Math.abs(siege.st.armies.Red.stats.baseDmg - dealt) < 0.011, 'counts what the base lost');
  assert.equal(siege.st.armies.Blue.stats.baseDmg, 0, 'a base hitting back earns nobody base damage');
  assert.equal(siege.st.armies.Blue.stats.kills, 0, 'nor kills');
});

test('stats: base damage stops at 0 HP (overkill is not counted)', () => {
  const b = makeBattle({ rows: ['R........B'], units: [{ owner: 'Red', type: 'warchief', at: [8, 0], hold: true }] });
  b.st.bases.blue.hp = 0.5;
  fight(b, 200);
  assert.equal(b.st.armies.Red.stats.baseDmg, 0.5);
});
