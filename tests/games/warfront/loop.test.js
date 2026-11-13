'use strict';

// Warfront shell tests: the sim loop, live orders (wfCommand), fogged wfLive, alerts, economy, facilities, persistence.
// Exercises server/games/warfront/{loop,alerts,handlers,payloads}.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const warfront = require('../../../server/games/warfront');
const { NAMESPACED_SAVED } = require('../../../server/gameRegistry');
const { call, emissionsForRoom, mockOpenAi } = require('../../helpers/harness');
const engine = require('../../../server/games/warfront/engine');
const { lastWfState, aiMap, startWith, wfLives, playingRoom, wfAlerts, plant, openPair, besideBase } = require('./shellFixtures');

test.afterEach(() => {
  for (const code of [...warfront.wfLoops.keys()]) warfront.stopLoop(code);
});

test('loop: starts on battle start, ticks every WF_TICK_MS, stops on back to lobby', async (t) => {
  const s = await playingRoom(t);
  assert.ok(warfront.wfLoops.has('WFWF'));
  assert.equal(wfLives(s.io, s.room, 'Bob').length, 0);
  t.mock.timers.tick(warfront.WF_TICK_MS * 3);
  assert.equal(s.room.state.warfront.tick, 3);
  assert.equal(wfLives(s.io, s.room, 'Bob').length, 3);
  assert.equal(s.room.state.warfront.clock.lastTickAt, Date.now());

  // Back to lobby (lobby.js resetToLobby -> clearAllGameState -> clearState(room, code)).
  s.room.game = null;
  s.room.phase = 'lobby';
  warfront.clearState(s.room, 'WFWF');
  assert.ok(!warfront.wfLoops.has('WFWF'));
  t.mock.timers.tick(warfront.WF_TICK_MS * 5);
  assert.equal(wfLives(s.io, s.room, 'Bob').length, 3);
});

test('loop: a match that was playing at a restart resumes after repairOnLoad', async (t) => {
  const s = await playingRoom(t);
  t.mock.timers.tick(warfront.WF_TICK_MS * 2);
  const wf = s.room.state.warfront;
  assert.equal(wf.tick, 2);

  // Simulate the process dying: the interval is gone, then 30s of downtime.
  warfront.stopLoop('WFWF');
  t.mock.timers.tick(30000);
  assert.equal(wf.tick, 2);

  warfront.repairOnLoad(s.ctx, s.room);
  assert.equal(s.room.phase, 'playing');
  assert.ok(warfront.wfLoops.has('WFWF'));
  assert.equal(wf.clock.lastTickAt, Date.now(), 'downtime is not replayed as one giant step');
  t.mock.timers.tick(warfront.WF_TICK_MS);
  assert.equal(wf.tick, 3);
});

test('loop: repairOnLoad does not restart a finished match', async (t) => {
  const s = await playingRoom(t);
  warfront.stopLoop('WFWF');
  s.room.state.warfront.winner = 'red';
  warfront.repairOnLoad(s.ctx, s.room);
  assert.ok(!warfront.wfLoops.has('WFWF'));
});

test('loop: stops itself once the room is gone or no longer playing', async (t) => {
  const s = await playingRoom(t);
  s.ctx.rooms.delete('WFWF');
  t.mock.timers.tick(warfront.WF_TICK_MS);
  assert.ok(!warfront.wfLoops.has('WFWF'));
});

test('loop: a thrown error inside one tick does not stop later ticks', async (t) => {
  const s = await playingRoom(t);
  const original = engine.stepSim;
  let calls = 0;
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args));
  engine.stepSim = (...args) => {
    calls++;
    if (calls === 2) throw new Error('boom');
    return original(...args);
  };
  try {
    t.mock.timers.tick(warfront.WF_TICK_MS * 4);
  } finally {
    engine.stepSim = original;
  }
  assert.equal(calls, 4);
  assert.equal(errors.length, 1);
  assert.ok(warfront.wfLoops.has('WFWF'));
  assert.equal(wfLives(s.io, s.room, 'Bob').length, 3);
});

test('loop: a long stall is clamped to WF_MAX_DT_MS', async (t) => {
  const s = await playingRoom(t);
  const seen = [];
  const original = engine.stepSim;
  engine.stepSim = (st, dt, opts) => {
    seen.push(dt);
    return original(st, dt, opts);
  };
  try {
    // The event loop stalled for a minute since the last tick.
    s.room.state.warfront.clock.lastTickAt -= 60000;
    t.mock.timers.tick(warfront.WF_TICK_MS);
  } finally {
    engine.stepSim = original;
  }
  assert.deepEqual(seen, [engine.WF_MAX_DT_MS]);
});

