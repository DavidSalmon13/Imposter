'use strict';

// Warfront engine tests: firing special weapons (artillery, emp, airdrop, bombard, aegis).
// Exercises server/games/warfront/engine/systems/weapons.js (+ the EMP pauses in facilities,
// production, economy and combat). Spec: "Special weapons"; plan Step 10.

const test = require('node:test');
const assert = require('node:assert/strict');

const E = require('../../../../server/games/warfront/engine');
const { TUNING, WF_MAX_UNITS_PER_PLAYER } = require('../../../../server/games/warfront/engine/constants');
const { makeBattle, run, plantBuilt, produce } = require('../fixtures');

const fire = (st, owner, weaponId, targetTileId, now = 0) => E.applyCommand(st, owner, { kind: 'weapon', weaponId, targetTileId }, now);

// Red's base on the left, Blue's on the right; 12 tiles apart so neither sees the other.
const ROWS = ['............', 'R..........B', '............'];

function armed(b, owner, ...weapons) {
  b.st.armies[owner].arsenal.push(...weapons);
  return b;
}

test('weapon: needs the weapon in your arsenal; unknown ids and off-map aims change nothing', () => {
  const b = makeBattle({ rows: ROWS });
  assert.equal(fire(b.st, 'Red', 'artillery', b.at(5, 1)).ok, false, 'empty arsenal');
  assert.equal(fire(b.st, 'Red', 'nuke', b.at(5, 1)).ok, false);
  armed(b, 'Red', 'artillery');
  assert.equal(fire(b.st, 'Red', 'artillery', 999).ok, false, 'off the map');
  assert.equal(fire(b.st, 'Red', 'artillery', 'x').ok, false);
  assert.deepEqual(b.st.armies.Red.arsenal, ['artillery'], 'a refused shot keeps the weapon');
});

test('artillery: hits every enemy on the tile (fogged is fine), through terrain and structure defense', () => {
  const b = makeBattle({
    rows: ['............', 'R.......f..B', '............'],
    units: [
      { owner: 'Blue', type: 'militiaman', at: [8, 1] },
      { owner: 'Blue', type: 'crossbow', at: [8, 1] },
      { owner: 'Blue', type: 'militiaman', at: [9, 1] }, // next tile: untouched
    ],
  });
  armed(b, 'Red', 'artillery');
  const [m, c, other] = b.st.armies.Blue.units;
  const hp = [m.hp, c.hp, other.hp];
  assert.ok(!E.visionFor(b.st, 'red').has(b.at(8, 1)), 'the target is in the fog');
  const res = fire(b.st, 'Red', 'artillery', b.at(8, 1), 100);
  assert.equal(res.ok, true);
  assert.equal(res.hits, 2);
  const dmg = Math.round((TUNING.artilleryDmg / 1.25) * 100) / 100; // forest defense ×1.25
  assert.equal(m.hp, hp[0] - dmg);
  assert.equal(c.hp, hp[1] - dmg);
  assert.equal(other.hp, hp[2]);
  assert.deepEqual(b.st.armies.Red.arsenal, [], 'one-shot');
  // Its events go out with the next sim step.
  const { events } = E.stepSim(b.st, 200, { now: 200 });
  const shot = events.find((e) => e.type === 'weapon');
  assert.equal(shot.weaponId, 'artillery');
  assert.equal(shot.tileId, b.at(8, 1));
  assert.equal(events.filter((e) => e.type === 'underAttack' && e.by === 'artillery').length, 2);
  assert.equal(b.st.pendingEvents.length, 0);
});

test('artillery: whiffs on an empty tile but is still used up', () => {
  const b = makeBattle({ rows: ROWS, units: [{ owner: 'Red', type: 'warrior', at: [5, 1] }] });
  armed(b, 'Red', 'artillery');
  const w = b.unit('Red');
  const hp = w.hp;
  const res = fire(b.st, 'Red', 'artillery', b.at(5, 1));
  assert.equal(res.ok, true);
  assert.equal(res.hits, 0, 'your own units are never hit');
  assert.equal(w.hp, hp);
  assert.deepEqual(b.st.armies.Red.arsenal, []);
});

test('artillery: a Tower takes reduced damage, its roof garrison none; a kill counts and drops the garrison', () => {
  const b = makeBattle({ rows: ROWS, units: [{ owner: 'Blue', type: 'crossbow', at: [8, 1] }] });
  const tower = plantBuilt(b, 'Blue', 'tower', 8, 1);
  const g = b.unit('Blue');
  g.garrison = tower.id;
  const gHp = g.hp;
  armed(b, 'Red', 'artillery', 'artillery');
  const towerHp = tower.hp;
  fire(b.st, 'Red', 'artillery', b.at(8, 1));
  const dmg = Math.round((TUNING.artilleryDmg / TUNING.structureDefense) * 100) / 100;
  assert.equal(tower.hp, towerHp - dmg);
  assert.equal(g.hp, gHp, 'units on the roof are untouchable');
  tower.hp = 1;
  fire(b.st, 'Red', 'artillery', b.at(8, 1));
  assert.ok(tower.hp <= 0);
  assert.equal(b.st.armies.Red.stats.kills, 1);
  assert.equal(g.garrison, null, 'the garrison drops');
  assert.ok(g.hp < gHp && g.hp >= 1, 'hurt by the fall, never killed by it');
  E.stepSim(b.st, 200, { now: 200 });
  assert.ok(!b.st.armies.Blue.units.includes(tower), 'cleared like any other kill');
});

