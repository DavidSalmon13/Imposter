'use strict';

// Warfront shell tests: the free-for-all lobby (spec "Free-for-all mode", plan Step 28). The
// Teams / Free for all switch, the FFA start rules, one side per player at Start, and the mode and
// every side's base in the payloads. Exercises handlers.js, roster.js, battlefield.js, payloads.js
// and lifecycle.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const warfront = require('../../../server/games/warfront');
const engine = require('../../../server/games/warfront/engine');
const { call, mockOpenAiFailure, flush } = require('../../helpers/harness');
const { NAMESPACED_SAVED } = require('../../../server/gameRegistry');
const { setup, lastWfState } = require('./shellFixtures');

test.afterEach(() => {
  for (const code of [...warfront.wfLoops.keys()]) warfront.stopLoop(code);
});

const RACES = ['forge', 'horde', 'arcane', 'forge', 'horde'];

/** A team-select room of `names` (the first is the host), every player with a race, in `mode`. */
function lobby(names, mode = 'ffa') {
  const s = setup({ names });
  s.room.state.warfront.mode = mode;
  names.forEach((n, i) => { s.room.state.warfront.lobbyRaces[n] = RACES[i]; });
  return s;
}

async function startFallback(socket) {
  const restore = mockOpenAiFailure();
  try {
    const res = await call(socket, 'startWarfront');
    await flush();
    return res;
  } finally {
    restore();
  }
}

test('wfSetMode: host only, clears teams and captains, lifts a Small map to Medium', async () => {
  const { room, sockets, io } = setup();
  room.players.get('Ann').team = 'red';
  room.players.get('Ann').leader = true;
  room.state.warfront.phaseConfig.mapSize = 'small';

  const denied = await call(sockets.Ann, 'wfSetMode', 'ffa');
  assert.equal(denied.ok, false);
  assert.match(denied.error, /host/);
  assert.equal(room.state.warfront.mode, 'teams');

  assert.equal((await call(sockets.Host, 'wfSetMode', 'nope')).ok, false);
  assert.equal((await call(sockets.Host, 'wfSetMode', 'ffa')).ok, true);
  assert.equal(room.state.warfront.mode, 'ffa');
  assert.equal(room.players.get('Ann').team, null);
  assert.equal(room.players.get('Ann').leader, false);
  assert.equal(room.state.warfront.phaseConfig.mapSize, 'medium');

  const st = lastWfState(io, room, 'Bob');
  assert.equal(st.mode, 'ffa');
  assert.deepEqual(st.players.map((p) => p.name), ['Host', 'Ann', 'Bob', 'Cat']);
  assert.deepEqual(st.ffa, { minPlayers: 3, maxPlayers: 4, mapSizes: ['medium', 'large'] });

  assert.equal((await call(sockets.Host, 'wfSetMode', 'teams')).ok, true);
  assert.equal(lastWfState(io, room, 'Bob').mode, 'teams');
});

test('wfSetMode: only during team select', async () => {
  const { room, sockets } = setup({ phase: 'playing' });
  const res = await call(sockets.Host, 'wfSetMode', 'ffa');
  assert.equal(res.ok, false);
  assert.equal(room.state.warfront.mode, 'teams');
});

test('FFA: no teams, captains, randomize or Small map', async () => {
  const { room, sockets } = lobby(['Host', 'Ann', 'Bob']);
  for (const [who, ev, arg] of [['Ann', 'joinWfTeam', 'red'], ['Ann', 'claimWfCaptain'], ['Host', 'randomizeWfTeams']]) {
    const res = await call(sockets[who], ev, ...(arg ? [arg] : []));
    assert.equal(res.ok, false, ev);
    assert.match(res.error, /no teams/);
  }
  const small = await call(sockets.Host, 'setWfOptions', { mapSize: 'small' });
  assert.equal(small.ok, false);
  assert.equal((await call(sockets.Host, 'setWfOptions', { mapSize: 'large' })).ok, true);
  assert.equal(room.state.warfront.phaseConfig.mapSize, 'large');
});