test('wfCommand move: applied at once, no broadcast, and the next ticks walk the unit', async (t) => {
  const s = await playingRoom(t);
  const wf = s.room.state.warfront;
  const worker = wf.armies.Host.units[0];
  const from = worker.tileId;
  const to = engine.neighbors(from, wf.map.width, wf.map.height).find((n) => engine.isPassable(wf.map, n));
  const before = s.io.emissions.length;
  const res = await call(s.sockets.Host, 'wfCommand', { kind: 'move', unitIds: [worker.id], toTileId: to });
  assert.deepEqual(res, { ok: true });
  assert.equal(s.io.emissions.length, before, 'no broadcast from the command itself');
  assert.deepEqual(worker.path, [to]);
  t.mock.timers.tick(engine.stepMs(wf.map, worker.type, to) + warfront.WF_TICK_MS);
  assert.equal(worker.tileId, to);
  const live = wfLives(s.io, s.room, 'Host').at(-1).payload;
  assert.equal(live.units.find((u) => u.id === worker.id).tileId, to);
});

test('wfCommand guards: wrong phase, wrong game, someone else\'s units, no army, bad target', async (t) => {
  const s = await playingRoom(t);
  const wf = s.room.state.warfront;
  const bobUnit = wf.armies.Bob.units[0];
  const near = (u) => engine.neighbors(u.tileId, wf.map.width, wf.map.height).find((n) => engine.isPassable(wf.map, n));
  // Host can't move Bob's units.
  assert.equal((await call(s.sockets.Host, 'wfCommand', { kind: 'move', unitIds: [bobUnit.id], toTileId: near(bobUnit) })).ok, false);
  assert.deepEqual(bobUnit.path, []);
  // Garbage.
  assert.equal((await call(s.sockets.Bob, 'wfCommand', null)).ok, false);
  assert.equal((await call(s.sockets.Bob, 'wfCommand', { kind: 'move', unitIds: [bobUnit.id], toTileId: -4 })).ok, false);
  // A player with no army (joined after the start).
  wf.armies = { ...wf.armies };
  delete wf.armies.Cat;
  assert.equal((await call(s.sockets.Cat, 'wfCommand', { kind: 'move', unitIds: [1], toTileId: 0 })).ok, false);
  // Wrong phase / wrong game.
  s.room.phase = 'gameover';
  assert.equal((await call(s.sockets.Bob, 'wfCommand', { kind: 'move', unitIds: [bobUnit.id], toTileId: near(bobUnit) })).ok, false);
  s.room.phase = 'playing';
  s.room.game = 'codenames';
  assert.equal((await call(s.sockets.Bob, 'wfCommand', { kind: 'move', unitIds: [bobUnit.id], toTileId: near(bobUnit) })).ok, false);
  assert.deepEqual(bobUnit.path, []);
});

test('wfLive is fogged per socket: an enemy shows up only within vision', async (t) => {
  const s = await playingRoom(t);
  const wf = s.room.state.warfront;
  const raider = engine.makeUnit(wf.nextUnitId++, 'raider', 'Ann', wf.bases.blue.tileId);
  wf.armies.Ann.units.push(raider);
  t.mock.timers.tick(warfront.WF_TICK_MS);
  const ids = (name) => wfLives(s.io, s.room, name).at(-1).payload.units.map((u) => u.id);
  // Ann's raider stands on the blue base: blue sees it, and red sees blue's workers there.
  assert.ok(ids('Bob').includes(raider.id));
  assert.ok(ids('Cat').includes(raider.id));
  assert.ok(ids('Host').includes(wf.armies.Bob.units[0].id));
  // Move it back home: gone from blue's view (and nothing is roomEmitted). They traded
  // blows on the base, so each side stays revealed to the other for WF_REVEAL_MS first.
  raider.tileId = wf.bases.red.tileId;
  raider.path = [];
  t.mock.timers.tick(engine.WF_REVEAL_MS + warfront.WF_TICK_MS);
  assert.ok(!ids('Bob').includes(raider.id));
  assert.ok(!ids('Host').includes(wf.armies.Bob.units[0].id));
  assert.ok(!emissionsForRoom(s.io, 'WFWF').some((e) => e.event === 'wfLive'));
  const live = wfLives(s.io, s.room, 'Bob').at(-1).payload;
  assert.equal(live.me.supply, wf.armies.Bob.supply);
  assert.ok(typeof live.serverNow === 'number');
});

