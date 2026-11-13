'use strict';

// Warfront engine tests: battles with more than two sides (spec "Free-for-all mode", plan Step 25).
// Exercises state.js (bases per side), combat.js (every other side is an enemy), vision.js,
// weapons.js (Bombard at any enemy base) and victory.js (last side standing).

const test = require('node:test');
const assert = require('node:assert/strict');

const E = require('../../../../server/games/warfront/engine');
const { makeBattle, fight } = require('../fixtures');

const ROWS = ['R.......B', '.........', '.........', 'G.......Y'];

test('sides: a four-side battle has a base and an army per side', () => {
  const b = makeBattle({ rows: ROWS });
  assert.deepEqual(Object.keys(b.st.bases), ['red', 'blue', 'green', 'gold']);
  assert.deepEqual(Object.values(b.st.armies).map((a) => a.team), ['red', 'blue', 'green', 'gold']);
  assert.throws(() => E.createBattleState(b.st.map, [{ name: 'X', team: 'purple', race: 'horde' }], { seed: 1, now: 0 }), /unknown team/);
});

test('sides: a unit fights every other side, never its own', () => {
  for (const foe of ['Blue', 'Green', 'Gold']) {
    const b = makeBattle({ rows: ROWS, units: [
      { owner: 'Red', type: 'warchief', at: [4, 1], hold: true },
      { owner: foe, type: 'warrior', at: [4, 2], hold: true },
    ] });
    const hits = fight(b, 4000).filter((e) => e.type === 'underAttack');
    assert.ok(hits.some((e) => e.owner === foe), `${foe} gets hit`);
    assert.ok(hits.some((e) => e.owner === 'Red'), `${foe} hits back`);
  }
  // Two units of one side side by side never touch each other.
  const b = makeBattle({ rows: ROWS, units: [
    { owner: 'Green', type: 'warchief', at: [4, 1], hold: true },
    { owner: 'Green', type: 'warrior', at: [4, 2], hold: true },
  ] });
  assert.equal(fight(b, 4000).filter((e) => e.type === 'underAttack').length, 0);
});

test('sides: vision is per side', () => {
  const b = makeBattle({ rows: ROWS, units: [{ owner: 'Green', type: 'warrior', at: [0, 2] }] });
  const green = E.visionFor(b.st, 'green');
  assert.ok(green.has(b.at(0, 3)) && green.has(b.at(0, 2)));
  assert.ok(!green.has(b.at(8, 0)), "green doesn't see blue's corner");
  assert.ok(!E.visionFor(b.st, 'red').has(b.at(8, 3)));
});

test('sides: Bombard hits whichever enemy base it is aimed at', () => {
  const b = makeBattle({ rows: ROWS });
  b.st.armies.Red.arsenal = ['bombard', 'bombard', 'bombard'];
  const fire = (tile) => E.applyCommand(b.st, 'Red', { kind: 'weapon', weaponId: 'bombard', targetTileId: tile }, 0);
  assert.equal(fire(b.at(0, 0)).ok, false, 'not your own base');
  assert.equal(fire(b.at(4, 1)).ok, false, 'only a base');
  assert.equal(fire(b.at(0, 3)).ok, true);
  assert.equal(b.st.bases.green.hp, E.TUNING.baseHp - E.TUNING.bombardDmg);
  assert.equal(b.st.bases.blue.hp, E.TUNING.baseHp);
  assert.equal(fire(b.at(8, 3)).ok, true);
  assert.equal(b.st.bases.gold.hp, E.TUNING.baseHp - E.TUNING.bombardDmg);
});

test('sides: one base falling does not end a three-side match; the last side standing wins', () => {
  const b = makeBattle({ rows: ['R.......B', '.........', 'G........'] });
  b.st.bases.blue.hp = 0;
  E.stepSim(b.st, 200, { now: 200 });
  assert.equal(b.st.winner, null, 'red and green are still standing');
  b.st.bases.green.hp = 0;
  const { events } = E.stepSim(b.st, 200, { now: 400 });
  assert.equal(b.st.winner, 'red');
  assert.deepEqual(events.find((e) => e.type === 'gameOver'), { type: 'gameOver', winner: 'red', reason: 'base' });
});

test('sides: at the match cap the standing side with the most base HP wins; a shared top is a draw', () => {
  const capped = (hp) => {
    const b = makeBattle({ rows: ['R.......B', '.........', 'G........'] });
    Object.assign(b.st.bases.red, { hp: hp[0] });
    Object.assign(b.st.bases.blue, { hp: hp[1] });
    Object.assign(b.st.bases.green, { hp: hp[2] });
    b.st.clock.matchEndsAt = 200;
    E.stepSim(b.st, 200, { now: 200 });
    return b.st.winner;
  };
  assert.equal(capped([50, 90, 70]), 'blue');
  assert.equal(capped([90, 90, 70]), 'draw');
  assert.equal(capped([90, 0, 100]), 'green');
});
