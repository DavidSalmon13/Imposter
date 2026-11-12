'use strict';

// Warfront shell tests: battlefield generation (AI map, fallback, timeout, cancel) and lighthouses on AI maps.
// Exercises server/games/warfront/battlefield.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const warfront = require('../../../server/games/warfront');
const { call, emissionsForRoom, mockOpenAi, mockOpenAiFailure } = require('../../helpers/harness');
const engine = require('../../../server/games/warfront/engine');
const { NAMES, readyRoom, lastWfState, aiMap, startWith } = require('./shellFixtures');

test.afterEach(() => {
  for (const code of [...warfront.wfLoops.keys()]) warfront.stopLoop(code);
});

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

test('lighthouses: the prompt asks for them and the AI map\'s lighthouses are used with starting owners', async () => {
  let prompt = '';
  const restoreFetch = global.fetch;
  const raw = aiMap();
  const s = readyRoom();
  const origKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  global.fetch = async (url, init) => {
    prompt = JSON.parse(init.body).messages.map((m) => m.content).join('\n');
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(raw) } }] }) };
  };
  try {
    await warfront.generateBattle(s.ctx, 'WFWF', s.room);
  } finally {
    global.fetch = restoreFetch;
    process.env.OPENAI_API_KEY = origKey;
  }
  assert.match(prompt, /lighthouses/);
  assert.match(prompt, /"lighthouses": \[/);
  const wf = s.room.state.warfront;
  assert.equal(wf.map.theme, 'Glass Canyon');
  assert.equal(wf.lighthouses.length, raw.lighthouses.length);
  assert.deepEqual(wf.lighthouses.filter((l) => l.team).map((l) => l.team).sort(), ['blue', 'red']);
  // Everyone sees every lighthouse and its owner in their view.
  for (const n of NAMES) assert.deepEqual(lastWfState(s.io, s.room, n).lighthouses, wf.lighthouses);
  warfront.stopLoop('WFWF');
});

test('lighthouses: an AI map with no lighthouse near a base falls back to the procedural map', async () => {
  const bad = aiMap('No Towers');
  bad.lighthouses = [];
  const { room } = await startWith(() => mockOpenAi(bad));
  const wf = room.state.warfront;
  assert.notEqual(wf.map.theme, 'No Towers');
  assert.ok(wf.lighthouses.length >= 2);
  warfront.stopLoop('WFWF');
});
