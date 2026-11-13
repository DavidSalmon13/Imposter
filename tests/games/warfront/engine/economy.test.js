'use strict';

// Warfront engine tests: carving Supply from the wall and hauling Minerals.
// Exercises server/games/warfront/engine/systems/economy.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const E = require('../../../../server/games/warfront/engine');
const { makeBattle, run, move, haul, produce, rawMap } = require('../fixtures');

test('economy: no Workers on the wall means no Supply at all (no free trickle)', () => {
  const b = makeBattle({ rows: ['R.....B'], sources: [[1, 0, 'red'], [5, 0, 'blue']] });
  run(b.st, 0, 10000);
  assert.equal(b.st.armies.Red.supply, E.TUNING.startSupply);
  assert.equal(E.supplyRate(b.st, b.st.armies.Red), 0);
});

test('economy: a Worker standing beside the supply wall earns nothing until it carves and delivers', () => {
  const b = makeBattle({ rows: ['R.....B'], sources: [[1, 0, 'red'], [5, 0, 'blue']], units: [{ owner: 'Red', type: 'peon', at: [1, 0] }] });
  run(b.st, 0, 10000);
  assert.equal(b.st.armies.Red.supply, E.TUNING.startSupply);
});

test('carve: a Worker walks to its supply wall, carves supplyCarryCap, carries it into the base and goes back', () => {
  const b = makeBattle({ rows: ['R.....B'], sources: [[1, 0, 'red'], [5, 0, 'blue']], units: [{ owner: 'Red', type: 'peon', at: [0, 0] }] });
  const red = b.st.armies.Red;
  const w = b.unit('Red');
  assert.deepEqual(haul(b.st, 'Red', [w.id], b.at(1, 0), 0), { ok: true, hauling: 1 });
  assert.equal(w.haul.kind, 'supply');
  const P = E.WF_STEP_MS_BASE;
  const carve = (E.TUNING.supplyCarryCap / E.TUNING.supplyCarveSec) * 1000;
  run(b.st, 0, P + 200);
  assert.equal(w.tileId, b.at(1, 0));
  assert.equal(w.haul.stage, 'loading');
  assert.equal(red.supply, E.TUNING.startSupply, 'nothing banked while carving');
  const events = [];
  for (let now = P + 400; now <= 2 * P + carve + 1200; now += 200) events.push(...E.stepSim(b.st, 200, { now }).events);
  assert.equal(red.supply, E.TUNING.startSupply + E.TUNING.supplyCarryCap);
  assert.equal(red.minerals, 0, 'carved rock is Supply, not Minerals');
  assert.equal(w.haul.stage, 'toVein', 'and back to the wall');
  assert.deepEqual(events.filter((e) => e.type === 'deposit').map((e) => [e.supply, e.tileId]), [[E.TUNING.supplyCarryCap, b.at(0, 0)]]);
  const now = 2 * P + carve + 1200;
  assert.ok(Math.abs(E.supplyRate(b.st, red, now) - E.TUNING.supplyCarryCap / (E.TUNING.incomeWindowMs / 1000)) < 1e-9);
  assert.equal(E.supplyRate(b.st, red, now + E.TUNING.incomeWindowMs + 1), 0, 'the rate is only recent deliveries');
});

test('carve: Forge Workers carve faster; nobody may carve the enemy wall', () => {
  const fill = (race) => {
    const b = makeBattle({ rows: ['R.....B'], sources: [[1, 0, 'red'], [5, 0, 'blue']], races: { Red: race }, units: [{ owner: 'Red', type: 'peon', at: [1, 0] }] });
    const w = b.unit('Red');
    haul(b.st, 'Red', [w.id], b.at(1, 0), 0);
    let now = 0;
    while (w.carrying < E.TUNING.supplyCarryCap && now < 60000) E.stepSim(b.st, 200, { now: (now += 200) });
    return now;
  };
  assert.ok(fill('forge') < fill('horde'));
  const b = makeBattle({ rows: ['R.....B'], sources: [[1, 0, 'red'], [5, 0, 'blue']], units: [{ owner: 'Red', type: 'peon', at: [0, 0] }] });
  assert.equal(haul(b.st, 'Red', [b.unit('Red').id], b.at(5, 0), 0).ok, false);
});