test('emp: refused on a fogged tile or one without an enemy building', () => {
  const b = makeBattle({ rows: ROWS, units: [{ owner: 'Red', type: 'warrior', at: [6, 1] }] });
  plantBuilt(b, 'Blue', 'tower', 10, 1); // 4 tiles from the warrior: fogged
  plantBuilt(b, 'Red', 'tower', 5, 1);
  armed(b, 'Red', 'emp');
  assert.equal(fire(b.st, 'Red', 'emp', b.at(10, 1)).ok, false, 'in the fog');
  assert.equal(fire(b.st, 'Red', 'emp', b.at(7, 1)).ok, false, 'nothing there');
  assert.equal(fire(b.st, 'Red', 'emp', b.at(5, 1)).ok, false, 'your own building');
  assert.deepEqual(b.st.armies.Red.arsenal, ['emp']);
});

test('emp: a Tower stops shooting for empMs, then fires again', () => {
  const b = makeBattle({ rows: ROWS, units: [{ owner: 'Red', type: 'peon', at: [7, 1], hold: true }] });
  const tower = plantBuilt(b, 'Blue', 'tower', 8, 1);
  armed(b, 'Red', 'emp');
  const p = b.unit('Red');
  p.atkReadyAt = Infinity; // the Peon doesn't fight back, so only the Tower's fire matters
  const hp = p.hp;
  assert.equal(fire(b.st, 'Red', 'emp', b.at(8, 1), 0).ok, true);
  assert.equal(tower.disabledUntil, TUNING.empMs);
  run(b.st, 0, TUNING.empMs - 200);
  assert.equal(p.hp, hp, 'not a shot while switched off');
  assert.equal(E.viewForPlayer(b.st, 'Red').units.find((u) => u.id === tower.id).disabledUntil, TUNING.empMs, 'everyone in sight sees it');
  run(b.st, TUNING.empMs - 200, TUNING.empMs + 2000);
  assert.ok(p.hp < hp, 'back on');
});

test('emp: a Refinery is no deposit and gives no bonus; a Barracks is no spawn point and holds its queue', () => {
  const b = makeBattle({ rows: ROWS, units: [{ owner: 'Red', type: 'warrior', at: [6, 1] }] });
  const ref = plantBuilt(b, 'Blue', 'refinery', 7, 0);
  const bar = plantBuilt(b, 'Blue', 'barracks', 7, 2);
  const blue = b.st.armies.Blue;
  blue.supply = 100;
  assert.equal(produce(b.st, 'Blue', 'militiaman', 0, bar.tileId).ok, true);
  const doneAt = blue.queues[bar.tileId][0].doneAt;
  armed(b, 'Red', 'emp', 'emp');
  fire(b.st, 'Red', 'emp', ref.tileId, 0);
  fire(b.st, 'Red', 'emp', bar.tileId, 0);
  assert.deepEqual(E.depositTiles(b.st, blue, 100), [b.at(11, 1)], 'only the base');
  assert.deepEqual(E.spawnPoints(b.st, blue, 100), [b.at(11, 1)]);
  assert.equal(produce(b.st, 'Blue', 'militiaman', 100, bar.tileId).ok, false);
  b.unit('Red').atkReadyAt = Infinity; // keep the warrior from wrecking the buildings
  run(b.st, 0, doneAt + 400);
  assert.equal(blue.units.filter((u) => u.type === 'militiaman').length, 0, 'held while switched off');
  run(b.st, doneAt + 400, TUNING.empMs + doneAt + 400);
  assert.equal(blue.units.filter((u) => u.type === 'militiaman').length, 1, 'comes out once it recovers');
  assert.deepEqual(E.depositTiles(b.st, blue, TUNING.empMs), [b.at(11, 1), ref.tileId]);
});

test('emp: a Workshop holds its weapon until it recovers', () => {
  const b = makeBattle({ rows: ROWS, units: [{ owner: 'Red', type: 'warrior', at: [6, 1] }] });
  const shop = plantBuilt(b, 'Blue', 'workshop', 7, 1);
  const blue = b.st.armies.Blue;
  blue.minerals = 50;
  assert.equal(E.applyCommand(b.st, 'Blue', { kind: 'craft', weaponId: 'aegis' }, 0).ok, true);
  armed(b, 'Red', 'emp');
  fire(b.st, 'Red', 'emp', shop.tileId, 0);
  b.unit('Red').atkReadyAt = Infinity;
  run(b.st, 0, TUNING.workshopWeaponMs + 400);
  assert.deepEqual(blue.arsenal, []);
  run(b.st, TUNING.workshopWeaponMs + 400, TUNING.workshopWeaponMs + TUNING.empMs + 400);
  assert.deepEqual(blue.arsenal, ['aegis']);
});

