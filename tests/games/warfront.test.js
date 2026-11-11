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
} = require('../helpers/harness');

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
  const captain = await call(sockets.Bob, 'startWarfront');
  assert.equal(captain.ok, true);

  const host = await call(sockets.Host, 'startWarfront');
  assert.equal(host.ok, true);
  // Step 3 stub: still in team select, everyone told.
  assert.equal(room.phase, 'teamSelect');
  assert.ok(emissionsForRoom(io, 'WFWF').some((e) => e.event === 'wfNotice'));
});

test('unassigned players do not block the start', async () => {
  const names = ['Host', 'Ann', 'Bob'];
  const { room, sockets } = setup({ names });
  room.players.get('Host').team = 'red';
  room.players.get('Ann').team = 'blue';
  room.state.warfront.lobbyRaces = { Host: 'forge', Ann: 'horde' };
  assert.equal((await call(sockets.Host, 'startWarfront')).ok, true);
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