test('alerts: a hit alerts only the owner, privately; one per area per cooldown; a far hit alerts at once', async (t) => {
  const s = await playingRoom(t);
  const wf = s.room.state.warfront;
  for (const a of Object.values(wf.armies)) a.units = [];
  const [a, b] = openPair(wf);
  const victim = plant(wf, 'Bob', 'bastion', a); // can't move, takes a while to kill
  plant(wf, 'Ann', 'warrior', b);
  t.mock.timers.tick(warfront.WF_TICK_MS);
  assert.deepEqual(wfAlerts(s.io, s.room, 'Bob').map((e) => e.payload), [{ tileId: a, base: false }]);
  for (const n of ['Host', 'Ann', 'Cat']) assert.equal(wfAlerts(s.io, s.room, n).length, 0, n);
  assert.ok(!emissionsForRoom(s.io, 'WFWF').some((e) => e.event === 'wfAlert'));

  // More hits in the same place within the cooldown: no new alert.
  t.mock.timers.tick(warfront.WF_ALERT_COOLDOWN_MS - warfront.WF_TICK_MS * 2);
  assert.ok(victim.hp < engine.UNIT_TYPES.bastion.hp - 5);
  assert.equal(wfAlerts(s.io, s.room, 'Bob').length, 1);

  // A hit far away alerts at once, even inside the cooldown.
  const far = plant(wf, 'Bob', 'bastion', wf.bases.red.tileId);
  far.holding = true;
  t.mock.timers.tick(warfront.WF_TICK_MS);
  const got = wfAlerts(s.io, s.room, 'Bob').map((e) => e.payload.tileId);
  assert.equal(got.length, 2);
  assert.equal(got[1], wf.bases.red.tileId);

  // And after the cooldown the first area alerts again.
  t.mock.timers.tick(warfront.WF_ALERT_COOLDOWN_MS);
  assert.ok(wfAlerts(s.io, s.room, 'Bob').length >= 3);
});

test('alerts: a base hit alerts every player on that team, nobody else', async (t) => {
  const s = await playingRoom(t);
  const wf = s.room.state.warfront;
  for (const a of Object.values(wf.armies)) a.units = [];
  const near = engine.neighbors(wf.bases.blue.tileId, wf.map.width, wf.map.height)
    .find((n) => engine.isPassable(wf.map, n) && wf.map.tiles[n] === wf.map.tiles[wf.bases.blue.tileId]);
  plant(wf, 'Ann', 'warchief', near);
  t.mock.timers.tick(warfront.WF_TICK_MS);
  for (const n of ['Bob', 'Cat']) {
    assert.ok(wfAlerts(s.io, s.room, n).some((e) => e.payload.base && e.payload.tileId === wf.bases.blue.tileId), n);
  }
  assert.equal(wfAlerts(s.io, s.room, 'Host').length, 0);
  // Ann got hit back by the base: her own alert, not about the base.
  assert.ok(wfAlerts(s.io, s.room, 'Ann').every((e) => !e.payload.base));
});

test('alerts: the throttle is per room and forgotten when the loop stops', async (t) => {
  const s = await playingRoom(t);
  const wf = s.room.state.warfront;
  for (const a of Object.values(wf.armies)) a.units = [];
  const [a, b] = openPair(wf);
  plant(wf, 'Bob', 'bastion', a);
  plant(wf, 'Ann', 'warrior', b);
  t.mock.timers.tick(warfront.WF_TICK_MS);
  assert.ok(warfront.wfAlertLog.get('WFWF').has('Bob'));
  warfront.stopLoop('WFWF');
  assert.ok(!warfront.wfAlertLog.has('WFWF'));
});

test('wfCommand hold: applied at once; the unit stays put', async (t) => {
  const s = await playingRoom(t);
  const wf = s.room.state.warfront;
  const worker = wf.armies.Bob.units[0];
  assert.deepEqual(await call(s.sockets.Bob, 'wfCommand', { kind: 'hold', unitIds: [worker.id] }), { ok: true });
  assert.equal(worker.holding, true);
  assert.equal((await call(s.sockets.Host, 'wfCommand', { kind: 'hold', unitIds: [worker.id] })).ok, false);
  t.mock.timers.tick(warfront.WF_TICK_MS);
  const own = wfLives(s.io, s.room, 'Bob').at(-1).payload.units.find((u) => u.id === worker.id);
  assert.equal(own.holding, true);
});

