'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const warfront = require('../../server/games/warfront');
const { getGame, NAMESPACED_SAVED } = require('../../server/gameRegistry');
const {
  createTestCtx,
  createRoom,
  makeHandlerSocket,
  registerGame,
  call,
  emissionsFor,
  emissionsForRoom,
  mockOpenAi,
  mockOpenAiFailure,
  flush,
} = require('../helpers/harness');
const engine = require('../../server/games/warfrontEngine');
const { rngFor } = require('../../server/lib/rng');

const NAMES = ['Host', 'Ann', 'Bob', 'Cat'];

function setup({ phase = 'teamSelect', game = 'warfront', names = NAMES } = {}) {
  const { ctx, io } = createTestCtx();
  const room = createRoom(ctx, 'WFWF', names, { game, phase });
  const sockets = Object.fromEntries(
    names.map((n) => [n, registerGame(warfront, ctx, makeHandlerSocket('WFWF', n))]),
  );
  return { ctx, io, room, sockets };
}

/** Host + Ann on red, Bob + Cat on blue, everyone with a race. */
function readyRoom() {
  const s = setup();
  const { room } = s;
  for (const [n, team, race] of [['Host', 'red', 'forge'], ['Ann', 'red', 'horde'], ['Bob', 'blue', 'arcane'], ['Cat', 'blue', 'forge']]) {
    room.players.get(n).team = team;
    room.state.warfront.lobbyRaces[n] = race;
  }
  return s;
}

function lastWfState(io, room, name) {
  const list = emissionsFor(io, room, name).filter((e) => e.event === 'wfState');
  return list.length ? list[list.length - 1].payload : null;
}

test('contract shape and registry wiring', () => {
  assert.equal(warfront.id, 'warfront');
  assert.equal(warfront.minPlayers, 2);
  assert.equal(warfront.maxPlayers, 8);
  assert.equal(getGame('warfront'), warfront);
  assert.ok(NAMESPACED_SAVED.warfront.includes('lobbyRaces'));
  assert.ok(NAMESPACED_SAVED.warfront.includes('phaseConfig'));
});

test('onChoose resets teams/captains, enters teamSelect and sends each player wfState', () => {
  const { ctx, io, room } = setup({ phase: 'lobby', game: 'warfront' });
  room.players.get('Ann').team = 'blue';
  room.players.get('Ann').leader = true;
  warfront.onChoose(ctx, 'WFWF', room);
  assert.equal(room.phase, 'teamSelect');
  assert.equal(room.players.get('Ann').team, null);
  assert.equal(room.players.get('Ann').leader, false);
  for (const n of NAMES) {
    const st = lastWfState(io, room, n);
    assert.equal(st.phase, 'teamSelect');
    assert.equal(st.you, n);
    assert.equal(st.roomCode, 'WFWF');
    assert.equal(st.unassigned.length, 4);
  }
});

test('joinWfTeam: joins, switching team drops captaincy, bad colour rejected', async () => {
  const { room, sockets, io } = setup();
  assert.equal((await call(sockets.Ann, 'joinWfTeam', 'red')).ok, true);
  assert.equal(room.players.get('Ann').team, 'red');
  room.players.get('Ann').leader = true;
  assert.equal((await call(sockets.Ann, 'joinWfTeam', 'blue')).ok, true);
  assert.equal(room.players.get('Ann').team, 'blue');
  assert.equal(room.players.get('Ann').leader, false);
  const bad = await call(sockets.Ann, 'joinWfTeam', 'green');
  assert.equal(bad.ok, false);
  assert.deepEqual(lastWfState(io, room, 'Bob').blue.map((p) => p.name), ['Ann']);
});

test('joinWfTeam: a team is capped at 4', async () => {
  const names = ['H', 'A', 'B', 'C', 'D', 'E'];
  const { room, sockets } = setup({ names });
  for (const n of ['H', 'A', 'B', 'C']) room.players.get(n).team = 'red';
  const res = await call(sockets.D, 'joinWfTeam', 'red');
  assert.equal(res.ok, false);
  assert.match(res.error, /full/);
});