test('carve: a Worker loaded with Minerals drops them off before carving; a killed carver leaves no Mineral drop', () => {
  const b = makeBattle({ rows: ['R.....B'], sources: [[1, 0, 'red'], [5, 0, 'blue']], units: [{ owner: 'Red', type: 'peon', at: [2, 0] }] });
  const w = b.unit('Red');
  w.carrying = 2;
  haul(b.st, 'Red', [w.id], b.at(1, 0), 0);
  assert.equal(w.haul.stage, 'toDeposit');
  const t = 3 * E.WF_STEP_MS_BASE + 1000;
  run(b.st, 0, t);
  assert.equal(b.st.armies.Red.minerals, 2);
  assert.equal(w.carryKind, 'supply');
  assert.ok(w.carrying > 0);
  w.hp = 0;
  E.stepSim(b.st, 200, { now: t + 200 });
  assert.deepEqual(b.st.pickups.mineralDrops, {});
});

test('carve: starting Workers and freshly built Workers go to the supply wall by themselves', () => {
  const map = E.validateMap(rawMap(), { width: 9, height: 5 });
  const st = E.createBattleState(map, [{ name: 'Red', team: 'red', race: 'horde' }, { name: 'Blue', team: 'blue', race: 'forge' }], { seed: 1, now: 0 });
  for (const u of st.armies.Red.units) assert.deepEqual([u.haul.kind, u.haul.veinTileId], ['supply', E.tileId(1, 2, 9)]);
  run(st, 0, 15000);
  assert.ok(st.armies.Red.supply > E.TUNING.startSupply, 'they deliver without being told');
  st.armies.Red.supply = 10;
  assert.equal(produce(st, 'Red', 'peon', 15000).ok, true);
  run(st, 15000, 15000 + 3 * E.TUNING.buildMsPerCost + 200);
  const fresh = st.armies.Red.units.at(-1);
  assert.equal(fresh.type, 'peon');
  assert.equal(fresh.haul && fresh.haul.kind, 'supply');
});

test('haul: a full cycle walks out, loads carryCap, brings it home and goes back', () => {
  const b = makeBattle({ rows: ['R.......B'], veins: [[4, 0, 2, false]], units: [{ owner: 'Red', type: 'peon', at: [0, 0] }] });
  const red = b.st.armies.Red;
  const w = b.unit('Red');
  assert.deepEqual(haul(b.st, 'Red', [w.id], b.at(4, 0), 0), { ok: true, hauling: 1 });
  assert.equal(w.haul.stage, 'toVein');
  const P = E.WF_STEP_MS_BASE;
  run(b.st, 0, 4 * P);
  assert.equal(w.tileId, b.at(4, 0));
  assert.equal(w.haul.stage, 'loading');
  // richness 2 → 1 Mineral a second: carryCap 4 takes 4 s.
  run(b.st, 4 * P, 4 * P + 2000);
  assert.ok(Math.abs(w.carrying - 2) < 0.21, `half loaded, got ${w.carrying}`);
  const events = [];
  for (let now = 4 * P + 2200; now <= 8 * P + 4400; now += 200) events.push(...E.stepSim(b.st, 200, { now }).events);
  assert.equal(red.minerals, E.TUNING.carryCap);
  assert.equal(w.carrying, 0);
  assert.equal(w.haul.stage, 'toVein', 'and back out again');
  assert.ok(w.path.length > 0);
  assert.deepEqual(events.filter((e) => e.type === 'deposit').map((e) => [e.owner, e.minerals, e.tileId]), [['Red', E.TUNING.carryCap, b.at(0, 0)]]);
  // A plain move ends the loop; the load stays on the Worker.
  w.carrying = 1.5;
  move(b.st, 'Red', [w.id], b.at(2, 0), 9 * P);
  assert.equal(w.haul, null);
  assert.equal(w.carrying, 1.5);
});

