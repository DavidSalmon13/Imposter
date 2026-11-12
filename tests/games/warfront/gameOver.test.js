'use strict';

// Warfront shell tests: win, game over, scoreboard points and Play Again.
// Exercises server/games/warfront/{loop,payloads,handlers}.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const warfront = require('../../../server/games/warfront');
const { call, mockOpenAiFailure, flush } = require('../../helpers/harness');
const engine = require('../../../server/games/warfront/engine');
const { NAMES, lastWfState, wfLives, playingRoom, plant, besideBase } = require('./shellFixtures');

test.afterEach(() => {
  for (const code of [...warfront.wfLoops.keys()]) warfront.stopLoop(code);
});

test('game over: a base kill ends the match on that tick, pays +2 per winner and records the result', async (t) => {
  const s = await playingRoom(t);
  const wf = s.room.state.warfront;
  for (const a of Object.values(wf.armies)) a.units = [];
  plant(wf, 'Ann', 'warchief', besideBase(wf, 'blue'));
  wf.bases.blue.hp = 1;
  t.mock.timers.tick(warfront.WF_TICK_MS);

  assert.equal(s.room.phase, 'gameover');
  assert.equal(wf.winner, 'red');
  assert.equal(wf.bases.blue.hp, 0);
  assert.ok(!warfront.wfLoops.has('WFWF'), 'the loop stopped');
  assert.deepEqual(s.room.scoreboard, { Host: 2, Ann: 2 });

  assert.equal(s.recordedResults.length, 1);
  const { gameType, participants } = s.recordedResults[0];
  assert.equal(gameType, 'warfront');
  assert.deepEqual(
    [...participants].sort((a, b) => a.name.localeCompare(b.name)),
    [
      { name: 'Ann', team: 'red', won: true, points: 2 },
      { name: 'Bob', team: 'blue', won: false, points: 0 },
      { name: 'Cat', team: 'blue', won: false, points: 0 },
      { name: 'Host', team: 'red', won: true, points: 2 },
    ],
  );

  // Everyone gets the final, unfogged state: both teams' units, stats, MVP, scoreboard.
  for (const n of NAMES) {
    const st = lastWfState(s.io, s.room, n);
    assert.equal(st.phase, 'gameover', n);
    assert.equal(st.winner, 'red');
    assert.equal(st.endReason, 'base');
    assert.equal(st.mvp, 'Ann');
    assert.equal(st.visible, '1'.repeat(wf.map.width * wf.map.height));
    assert.ok(st.units.some((u) => u.owner === 'Ann'), `${n} sees Ann's Warchief`);
    assert.equal(st.stats.length, 4);
    assert.equal(st.stats.find((x) => x.name === 'Ann').baseDmg, 1);
    assert.deepEqual(st.scoreboard.map((e) => [e.name, e.points]), [['Ann', 2], ['Host', 2]]);
    assert.equal(st.canCommand, n === 'Host', 'host may play again (no captains here)');
  }
  assert.equal(lastWfState(s.io, s.room, 'Bob').myTeam, 'blue');
});

test('game over: no tick runs after the match is decided', async (t) => {
  const s = await playingRoom(t);
  const wf = s.room.state.warfront;
  for (const a of Object.values(wf.armies)) a.units = [];
  plant(wf, 'Bob', 'warchief', besideBase(wf, 'red'));
  wf.bases.red.hp = 1;
  t.mock.timers.tick(warfront.WF_TICK_MS);
  assert.equal(s.room.phase, 'gameover');
  assert.equal(wf.winner, 'blue');
  const tick = wf.tick;
  const lives = wfLives(s.io, s.room, 'Host').length;
  t.mock.timers.tick(warfront.WF_TICK_MS * 10);
  assert.equal(wf.tick, tick);
  assert.equal(wfLives(s.io, s.room, 'Host').length, lives);
  // Even a stray tick (say, a timer that fired late) changes nothing.
  warfront.tickRoom(s.ctx, 'WFWF');
  assert.equal(wf.tick, tick);
  assert.equal(s.recordedResults.length, 1, 'the result is recorded once');
  assert.deepEqual(s.room.scoreboard, { Bob: 2, Cat: 2 });
  // Orders are refused now.
  const res = await call(s.sockets.Bob, 'wfCommand', { kind: 'hold', unitIds: [wf.armies.Bob.units[0].id] });
  assert.equal(res.ok, false);
});

test('game over: at the match cap the higher base HP wins', async (t) => {
  const s = await playingRoom(t);
  const wf = s.room.state.warfront;
  wf.clock.matchEndsAt = Date.now() + warfront.WF_TICK_MS * 2;
  wf.bases.red.hp = 90;
  t.mock.timers.tick(warfront.WF_TICK_MS);
  assert.equal(s.room.phase, 'playing');
  t.mock.timers.tick(warfront.WF_TICK_MS);
  assert.equal(s.room.phase, 'gameover');
  assert.equal(wf.winner, 'blue');
  assert.deepEqual(s.room.scoreboard, { Bob: 2, Cat: 2 });
  const st = lastWfState(s.io, s.room, 'Host');
  assert.equal(st.endReason, 'time');
  assert.equal(st.matchMs, wf.clock.matchEndsAt - wf.clock.startedAt);
  assert.equal(st.mvp, null, 'nobody damaged a base');
});