test('airdrop: lands airdropCount of the race\'s basic melee unit on a tile your team sees', () => {
  const b = makeBattle({ rows: ['R..~........B'], races: { Red: 'arcane' } });
  armed(b, 'Red', 'airdrop', 'airdrop');
  assert.equal(fire(b.st, 'Red', 'airdrop', b.at(8, 0)).ok, false, 'in the fog');
  assert.equal(fire(b.st, 'Red', 'airdrop', b.at(3, 0)).ok, false, 'water');
  const res = fire(b.st, 'Red', 'airdrop', b.at(2, 0));
  assert.equal(res.ok, true);
  assert.equal(res.spawned, TUNING.airdropCount);
  const dropped = b.st.armies.Red.units.filter((u) => u.tileId === b.at(2, 0));
  assert.equal(dropped.length, 3);
  assert.ok(dropped.every((u) => u.type === 'apprentice'));
  const { events } = E.stepSim(b.st, 200, { now: 200 });
  assert.equal(events.filter((e) => e.type === 'spawn' && e.airdrop).length, 3);
});

test('airdrop: near the cap only what fits lands; at the cap it is refused and kept', () => {
  const b = makeBattle({ rows: ROWS });
  const red = b.st.armies.Red;
  for (let i = 0; i < WF_MAX_UNITS_PER_PLAYER - 1; i++) red.units.push(E.makeUnit(b.st.nextUnitId++, 'warrior', 'Red', b.at(0, 0)));
  armed(b, 'Red', 'airdrop', 'airdrop');
  assert.equal(fire(b.st, 'Red', 'airdrop', b.at(1, 1)).spawned, 1);
  assert.equal(red.units.length, WF_MAX_UNITS_PER_PLAYER);
  assert.equal(fire(b.st, 'Red', 'airdrop', b.at(1, 1)).ok, false);
  assert.deepEqual(red.arsenal, ['airdrop']);
});

test('bombard: hits the enemy base even while a defender contests it, and counts as base damage', () => {
  const b = makeBattle({ rows: ROWS, units: [{ owner: 'Blue', type: 'militiaman', at: [11, 1] }] });
  armed(b, 'Red', 'bombard', 'bombard');
  assert.equal(fire(b.st, 'Red', 'bombard', b.at(10, 1)).ok, false, 'only at the enemy base');
  assert.equal(fire(b.st, 'Red', 'bombard', b.at(0, 1)).ok, false, 'not your own');
  assert.equal(fire(b.st, 'Red', 'bombard', b.at(11, 1)).dmg, TUNING.bombardDmg);
  assert.equal(b.st.bases.blue.hp, TUNING.baseHp - TUNING.bombardDmg);
  assert.equal(b.st.armies.Red.stats.baseDmg, TUNING.bombardDmg);
  const { events } = E.stepSim(b.st, 200, { now: 200 });
  assert.ok(events.some((e) => e.type === 'baseHit' && e.team === 'blue' && e.by === 'bombard'));
});

test('bombard: a base at bombardDmg or less falls and the match ends', () => {
  const b = makeBattle({ rows: ROWS });
  b.st.bases.blue.hp = TUNING.bombardDmg;
  armed(b, 'Red', 'bombard');
  fire(b.st, 'Red', 'bombard', b.at(11, 1), 100);
  E.stepSim(b.st, 200, { now: 200 });
  assert.equal(b.st.winner, 'red');
});

test('aegis: your base takes no damage for aegisMs, a Bombard included (it is still used up)', () => {
  const b = makeBattle({ rows: ROWS, units: [{ owner: 'Red', type: 'warrior', at: [10, 1], hold: true }] });
  armed(b, 'Blue', 'aegis', 'aegis');
  armed(b, 'Red', 'bombard');
  assert.equal(fire(b.st, 'Blue', 'aegis', b.at(0, 1)).ok, false, 'only on your own base');
  assert.equal(fire(b.st, 'Blue', 'aegis', b.at(11, 1), 0).until, TUNING.aegisMs);
  const res = fire(b.st, 'Red', 'bombard', b.at(11, 1), 100);
  assert.equal(res.ok, true);
  assert.equal(res.dmg, 0);
  assert.equal(res.shielded, true);
  assert.deepEqual(b.st.armies.Red.arsenal, []);
  // The warrior beside the base can't scratch it while the shield holds.
  b.unit('Red').tileId = b.at(11, 1) - 1;
  run(b.st, 0, TUNING.aegisMs - 200);
  assert.equal(b.st.bases.blue.hp, TUNING.baseHp);
  run(b.st, TUNING.aegisMs - 200, TUNING.aegisMs + 3000);
  assert.ok(b.st.bases.blue.hp < TUNING.baseHp, 'then it can be hurt again');
});