test('claimWfCaptain: needs a team, one captain per team', async () => {
  const { room, sockets } = setup();
  assert.equal((await call(sockets.Ann, 'claimWfCaptain')).ok, false);
  room.players.get('Ann').team = 'red';
  room.players.get('Bob').team = 'red';
  assert.equal((await call(sockets.Ann, 'claimWfCaptain')).ok, true);
  assert.equal(room.players.get('Ann').leader, true);
  const second = await call(sockets.Bob, 'claimWfCaptain');
  assert.equal(second.ok, false);
  assert.equal(room.players.get('Bob').leader, false);
});

test('setWfRace: stores a valid race, rejects unknown ones', async () => {
  const { room, sockets } = setup();
  assert.equal((await call(sockets.Bob, 'setWfRace', 'arcane')).ok, true);
  assert.equal(room.state.warfront.lobbyRaces.Bob, 'arcane');
  assert.equal((await call(sockets.Bob, 'setWfRace', 'elves')).ok, false);
  assert.equal(room.state.warfront.lobbyRaces.Bob, 'arcane');
});

test('setWfOptions: host only, validated, stored in phaseConfig', async () => {
  const { room, sockets, io } = setup();
  assert.equal((await call(sockets.Ann, 'setWfOptions', { matchLength: 'short' })).ok, false);
  assert.equal((await call(sockets.Host, 'setWfOptions', { matchLength: 'forever' })).ok, false);
  assert.equal((await call(sockets.Host, 'setWfOptions', { mapSize: 'huge' })).ok, false);
  assert.equal((await call(sockets.Host, 'setWfOptions', { matchLength: 'short', mapSize: 'large' })).ok, true);
  assert.equal(room.state.warfront.phaseConfig.matchCapMs, 8 * 60000);
  assert.equal(room.state.warfront.phaseConfig.mapSize, 'large');
  assert.deepEqual(lastWfState(io, room, 'Ann').options, { matchLength: 'short', mapSize: 'large' });
});

test('randomizeWfTeams: host only, even split, clears captains, keeps races', async () => {
  const { room, sockets } = setup();
  room.state.warfront.lobbyRaces.Ann = 'horde';
  room.players.get('Ann').team = 'red';
  room.players.get('Ann').leader = true;
  assert.equal((await call(sockets.Ann, 'randomizeWfTeams')).ok, false);
  assert.equal((await call(sockets.Host, 'randomizeWfTeams')).ok, true);
  const teams = NAMES.map((n) => room.players.get(n).team);
  assert.equal(teams.filter((t) => t === 'red').length, 2);
  assert.equal(teams.filter((t) => t === 'blue').length, 2);
  assert.ok(NAMES.every((n) => !room.players.get(n).leader));
  assert.equal(room.state.warfront.lobbyRaces.Ann, 'horde');
});

test('startWarfront: refused until both teams have a player', async () => {
  const { room, sockets } = setup();
  room.players.get('Host').team = 'red';
  room.state.warfront.lobbyRaces.Host = 'forge';
  const res = await call(sockets.Host, 'startWarfront');
  assert.equal(res.ok, false);
  assert.match(res.error, /Blue team needs/);
});

test('startWarfront: refused until every team member has a race', async () => {
  const { room, sockets, io } = readyRoom();
  delete room.state.warfront.lobbyRaces.Cat;
  const res = await call(sockets.Host, 'startWarfront');
  assert.equal(res.ok, false);
  assert.match(res.error, /Cat/);
  await call(sockets.Bob, 'setWfRace', 'arcane'); // triggers a broadcast
  const st = lastWfState(io, room, 'Host');
  assert.equal(st.canStart, false);
  assert.match(st.startBlocker, /Cat/);
});

