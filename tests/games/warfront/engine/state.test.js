'use strict';

// Warfront engine tests: createBattleState.
// Exercises server/games/warfront/engine/state.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const E = require('../../../../server/games/warfront/engine');
const { rngFor } = require('../../../../server/lib/rng');

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