test('game over: equal base HP at the cap is a draw worth 0 points', async (t) => {
  const s = await playingRoom(t);
  const wf = s.room.state.warfront;
  wf.clock.matchEndsAt = Date.now() + warfront.WF_TICK_MS;
  t.mock.timers.tick(warfront.WF_TICK_MS);
  assert.equal(s.room.phase, 'gameover');
  assert.equal(wf.winner, 'draw');
  assert.deepEqual(s.room.scoreboard || {}, {});
  assert.equal(s.recordedResults.length, 1);
  assert.ok(s.recordedResults[0].participants.every((p) => p.won === false && p.points === 0));
  assert.equal(lastWfState(s.io, s.room, 'Cat').winner, 'draw');
});

test('playAgainWarfront: host or captain only, gameover only; regenerates a fresh battle', async (t) => {
  const s = await playingRoom(t);
  const wf = s.room.state.warfront;
  assert.equal((await call(s.sockets.Host, 'playAgainWarfront')).ok, false, 'not over yet');
  wf.clock.matchEndsAt = Date.now() + warfront.WF_TICK_MS;
  wf.bases.blue.hp = 10;
  t.mock.timers.tick(warfront.WF_TICK_MS);
  assert.equal(s.room.phase, 'gameover');
  const oldStart = wf.clock.startedAt;

  const refused = await call(s.sockets.Bob, 'playAgainWarfront');
  assert.equal(refused.ok, false);
  assert.match(refused.error, /host or a captain/);
  assert.equal(s.room.phase, 'gameover');

  // A captain may (D1).
  s.room.players.get('Bob').leader = true;
  t.mock.timers.tick(1000);
  const restore = mockOpenAiFailure();
  try {
    assert.equal((await call(s.sockets.Bob, 'playAgainWarfront')).ok, true);
    await flush();
    await flush();
  } finally {
    restore();
  }
  assert.equal(s.room.phase, 'playing');
  assert.equal(wf.winner, null);
  assert.ok(wf.clock.startedAt > oldStart);
  assert.equal(wf.clock.endedAt, undefined);
  assert.equal(wf.bases.blue.hp, engine.TUNING.baseHp);
  assert.deepEqual(Object.keys(wf.armies).sort(), ['Ann', 'Bob', 'Cat', 'Host'], 'same teams');
  assert.equal(wf.armies.Ann.race, 'horde', 'same races');
  for (const a of Object.values(wf.armies)) assert.deepEqual(a.stats, { kills: 0, lost: 0, baseDmg: 0 });
  assert.ok(warfront.wfLoops.has('WFWF'), 'the new battle runs');
  assert.deepEqual(s.room.scoreboard, { Host: 2, Ann: 2 }, 'points from the first battle stay');
});

test('playAgainWarfront: refused when a team has emptied', async (t) => {
  const s = await playingRoom(t);
  const wf = s.room.state.warfront;
  wf.clock.matchEndsAt = Date.now() + warfront.WF_TICK_MS;
  t.mock.timers.tick(warfront.WF_TICK_MS);
  s.room.players.get('Bob').connected = false;
  s.room.players.get('Cat').connected = false;
  const res = await call(s.sockets.Host, 'playAgainWarfront');
  assert.equal(res.ok, false);
  assert.match(res.error, /Blue team/);
  assert.equal(s.room.phase, 'gameover');
});

test('game over: reconnect lands on the final screen; back to lobby clears the battle', async (t) => {
  const s = await playingRoom(t);
  const wf = s.room.state.warfront;
  wf.clock.matchEndsAt = Date.now() + warfront.WF_TICK_MS;
  wf.bases.red.hp = 50;
  t.mock.timers.tick(warfront.WF_TICK_MS);
  const res = warfront.reconnectPayload(s.ctx, s.room, s.room.players.get('Ann'));
  assert.equal(res.ok, true);
  assert.equal(res.phase, 'gameover');
  assert.equal(res.winner, 'blue');
  assert.equal(res.you, 'Ann');
  assert.equal(res.myTeam, 'red');
  assert.ok(res.map && res.stats.length === 4);
  assert.equal(warfront.repairOnLoad(s.ctx, s.room), undefined);
  assert.equal(s.room.phase, 'gameover', 'repairOnLoad leaves gameover alone');

  s.room.game = null;
  s.room.phase = 'lobby';
  warfront.clearState(s.room, 'WFWF');
  assert.equal(s.room.state.warfront.winner, null);
  assert.equal(s.room.state.warfront.map, null);
});