test('wfState in playing carries the viewer\'s own race catalog with 🔩/💎 prices', async () => {
  const { io, room } = await startWith(() => mockOpenAi(aiMap()));
  const bob = lastWfState(io, room, 'Bob'); // Arcane
  assert.deepEqual(bob.catalog.map((c) => c.unitType), ['acolyte', 'apprentice', 'mysticArcher', 'battlemage', 'summoner', 'archmage']);
  const archmage = bob.catalog.find((c) => c.unitType === 'archmage');
  assert.deepEqual([archmage.supply, archmage.minerals, archmage.buildMs], [9, 6, 9 * engine.TUNING.buildMsPerCost]);
  assert.equal(bob.catalog[0].worker, true);
  const cat = lastWfState(io, room, 'Cat'); // Forge
  assert.equal(cat.catalog.find((c) => c.unitType === 'bastion').structure, true);
  assert.equal(typeof bob.me.supplyRate, 'number');
});

test('wfCommand produce: pays at once, no broadcast; the unit spawns on a later tick and shows in wfLive', async (t) => {
  const s = await playingRoom(t);
  const wf = s.room.state.warfront;
  const army = wf.armies.Ann; // Horde
  const base = wf.bases.red.tileId;
  const before = s.io.emissions.length;
  assert.deepEqual(await call(s.sockets.Ann, 'wfCommand', { kind: 'produce', unitType: 'warrior', atTileId: base }), { ok: true });
  assert.equal(s.io.emissions.length, before);
  assert.equal(army.supply, engine.TUNING.startSupply - 3);
  assert.equal((await call(s.sockets.Ann, 'wfCommand', { kind: 'produce', unitType: 'militiaman' })).ok, false, 'Forge unit');
  assert.equal((await call(s.sockets.Ann, 'wfCommand', { kind: 'produce', unitType: 'raider' })).ok, false, 'no Minerals yet');
  t.mock.timers.tick(engine.buildMs('warrior') + warfront.WF_TICK_MS);
  const warrior = army.units.find((u) => u.type === 'warrior');
  assert.ok(warrior);
  assert.equal(warrior.tileId, base);
  const live = wfLives(s.io, s.room, 'Ann').at(-1).payload;
  assert.ok(live.units.some((u) => u.id === warrior.id));
  assert.ok(live.me.supply > army.supply - 1, 'the live view carries the current Supply');
  // A teammate never sees Ann's Supply or queue.
  const host = wfLives(s.io, s.room, 'Host').at(-1).payload;
  assert.equal(host.me.supply, wf.armies.Host.supply);
});

test('wfCommand haul: a Worker runs the loop and Minerals reach its owner', async (t) => {
  const s = await playingRoom(t);
  const wf = s.room.state.warfront;
  const worker = wf.armies.Bob.units[0];
  const vein = wf.map.veins[0];
  assert.deepEqual(await call(s.sockets.Bob, 'wfCommand', { kind: 'haul', workerIds: [worker.id], veinTileId: vein.tileId }), { ok: true });
  assert.equal(worker.haul.stage, 'toVein');
  assert.equal((await call(s.sockets.Host, 'wfCommand', { kind: 'haul', workerIds: [worker.id], veinTileId: vein.tileId })).ok, false);
  // Walk out, load, walk home: give it plenty of time.
  const walk = engine.bfsPath(wf.map, worker.tileId, vein.tileId).length * 2 * engine.WF_STEP_MS_BASE * 2;
  for (let ms = 0; ms < walk + 20000 && wf.armies.Bob.minerals === 0; ms += 1000) t.mock.timers.tick(1000);
  assert.equal(wf.armies.Bob.minerals, engine.TUNING.carryCap);
  const own = wfLives(s.io, s.room, 'Bob').at(-1).payload.units.find((u) => u.id === worker.id);
  assert.ok(own.haul && own.haul.veinTileId === vein.tileId);
});