test('startWarfront: a non-host non-captain cannot start; host and captains can', async () => {
  const { room, sockets, io } = readyRoom();
  const denied = await call(sockets.Bob, 'startWarfront');
  assert.equal(denied.ok, false);
  assert.match(denied.error, /host or a captain/);

  room.players.get('Bob').leader = true;
  const restore = mockOpenAiFailure();
  let captain;
  try {
    captain = await call(sockets.Bob, 'startWarfront');
  } finally {
    restore();
  }
  assert.equal(captain.ok, true);

  assert.equal(room.phase, 'generating');
  assert.ok(emissionsForRoom(io, 'WFWF').some((e) => e.event === 'generating' && e.payload.game === 'warfront'));
  await flush(); // let the (fallback) map generation finish
});

test('startWarfront: the host can start too', async () => {
  const { sockets } = readyRoom();
  const restore = mockOpenAiFailure();
  try {
    assert.equal((await call(sockets.Host, 'startWarfront')).ok, true);
    await flush();
  } finally {
    restore();
  }
});

test('unassigned players do not block the start', async () => {
  const names = ['Host', 'Ann', 'Bob'];
  const { room, sockets } = setup({ names });
  room.players.get('Host').team = 'red';
  room.players.get('Ann').team = 'blue';
  room.state.warfront.lobbyRaces = { Host: 'forge', Ann: 'horde' };
  const restore = mockOpenAiFailure();
  try {
    assert.equal((await call(sockets.Host, 'startWarfront')).ok, true);
    await flush();
  } finally {
    restore();
  }
  // Bob has no team, so no army.
  assert.deepEqual(Object.keys(room.state.warfront.armies).sort(), ['Ann', 'Host']);
});

test('every handler rejects the wrong game and the wrong phase', async () => {
  for (const opts of [{ game: 'codenames' }, { phase: 'playing' }]) {
    const { sockets } = setup(opts);
    for (const [event, arg] of [
      ['joinWfTeam', 'red'],
      ['claimWfCaptain'],
      ['setWfRace', 'forge'],
      ['setWfOptions', { mapSize: 'small' }],
      ['randomizeWfTeams'],
      ['startWarfront'],
    ]) {
      const res = arg === undefined ? await call(sockets.Host, event) : await call(sockets.Host, event, arg);
      assert.equal(res.ok, false, `${event} in ${JSON.stringify(opts)}`);
    }
  }
});

test('reconnectPayload returns the viewer-specific team-select state', () => {
  const { ctx, room } = readyRoom();
  room.players.get('Bob').leader = true;
  const res = warfront.reconnectPayload(ctx, room, room.players.get('Bob'));
  assert.equal(res.ok, true);
  assert.equal(res.game, 'warfront');
  assert.equal(res.phase, 'teamSelect');
  assert.equal(res.you, 'Bob');
  assert.equal(res.myRace, 'arcane');
  assert.equal(res.canCommand, true);
  assert.equal(res.canStart, true);
  assert.deepEqual(res.blue.map((p) => [p.name, p.leader, p.race]), [['Bob', true, 'arcane'], ['Cat', false, 'forge']]);
});

test('disconnected players drop off the team lists', () => {
  const { ctx, io, room } = readyRoom();
  room.players.get('Cat').connected = false;
  warfront.onDisconnect(ctx, 'WFWF', room, 'Cat');
  assert.deepEqual(lastWfState(io, room, 'Host').blue.map((p) => p.name), ['Bob']);
});

test('clearState keeps options, races and avoid-lists; repairOnLoad reverts generating', () => {
  const { ctx, room } = readyRoom();
  room.state.warfront.phaseConfig.mapSize = 'small';
  room.state.warfront.mapHistory = ['Ashen Divide'];
  room.state.warfront.armies = { Host: {} };
  warfront.clearState(room, 'WFWF');
  assert.equal(room.state.warfront.phaseConfig.mapSize, 'small');
  assert.equal(room.state.warfront.lobbyRaces.Bob, 'arcane');
  assert.deepEqual(room.state.warfront.mapHistory, ['Ashen Divide']);
  assert.deepEqual(room.state.warfront.armies, {});
  room.phase = 'generating';
  warfront.repairOnLoad(ctx, room);
  assert.equal(room.phase, 'teamSelect');
});