test('haul: a contested vein\'s load rate swings by up to ±veinLuckMagnitude, per load and per seed', () => {
  const fillTime = (seed) => {
    const b = makeBattle({ rows: ['Rv....B'], veins: [[1, 0, 1, true]], units: [{ owner: 'Red', type: 'peon', at: [1, 0] }] });
    b.st.seed = seed;
    const w = b.unit('Red');
    haul(b.st, 'Red', [w.id], b.at(1, 0), 0);
    let now = 0;
    while (w.carrying < E.TUNING.carryCap && now < 60000) E.stepSim(b.st, 200, { now: (now += 200) });
    return now;
  };
  const plain = E.TUNING.carryCap / E.TUNING.mineLoadSec; // 8 s at richness 1
  const times = [1, 2, 3, 4, 5, 6, 7, 8].map(fillTime);
  for (const t of times) {
    assert.ok(t >= (plain * 1000) / (1 + E.TUNING.veinLuckMagnitude) - 200, `${t} too fast`);
    assert.ok(t <= (plain * 1000) / (1 - E.TUNING.veinLuckMagnitude) + 200, `${t} too slow`);
  }
  assert.ok(new Set(times).size > 1, 'luck varies between seeds');
  assert.equal(fillTime(5), fillTime(5), 'and is deterministic');
});

test('haul: only Workers, only onto a vein; an already loaded Worker heads straight home', () => {
  const b = makeBattle({
    rows: ['R......B'],
    veins: [[4, 0, 1, false]],
    units: [{ owner: 'Red', type: 'peon', at: [2, 0] }, { owner: 'Red', type: 'warrior', at: [2, 0] }],
  });
  const [w, warrior] = b.st.armies.Red.units;
  assert.equal(haul(b.st, 'Red', [warrior.id], b.at(4, 0), 0).ok, false);
  assert.equal(haul(b.st, 'Red', [w.id], b.at(3, 0), 0).ok, false, 'not a vein');
  assert.equal(haul(b.st, 'Blue', [w.id], b.at(4, 0), 0).ok, false, 'not yours');
  assert.equal(w.haul, null);
  w.carrying = E.TUNING.carryCap;
  assert.equal(haul(b.st, 'Red', [w.id, warrior.id], b.at(4, 0), 0).hauling, 1);
  assert.equal(w.haul.stage, 'toDeposit');
  assert.equal(w.path[w.path.length - 1], b.at(0, 0));
  run(b.st, 0, 2 * E.WF_STEP_MS_BASE + 200);
  assert.equal(b.st.armies.Red.minerals, E.TUNING.carryCap);
  assert.equal(w.haul.stage, 'toVein');
});

test('haul: killing a loaded hauler leaves its load as a drop the enemy can collect', () => {
  const b = makeBattle({
    rows: ['R.......B'],
    veins: [[4, 0, 1, false]],
    units: [{ owner: 'Red', type: 'peon', at: [4, 0] }, { owner: 'Blue', type: 'militiaman', at: [5, 0] }],
  });
  const w = b.unit('Red');
  haul(b.st, 'Red', [w.id], b.at(4, 0), 0);
  w.carrying = 3;
  w.hp = 1;
  E.stepSim(b.st, 200, { now: 200 });
  assert.deepEqual(b.st.armies.Red.units, []);
  assert.deepEqual(b.st.pickups.mineralDrops, { [b.at(4, 0)]: 3 });
  const m = b.unit('Blue');
  move(b.st, 'Blue', [m.id], b.at(4, 0), 200);
  run(b.st, 200, E.WF_STEP_MS_BASE + 400);
  assert.equal(b.st.armies.Blue.minerals, 3);
  assert.deepEqual(b.st.pickups.mineralDrops, {});
});