test('FFA start needs 3–4 players, each with a race', async () => {
  const two = lobby(['Host', 'Ann']);
  assert.match((await call(two.sockets.Host, 'startWarfront')).error, /3–4 players/);
  assert.equal((await call(two.sockets.Host, 'setWfRace', 'forge')).ok, true); // any change re-broadcasts
  const st = lastWfState(two.io, two.room, 'Host');
  assert.equal(st.canStart, false);
  assert.match(st.startBlocker, /3–4 players/);

  const five = lobby(['Host', 'Ann', 'Bob', 'Cat', 'Dan']);
  assert.match((await call(five.sockets.Host, 'startWarfront')).error, /3–4 players/);

  const noRace = lobby(['Host', 'Ann', 'Bob']);
  delete noRace.room.state.warfront.lobbyRaces.Bob;
  assert.match((await call(noRace.sockets.Host, 'startWarfront')).error, /Bob to pick a race/);
});

test('FFA: only the host starts (no captains)', async () => {
  const { room, sockets } = lobby(['Host', 'Ann', 'Bob']);
  room.players.get('Ann').leader = true; // a stale flag must not make Ann a captain
  const res = await call(sockets.Ann, 'startWarfront');
  assert.equal(res.ok, false);
  assert.equal(room.phase, 'teamSelect');
});

for (const names of [['Host', 'Ann', 'Bob'], ['Host', 'Ann', 'Bob', 'Cat']]) {
  test(`FFA start with ${names.length}: one side each, a corner base per side, mode in the payload`, async () => {
    const { room, sockets, io } = lobby(names);
    assert.equal((await startFallback(sockets.Host)).ok, true);
    assert.equal(room.phase, 'playing');

    const wf = room.state.warfront;
    const sides = engine.SIDES.slice(0, names.length);
    assert.deepEqual(Object.keys(wf.bases).sort(), [...sides].sort());
    assert.deepEqual(names.map((n) => wf.armies[n].team).sort(), [...sides].sort());
    names.forEach((n, i) => assert.equal(wf.armies[n].race, RACES[i]));

    for (const n of names) {
      const st = lastWfState(io, room, n);
      assert.equal(st.mode, 'ffa');
      assert.equal(st.myTeam, wf.armies[n].team);
      assert.deepEqual(Object.keys(st.bases).sort(), [...sides].sort(), 'every side’s base');
      assert.equal(st.map.bases.length, names.length);
    }
  });
}

test('FFA game over carries mode, placings and each player’s place and points', async () => {
  const { room, sockets, ctx, io } = lobby(['Host', 'Ann', 'Bob']);
  await startFallback(sockets.Host);
  const wf = room.state.warfront;
  const sideOf = (n) => wf.armies[n].team;
  wf.bases[sideOf('Ann')].hp = 0;
  warfront.tickRoom(ctx, 'WFWF');
  wf.bases[sideOf('Bob')].hp = 0;
  warfront.tickRoom(ctx, 'WFWF');

  assert.equal(room.phase, 'gameover');
  const st = lastWfState(io, room, 'Ann');
  assert.equal(st.mode, 'ffa');
  assert.equal(st.winner, sideOf('Host'));
  assert.equal(st.placings.length, 3);
  const row = (n) => st.stats.find((s) => s.name === n);
  assert.deepEqual([row('Host').place, row('Host').points], [1, 3]);
  assert.deepEqual([row('Bob').place, row('Bob').points], [2, 1]);
  assert.deepEqual([row('Ann').place, row('Ann').points], [3, 0]);
  assert.equal(st.canCommand, false, 'Ann is not the host');
  assert.equal(lastWfState(io, room, 'Host').canCommand, true);
});

test('team battles keep working: mode teams in the payloads, no FFA fields on stats', async () => {
  const { room, sockets, io } = lobby(['Host', 'Ann'], 'teams');
  room.players.get('Host').team = 'red';
  room.players.get('Ann').team = 'blue';
  await startFallback(sockets.Host);
  assert.equal(room.phase, 'playing');
  assert.deepEqual(Object.keys(room.state.warfront.bases).sort(), ['blue', 'red']);
  assert.equal(lastWfState(io, room, 'Ann').mode, 'teams');
});

test('mode is persisted and survives Back to Lobby', () => {
  assert.ok(NAMESPACED_SAVED.warfront.includes('mode'));
  const { room } = lobby(['Host', 'Ann', 'Bob']);
  warfront.clearState(room, 'WFWF');
  assert.equal(room.state.warfront.mode, 'ffa');
  assert.equal(warfront.namespaces[0].createState().mode, 'teams');
});