// ---- Step 4: map generation + static board ---------------------------------

/** A valid medium map in the spec's JSON shape, as OpenAI would return it. */
function aiMap(theme = 'Glass Canyon') {
  const m = engine.buildFallbackMap('medium', rngFor(99, 0));
  return {
    theme,
    lore: 'Shards of old glass glitter in the ravine.',
    width: m.width,
    height: m.height,
    tiles: m.tiles.map((terrain) => ({ terrain })),
    bases: m.bases.map(({ team, x, y }) => ({ team, x, y })),
    supplySources: m.supplySources.map(({ x, y }) => ({ x, y })),
    veins: m.veins.map(({ x, y, richness, contested }) => ({ x, y, richness, contested })),
    weapons: m.weapons.map(({ x, y, weaponId }) => ({ x, y, weaponId })),
    chokepoints: [],
  };
}

async function startWith(mock) {
  const s = readyRoom();
  const restore = mock();
  try {
    await warfront.generateBattle(s.ctx, 'WFWF', s.room);
  } finally {
    restore();
  }
  return s;
}

test('a valid AI map is used and the battle reaches playing', async () => {
  const { room, io } = await startWith(() => mockOpenAi(aiMap()));
  const wf = room.state.warfront;
  assert.equal(room.phase, 'playing');
  assert.equal(wf.map.theme, 'Glass Canyon');
  assert.deepEqual(wf.mapHistory, ['Glass Canyon']);
  assert.equal(wf.map.width, 16);
  assert.deepEqual(Object.keys(wf.armies).sort(), ['Ann', 'Bob', 'Cat', 'Host']);
  assert.equal(wf.armies.Bob.race, 'arcane');
  assert.equal(wf.armies.Bob.team, 'blue');
  assert.ok(wf.seed > 0 || wf.seed === 0);
  assert.equal(wf.clock.matchEndsAt - wf.clock.startedAt, wf.phaseConfig.matchCapMs);

  const st = lastWfState(io, room, 'Bob');
  assert.equal(st.phase, 'playing');
  assert.equal(st.myTeam, 'blue');
  assert.equal(st.map.theme, 'Glass Canyon');
  assert.equal(st.me.supply, engine.TUNING.startSupply);
  assert.equal(st.roster.length, 4);
});

test('garbage from OpenAI falls back to a procedural map; the game still starts', async () => {
  const { room } = await startWith(() => mockOpenAi({ theme: 'Broken', width: 3, tiles: [] }));
  assert.equal(room.phase, 'playing');
  assert.notEqual(room.state.warfront.map.theme, 'Broken');
  assert.doesNotThrow(() => engine.validateMap(room.state.warfront.map, 'medium'));
});

test('an OpenAI failure falls back too, at the chosen map size', async () => {
  const s = readyRoom();
  s.room.state.warfront.phaseConfig.mapSize = 'large';
  const restore = mockOpenAiFailure();
  try {
    await warfront.generateBattle(s.ctx, 'WFWF', s.room);
  } finally {
    restore();
  }
  assert.equal(s.room.phase, 'playing');
  assert.equal(s.room.state.warfront.map.width, 20);
  assert.equal(s.room.state.warfront.map.height, 13);
});

test('a hung OpenAI call times out into the fallback map', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = readyRoom();
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  global.fetch = () => new Promise(() => {}); // never answers
  try {
    const done = warfront.generateBattle(s.ctx, 'WFWF', s.room);
    assert.equal(s.room.phase, 'generating');
    t.mock.timers.tick(warfront.WF_MAP_TIMEOUT_MS);
    await done;
  } finally {
    global.fetch = originalFetch;
    process.env.OPENAI_API_KEY = originalKey;
  }
  assert.equal(s.room.phase, 'playing');
});