test('lighthouses: persisted through the snapshot round-trip, capture survives', async (t) => {
  const s = await playingRoom(t);
  const wf = s.room.state.warfront;
  assert.ok(NAMESPACED_SAVED.warfront.includes('lighthouses'));
  const neutral = wf.lighthouses.find((l) => !l.team);
  const target = neutral || wf.lighthouses.find((l) => l.team === 'blue');
  for (const a of Object.values(wf.armies)) a.units = [];
  plant(wf, 'Ann', 'raider', target.tileId);
  t.mock.timers.tick(warfront.WF_TICK_MS);
  assert.equal(target.team, 'red');
  // What persistence.js writes and reads back: only the saved keys, through JSON.
  const picked = {};
  for (const key of NAMESPACED_SAVED.warfront) picked[key] = wf[key];
  const restored = { ...warfront.namespaces[0].createState(), ...JSON.parse(JSON.stringify(picked)) };
  assert.deepEqual(restored.lighthouses, wf.lighthouses);
  assert.deepEqual([...engine.visionFor(restored, 'red')].sort(), [...engine.visionFor(wf, 'red')].sort());
  // Every player hears about the flip in their next wfLive, and sees the new owner.
  const bobLive = wfLives(s.io, s.room, 'Bob').pop().payload;
  assert.ok(bobLive.events.some((e) => e.type === 'lighthouse' && e.tileId === target.tileId && e.team === 'red'));
  assert.equal(bobLive.lighthouses.find((l) => l.tileId === target.tileId).team, 'red');
});

test('wfState carries the Build catalog at the viewer\'s race price, and the Workshop price', async (t) => {
  const s = await playingRoom(t);
  const cat = lastWfState(s.io, s.room, 'Cat'); // Forge
  const ann = lastWfState(s.io, s.room, 'Ann'); // Horde
  assert.deepEqual(cat.buildCatalog.map((c) => c.facility), ['refinery', 'barracks', 'workshop', 'tower']);
  for (const f of Object.values(engine.FACILITIES)) {
    assert.equal(ann.buildCatalog.find((c) => c.facility === f.id).minerals, f.minerals);
    assert.equal(cat.buildCatalog.find((c) => c.facility === f.id).minerals, f.minerals - engine.TUNING.forgeStructureDiscount);
  }
  assert.equal(cat.buildCatalog.find((c) => c.facility === 'refinery').needsVein, true);
  assert.equal(cat.weaponCost, engine.TUNING.workshopWeaponCost);
});

test('wfCommand build + craft: pays at once, the site rises on a later tick, a weapon reaches the arsenal', async (t) => {
  const s = await playingRoom(t);
  const wf = s.room.state.warfront;
  const army = wf.armies.Ann;
  army.minerals = 20;
  const spot = besideBase(wf, 'red');
  const before = s.io.emissions.length;
  assert.deepEqual(await call(s.sockets.Ann, 'wfCommand', { kind: 'build', facility: 'workshop', tileId: spot }), { ok: true });
  assert.equal(s.io.emissions.length, before, 'no broadcast: the next tick shows it');
  assert.equal(army.minerals, 20 - engine.FACILITIES.workshop.minerals);
  // Blue can't build out of its own team's sight.
  assert.equal((await call(s.sockets.Bob, 'wfCommand', { kind: 'build', facility: 'tower', tileId: spot })).ok, false);
  const site = army.units.find((u) => u.type === 'workshop');
  assert.ok(site.buildDoneAt > 0);
  assert.equal((await call(s.sockets.Ann, 'wfCommand', { kind: 'craft', weaponId: 'emp' })).ok, false, 'still a site');
  t.mock.timers.tick(engine.FACILITIES.workshop.buildMs + warfront.WF_TICK_MS);
  assert.equal(site.buildDoneAt, 0);
  const view = wfLives(s.io, s.room, 'Ann').at(-1).payload;
  assert.ok(view.units.some((u) => u.id === site.id && u.type === 'workshop' && !u.buildDoneAt));
  assert.deepEqual(await call(s.sockets.Ann, 'wfCommand', { kind: 'craft', weaponId: 'emp' }), { ok: true });
  t.mock.timers.tick(engine.TUNING.workshopWeaponMs + warfront.WF_TICK_MS);
  assert.deepEqual(army.arsenal, ['emp']);
  // Only Ann hears about her own weapon.
  assert.ok(wfLives(s.io, s.room, 'Ann').some((e) => e.payload.events.some((ev) => ev.type === 'crafted')));
  assert.ok(!wfLives(s.io, s.room, 'Bob').some((e) => e.payload.events.some((ev) => ev.type === 'crafted')));
});
