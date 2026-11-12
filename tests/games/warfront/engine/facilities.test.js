'use strict';

// Warfront engine tests: facilities + towers (D4, D17).
// Exercises server/games/warfront/engine/systems/facilities.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const E = require('../../../../server/games/warfront/engine');
const { makeBattle, run, move, produce, haul, build, craft, plantBuilt } = require('../fixtures');

test('build: only on a passable tile in sight, never a base, an enemy\'s tile or a structure\'s (D4)', () => {
  // Red base (0,0); Red sees Manhattan 2 round the base and round its Worker at (3,1).
  const b = makeBattle({
    rows: ['R.~......B', '..........'],
    veins: [[4, 1, 2, false]],
    units: [{ owner: 'Red', type: 'peon', at: [3, 1] }, { owner: 'Blue', type: 'warrior', at: [1, 1], hold: true }],
  });
  const red = b.st.armies.Red;
  red.minerals = 30;
  const no = (facility, x, y, pattern) => {
    const res = build(b.st, 'Red', facility, b.at(x, y));
    assert.equal(res.ok, false, `${facility} at ${x},${y}`);
    assert.match(res.error, pattern);
  };
  no('tower', 2, 0, /can't build there/i);
  no('tower', 7, 0, /where your team can see/i);
  no('tower', 0, 0, /base/i);
  no('tower', 1, 1, /enemy/i);
  no('castle', 1, 0, /unknown building/i);
  assert.equal(red.minerals, 30, 'refused builds cost nothing');
  assert.equal(red.units.length, 1);
  // Own units on the tile are fine; a second structure on the same tile is not.
  red.units.push(E.makeUnit(b.st.nextUnitId++, 'warrior', 'Red', b.at(1, 0)));
  assert.equal(build(b.st, 'Red', 'tower', b.at(1, 0)).ok, true);
  assert.equal(red.minerals, 30 - E.FACILITIES.tower.minerals, 'Horde pays full price');
  no('workshop', 1, 0, /already a structure/i);
  // A Refinery needs a vein on or beside its tile.
  no('refinery', 3, 0, /vein/i);
  assert.equal(build(b.st, 'Red', 'refinery', b.at(4, 0)).ok, true, 'beside the vein');
  assert.equal(E.buildBlocker(b.st, red, 'refinery', b.at(4, 1)), null, 'on the vein');
  // Out of Minerals.
  red.minerals = 2;
  no('tower', 3, 1, /not enough minerals/i);
  assert.deepEqual(red.facilities.map((f) => f.type), ['tower', 'refinery']);
});

test('build: Forge pays forgeStructureDiscount less; a build at the unit cap is refused (D12)', () => {
  const b = makeBattle({ rows: ['R......B'] });
  const blue = b.st.armies.Blue; // Forge
  blue.minerals = 20;
  for (const f of Object.values(E.FACILITIES)) {
    assert.equal(E.facilityCost('forge', f.id), f.minerals - E.TUNING.forgeStructureDiscount);
    assert.equal(E.facilityCost('horde', f.id), f.minerals);
  }
  assert.equal(build(b.st, 'Blue', 'tower', b.at(6, 0)).ok, true);
  assert.equal(blue.minerals, 20 - (E.FACILITIES.tower.minerals - 1));
  // Fill the army to the cap: no more structures.
  while (blue.units.length < E.WF_MAX_UNITS_PER_PLAYER) blue.units.push(E.makeUnit(b.st.nextUnitId++, 'laborer', 'Blue', b.at(7, 0)));
  const res = build(b.st, 'Blue', 'tower', b.at(5, 0));
  assert.equal(res.ok, false);
  assert.match(res.error, /cap/);
});

test('build: the site stands (and can be hit) at once, but a Tower only fires once it is built', () => {
  // Blue (Forge) builds a Tower beside its base; a Red Peon on Hold stands next to the site.
  const b = makeBattle({ rows: ['R......B'], units: [{ owner: 'Red', type: 'peon', at: [5, 0], hold: true }] });
  const blue = b.st.armies.Blue;
  blue.minerals = 10;
  assert.equal(build(b.st, 'Blue', 'tower', b.at(6, 0), 0).ok, true);
  const tower = blue.units.find((u) => u.type === 'tower');
  assert.equal(tower.buildDoneAt, E.FACILITIES.tower.buildMs);
  assert.equal(tower.hp, E.FACILITIES.tower.hp);
  const peon = b.unit('Red');
  const events = [];
  for (let now = 200; now < E.FACILITIES.tower.buildMs; now += 200) events.push(...E.stepSim(b.st, 200, { now }).events);
  assert.equal(peon.hp, E.UNIT_TYPES.peon.hp, 'a site never fires');
  assert.ok(tower.hp < E.FACILITIES.tower.hp, 'but it can be hit');
  assert.ok(!events.some((e) => e.type === 'built'));
  // Both views show the site under construction (the Peon's team sees it: it stands beside it).
  assert.equal(E.viewForPlayer(b.st, 'Red').units.find((u) => u.id === tower.id).buildDoneAt, E.FACILITIES.tower.buildMs);
  const done = E.stepSim(b.st, 200, { now: E.FACILITIES.tower.buildMs }).events;
  assert.ok(done.some((e) => e.type === 'built' && e.unitType === 'tower' && e.owner === 'Blue'));
  assert.equal(tower.buildDoneAt, 0);
  run(b.st, E.FACILITIES.tower.buildMs, E.FACILITIES.tower.buildMs + 1200);
  assert.ok(peon.hp < E.UNIT_TYPES.peon.hp, 'built, it fires');
});

test('build: a destroyed site is gone with its Minerals (no refund)', () => {
  const b = makeBattle({ rows: ['R......B'] });
  const red = b.st.armies.Red;
  red.minerals = 10;
  assert.equal(build(b.st, 'Red', 'workshop', b.at(1, 0), 0).ok, true);
  red.units[0].hp = 0;
  const { events } = E.stepSim(b.st, 200, { now: 200 });
  assert.ok(events.some((e) => e.type === 'death' && e.unitType === 'workshop'));
  assert.equal(red.units.length, 0);
  assert.deepEqual(red.facilities, []);
  assert.equal(red.minerals, 10 - E.FACILITIES.workshop.minerals);
});

test('tower: auto-attacks an enemy within range 1, not one 2 tiles away', () => {
  const far = makeBattle({ rows: ['R.........B'], units: [{ owner: 'Red', type: 'warrior', at: [3, 0], hold: true }] });
  plantBuilt(far, 'Blue', 'tower', 5, 0);
  run(far.st, 0, 3000);
  assert.equal(far.unit('Red').hp, E.UNIT_TYPES.warrior.hp);
  const near = makeBattle({ rows: ['R.........B'], units: [{ owner: 'Red', type: 'warrior', at: [4, 0], hold: true }] });
  plantBuilt(near, 'Blue', 'tower', 5, 0);
  const events = E.stepSim(near.st, 200, { now: 200 }).events;
  assert.ok(events.some((e) => e.type === 'underAttack' && e.by === 'tower' && e.owner === 'Red'));
  assert.ok(near.unit('Red').hp < E.UNIT_TYPES.warrior.hp);
  // Other facilities never attack.
  const quiet = makeBattle({ rows: ['R.........B'], units: [{ owner: 'Red', type: 'warrior', at: [4, 0], hold: true }] });
  for (const [type, x] of [['workshop', 5], ['barracks', 3]]) plantBuilt(quiet, 'Blue', type, x, 0);
  const qev = E.stepSim(quiet.st, 200, { now: 200 }).events;
  assert.ok(!qev.some((e) => e.type === 'underAttack' && e.owner === 'Red'));
});

test('refinery: a deposit point and +1 Mineral/s on its vein for its owner only', () => {
  const rows = ['R..........B'];
  const veins = [[6, 0, 1, false]];
  // Red's Refinery beside the vein: Red's Worker loads 0.5 + 1 a second.
  const b = makeBattle({ rows, veins, units: [{ owner: 'Red', type: 'peon', at: [6, 0] }] });
  const ref = plantBuilt(b, 'Red', 'refinery', 5, 0);
  assert.deepEqual(E.depositTiles(b.st, b.st.armies.Red), [b.at(0, 0), ref.tileId]);
  const w = b.unit('Red');
  assert.equal(haul(b.st, 'Red', [w.id], b.at(6, 0), 0).ok, true);
  run(b.st, 0, 2000);
  assert.ok(Math.abs(w.carrying - 3) < 0.31, `1.5/s for 2 s, got ${w.carrying}`);
  // Full, it unloads at the Refinery one tile away, not at the far base.
  const events = [];
  for (let now = 2200; now <= 2000 + E.WF_STEP_MS_BASE + 2000; now += 200) events.push(...E.stepSim(b.st, 200, { now }).events);
  const dep = events.find((e) => e.type === 'deposit');
  assert.ok(dep, 'deposited');
  assert.equal(dep.tileId, ref.tileId);
  assert.equal(b.st.armies.Red.minerals, E.TUNING.carryCap);
  // An enemy's Refinery gives nothing: Blue's Worker on the same vein loads 0.5/s.
  const e2 = makeBattle({ rows, veins, units: [{ owner: 'Blue', type: 'laborer', at: [6, 0] }] });
  plantBuilt(e2, 'Red', 'refinery', 5, 0);
  const bw = e2.unit('Blue');
  haul(e2.st, 'Blue', [bw.id], e2.at(6, 0), 0);
  run(e2.st, 0, 2000);
  assert.ok(Math.abs(bw.carrying - 1) < 0.11, `0.5/s for 2 s, got ${bw.carrying}`);
  // Two Refineries on one vein don't stack.
  const two = makeBattle({ rows, veins, units: [{ owner: 'Red', type: 'peon', at: [6, 0] }] });
  plantBuilt(two, 'Red', 'refinery', 5, 0);
  plantBuilt(two, 'Red', 'refinery', 7, 0);
  haul(two.st, 'Red', [two.unit('Red').id], two.at(6, 0), 0);
  run(two.st, 0, 2000);
  assert.ok(Math.abs(two.unit('Red').carrying - 3) < 0.31);
});

test('refinery: destroying it stops its bonus and its deposits at once', () => {
  const b = makeBattle({ rows: ['R..........B'], veins: [[6, 0, 1, false]], units: [{ owner: 'Red', type: 'peon', at: [6, 0] }] });
  const red = b.st.armies.Red;
  const ref = plantBuilt(b, 'Red', 'refinery', 5, 0);
  const w = b.unit('Red');
  haul(b.st, 'Red', [w.id], b.at(6, 0), 0);
  run(b.st, 0, 1000);
  ref.hp = 0;
  E.stepSim(b.st, 200, { now: 1200 });
  assert.equal(red.units.includes(ref), false);
  assert.deepEqual(red.facilities, []);
  assert.deepEqual(E.depositTiles(b.st, red), [b.at(0, 0)]);
  const before = w.carrying;
  run(b.st, 1200, 3200);
  assert.ok(Math.abs(w.carrying - before - 1) < 0.11, `back to 0.5/s, got +${w.carrying - before}`);
  // Full, it now walks all the way home.
  w.carrying = E.TUNING.carryCap - 0.01;
  E.stepSim(b.st, 200, { now: 3400 });
  assert.equal(w.haul.stage, 'toDeposit');
  assert.equal(w.path[w.path.length - 1], b.at(0, 0));
});

test('barracks: a finished Forward Barracks is a spawn point; a site is not', () => {
  const b = makeBattle({ rows: ['R.......B'] });
  const red = b.st.armies.Red;
  red.supply = 20;
  red.minerals = 10;
  const bar = plantBuilt(b, 'Red', 'barracks', 4, 0);
  assert.deepEqual(E.spawnPoints(b.st, red), [b.at(0, 0), bar.tileId]);
  assert.equal(produce(b.st, 'Red', 'warrior', 0, bar.tileId).ok, true);
  const T = E.buildMs('warrior');
  const { events } = E.stepSim(b.st, 200, { now: T });
  const spawned = red.units.find((u) => u.type === 'warrior');
  assert.equal(spawned.tileId, bar.tileId);
  assert.ok(events.some((e) => e.type === 'spawn' && e.tileId === bar.tileId));
  // A Barracks still being built can't produce yet.
  assert.equal(build(b.st, 'Red', 'barracks', b.at(2, 0), T).ok, true);
  const res = produce(b.st, 'Red', 'warrior', T, b.at(2, 0));
  assert.equal(res.ok, false);
  assert.match(res.error, /Forward Barracks/);
});

test('barracks: destroyed, its queue is lost (no refund) and its slots are free again', () => {
  const b = makeBattle({ rows: ['R.......B'] });
  const red = b.st.armies.Red;
  red.supply = 20;
  const bar = plantBuilt(b, 'Red', 'barracks', 4, 0);
  assert.equal(produce(b.st, 'Red', 'warrior', 0, bar.tileId).ok, true);
  assert.equal(produce(b.st, 'Red', 'warrior', 0, bar.tileId).ok, true);
  assert.equal(produce(b.st, 'Red', 'warrior', 0).ok, true, 'one at the base too');
  assert.equal(red.supply, 11);
  bar.hp = 0;
  E.stepSim(b.st, 200, { now: 200 });
  assert.equal(red.queues[bar.tileId], undefined);
  assert.equal(red.queues[b.at(0, 0)].length, 1, 'the base queue is untouched');
  assert.ok(red.supply < 11.1, `no refund (only the trickle), got ${red.supply}`);
  run(b.st, 200, 3 * E.buildMs('warrior'));
  assert.deepEqual(red.units.map((u) => [u.type, u.tileId]), [['warrior', b.at(0, 0)]]);
});

test('workshop: craft needs a finished Workshop, pays 💎6 and makes one weapon at a time', () => {
  const b = makeBattle({ rows: ['R.......B'] });
  const red = b.st.armies.Red;
  red.minerals = 20;
  assert.match(craft(b.st, 'Red', 'artillery').error, /Workshop/);
  assert.equal(build(b.st, 'Red', 'workshop', b.at(1, 0), 0).ok, true);
  assert.match(craft(b.st, 'Red', 'artillery').error, /Workshop/, 'not while it is a site');
  red.units[0].buildDoneAt = 0;
  red.minerals = 14;
  assert.match(craft(b.st, 'Red', 'nuke').error, /unknown weapon/i);
  const W = E.TUNING.workshopWeaponMs;
  assert.equal(craft(b.st, 'Red', 'artillery', 0).ok, true);
  assert.equal(craft(b.st, 'Red', 'emp', 0).ok, true);
  assert.equal(red.minerals, 14 - 2 * E.TUNING.workshopWeaponCost);
  assert.match(craft(b.st, 'Red', 'aegis', 0).error, /not enough minerals/i);
  assert.deepEqual(red.workshop, [{ weaponId: 'artillery', doneAt: W }, { weaponId: 'emp', doneAt: 2 * W }]);
  assert.deepEqual(E.viewForPlayer(b.st, 'Red').me.workshop.map((w) => [w.weaponId, w.startedAt]), [['artillery', 0], ['emp', W]]);
  const events = [];
  for (let now = 200; now <= W; now += 200) events.push(...E.stepSim(b.st, 200, { now }).events);
  assert.deepEqual(red.arsenal, ['artillery']);
  assert.ok(events.some((e) => e.type === 'crafted' && e.weaponId === 'artillery' && e.tileId === b.at(1, 0)));
  run(b.st, W, 2 * W);
  assert.deepEqual(red.arsenal, ['artillery', 'emp']);
  assert.deepEqual(red.workshop, []);
});

test('workshop: the queue is lost only when the last Workshop falls', () => {
  const b = makeBattle({ rows: ['R.......B'] });
  const red = b.st.armies.Red;
  red.minerals = 30;
  const a = plantBuilt(b, 'Red', 'workshop', 1, 0);
  const c = plantBuilt(b, 'Red', 'workshop', 2, 0);
  craft(b.st, 'Red', 'bombard', 0);
  a.hp = 0;
  E.stepSim(b.st, 200, { now: 200 });
  assert.equal(red.workshop.length, 1, 'one Workshop still stands');
  c.hp = 0;
  E.stepSim(b.st, 200, { now: 400 });
  assert.deepEqual(red.workshop, []);
  run(b.st, 400, E.TUNING.workshopWeaponMs + 400);
  assert.deepEqual(red.arsenal, []);
  assert.equal(red.minerals, 30 - E.TUNING.workshopWeaponCost, 'no refund');
});

test('facilities: structures can\'t be moved or held, and an enemy\'s is hidden outside vision', () => {
  const b = makeBattle({ rows: ['R...........B'] });
  const t = plantBuilt(b, 'Red', 'tower', 1, 0);
  assert.equal(move(b.st, 'Red', [t.id], b.at(2, 0), 0).ok, false);
  assert.equal(E.applyCommand(b.st, 'Red', { kind: 'hold', unitIds: [t.id] }, 0).ok, false);
  const far = plantBuilt(b, 'Blue', 'barracks', 8, 0);
  assert.ok(!E.viewForPlayer(b.st, 'Red').units.some((u) => u.id === far.id));
  assert.ok(E.viewForPlayer(b.st, 'Blue').units.some((u) => u.id === far.id && u.type === 'barracks'));
});