test('at the start each side sees only its own units (the enemy base is beyond vision)', async () => {
  const { room, io } = await startWith(() => mockOpenAi(aiMap()));
  const st = lastWfState(io, room, 'Host');
  assert.ok(st.units.length > 0);
  assert.ok(st.units.every((u) => u.team === 'red'));
  assert.deepEqual([...new Set(st.units.map((u) => u.owner))].sort(), ['Ann', 'Host']);
  assert.equal(st.visible.length, st.map.width * st.map.height);
});

test('back to lobby during generation: the late map is dropped', async () => {
  const s = readyRoom();
  const restore = mockOpenAi(aiMap());
  try {
    const done = warfront.generateBattle(s.ctx, 'WFWF', s.room);
    s.room.phase = 'lobby';
    s.room.game = null;
    await done;
  } finally {
    restore();
  }
  assert.equal(s.room.phase, 'lobby');
  assert.equal(s.room.state.warfront.map, null);
});

test('a team emptied during generation cancels back to team select', async () => {
  const s = readyRoom();
  const restore = mockOpenAi(aiMap());
  try {
    const done = warfront.generateBattle(s.ctx, 'WFWF', s.room);
    s.room.players.get('Bob').connected = false;
    s.room.players.get('Cat').connected = false;
    await done;
  } finally {
    restore();
  }
  assert.equal(s.room.phase, 'teamSelect');
  assert.ok(emissionsForRoom(s.io, 'WFWF').some((e) => e.event === 'wfNotice' && /cancelled/.test(e.payload.text)));
});

test('reconnectPayload in playing carries the board for that viewer', async () => {
  const { ctx, room } = await startWith(() => mockOpenAi(aiMap()));
  const res = warfront.reconnectPayload(ctx, room, room.players.get('Cat'));
  assert.equal(res.ok, true);
  assert.equal(res.phase, 'playing');
  assert.equal(res.myTeam, 'blue');
  assert.equal(res.myRace, 'forge');
  assert.equal(res.map.theme, 'Glass Canyon');
});

// ---- Step 5: sim loop + live orders ----------------------------------------

test.afterEach(() => {
  for (const code of [...warfront.wfLoops.keys()]) warfront.stopLoop(code);
});

const wfLives = (io, room, name) => emissionsFor(io, room, name).filter((e) => e.event === 'wfLive');

async function playingRoom(t) {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
  return startWith(() => mockOpenAi(aiMap()));
}

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
  assert.equal(live.me.supply, engine.TUNING.startSupply);
  assert.ok(typeof live.serverNow === 'number');
});

// ---- Step 6: under-attack alerts --------------------------------------------

const wfAlerts = (io, room, name) => emissionsFor(io, room, name).filter((e) => e.event === 'wfAlert');

/** A Blue (Bob) unit of `type` placed `tileId`, holding. */
function plant(wf, owner, type, tileId) {
  const u = engine.makeUnit(wf.nextUnitId++, type, owner, tileId);
  u.holding = true;
  wf.armies[owner].units.push(u);
  return u;
}

/** Two passable tiles in a row on plains, far from both bases: [a, b]. */
function openPair(wf) {
  const { map } = wf;
  for (let id = 0; id < map.width * map.height; id++) {
    const right = id + 1;
    if (id % map.width === map.width - 1) continue;
    if (map.tiles[id] !== 'plains' || map.tiles[right] !== 'plains') continue;
    const far = (t) => engine.manhattan(t, wf.bases.red.tileId, map.width) > 4 && engine.manhattan(t, wf.bases.blue.tileId, map.width) > 4;
    if (far(id) && far(right)) return [id, right];
  }
  throw new Error('no open pair on this map');
}

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
