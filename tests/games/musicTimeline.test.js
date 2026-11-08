'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const musicTimeline = require('../../server/games/musicTimeline');
const {
  createTestCtx,
  createRoom,
  makeHandlerSocket,
  registerGame,
  call,
  mockOpenAi,
  flush,
} = require('../helpers/harness');

test('contract shape', () => {
  assert.equal(musicTimeline.id, 'musictimeline');
  assert.equal(musicTimeline.minPlayers, 2);
});

test('onChoose defaults to team mode with 2 teams', () => {
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob'], { game: null, phase: 'lobby' });
  musicTimeline.onChoose(ctx, 'AAAA', room);
  assert.equal(room.phase, 'teamSelect');
  assert.equal(room.state.musictimeline.mode, 'team');
  assert.deepEqual(Object.keys(room.state.musictimeline.teams), ['A', 'B']);
});

test('setMtTeamCount: host-only, requires team mode, bounded to [MIN,MAX] teams', async () => {
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob'], { game: 'musictimeline', phase: 'teamSelect' });
  musicTimeline.onChoose(ctx, 'AAAA', room);
  const host = registerGame(musicTimeline, ctx, makeHandlerSocket('AAAA', room.hostName));
  const other = registerGame(musicTimeline, ctx, makeHandlerSocket('AAAA', 'Bob'));

  const rejected = await call(other, 'setMtTeamCount', 3);
  assert.equal(rejected.ok, false);

  const outOfRange = await call(host, 'setMtTeamCount', 10);
  assert.equal(outOfRange.ok, false);

  const good = await call(host, 'setMtTeamCount', 3);
  assert.equal(good.ok, true);
  assert.deepEqual(Object.keys(room.state.musictimeline.teams), ['A', 'B', 'C']);
});

test('startMusicTimeline: each configured team needs at least 1 player', async () => {
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob'], { game: 'musictimeline', phase: 'teamSelect' });
  musicTimeline.onChoose(ctx, 'AAAA', room);
  const host = registerGame(musicTimeline, ctx, makeHandlerSocket('AAAA', room.hostName));
  const other = registerGame(musicTimeline, ctx, makeHandlerSocket('AAAA', 'Bob'));

  const emptyTeam = await call(host, 'startMusicTimeline');
  assert.equal(emptyTeam.ok, false, 'team B has nobody yet');

  await call(host, 'joinMtTeam', { teamId: 'A' });
  await call(other, 'joinMtTeam', { teamId: 'B' });
  const res = await call(host, 'startMusicTimeline');
  assert.equal(res.ok, true);
  assert.equal(room.phase, 'ready');
  assert.equal(room.state.musictimeline.teams.A.tokens, 2);
  assert.deepEqual(room.state.musictimeline.teams.A.timeline, []);
});

test('a correct placement is only committed to the timeline once the team stops (banks) the turn', async () => {
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob'], { game: 'musictimeline', phase: 'teamSelect' });
  musicTimeline.onChoose(ctx, 'AAAA', room);
  const host = registerGame(musicTimeline, ctx, makeHandlerSocket('AAAA', room.hostName));
  const other = registerGame(musicTimeline, ctx, makeHandlerSocket('AAAA', 'Bob'));
  await call(host, 'joinMtTeam', { teamId: 'A' });
  await call(other, 'joinMtTeam', { teamId: 'B' });
  await call(host, 'startMusicTimeline');

  const restore = mockOpenAi({ title: 'Song One', artist: 'Someone', releaseYear: 2000 });
  try {
    const nextTurn = await call(host, 'mtNextTurn');
    assert.equal(nextTurn.ok, true);
    await flush();
  } finally {
    restore();
  }

  assert.equal(room.phase, 'placing');
  assert.equal(room.state.musictimeline.currentSong.releaseYear, 2000);

  const place = await call(host, 'mtPlaceSong', { slotIndex: 0 });
  assert.equal(place.ok, true);
  assert.equal(room.phase, 'locked');

  const reveal = await call(host, 'mtReveal');
  assert.equal(reveal.ok, true);
  assert.equal(room.phase, 'revealed');
  assert.equal(room.state.musictimeline.revealResult.correct, true);
  assert.deepEqual(room.state.musictimeline.teams.A.timeline, [], 'not committed yet - only collected');
  assert.equal(room.state.musictimeline.turnCollected.length, 1);

  const stop = await call(host, 'mtStopTurn');
  assert.equal(stop.ok, true);
  assert.equal(room.state.musictimeline.teams.A.timeline.length, 1, 'banking commits the pile to the real timeline');
  assert.equal(room.state.musictimeline.turnOver, true);
});

test('an incorrect placement discards the whole turn-collected pile and ends the turn', async () => {
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob'], { game: 'musictimeline', phase: 'teamSelect' });
  musicTimeline.onChoose(ctx, 'AAAA', room);
  const host = registerGame(musicTimeline, ctx, makeHandlerSocket('AAAA', room.hostName));
  const other = registerGame(musicTimeline, ctx, makeHandlerSocket('AAAA', 'Bob'));
  await call(host, 'joinMtTeam', { teamId: 'A' });
  await call(other, 'joinMtTeam', { teamId: 'B' });
  await call(host, 'startMusicTimeline');

  // Team A already has one committed card (1980) plus one collected-but-not-banked card (2010)
  // from pushing their luck; the current song (1990) can only be correctly placed before 2010.
  room.state.musictimeline.teams.A.timeline = [{ title: 'Old', artist: 'X', releaseYear: 1980 }];
  room.state.musictimeline.turnCollected = [{ title: 'Pushed', artist: 'Y', releaseYear: 2010 }];
  room.state.musictimeline.currentSong = { title: 'New', artist: 'Z', releaseYear: 1990 };
  room.phase = 'placing';

  // Effective timeline is [1980, 2010]; placing at slotIndex 2 (after 2010) is wrong for 1990.
  const place = await call(host, 'mtPlaceSong', { slotIndex: 2 });
  assert.equal(place.ok, true);
  const reveal = await call(host, 'mtReveal');
  assert.equal(reveal.ok, true);

  assert.equal(room.state.musictimeline.revealResult.correct, false);
  assert.deepEqual(room.state.musictimeline.turnCollected, [], 'the pushed-luck pile is lost on a wrong guess');
  assert.equal(room.state.musictimeline.turnOver, true);
  assert.equal(room.state.musictimeline.teams.A.timeline.length, 1, 'the earlier committed card is untouched');
});

test('banking the 10th card ends the match and scores the scoreboard', async () => {
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob'], { game: 'musictimeline', phase: 'teamSelect' });
  musicTimeline.onChoose(ctx, 'AAAA', room);
  const host = registerGame(musicTimeline, ctx, makeHandlerSocket('AAAA', room.hostName));
  const other = registerGame(musicTimeline, ctx, makeHandlerSocket('AAAA', 'Bob'));
  await call(host, 'joinMtTeam', { teamId: 'A' });
  await call(other, 'joinMtTeam', { teamId: 'B' });
  await call(host, 'startMusicTimeline');

  room.state.musictimeline.teams.A.timeline = Array.from({ length: 9 }, (_, i) => ({
    title: `S${i}`,
    artist: 'X',
    releaseYear: 1900 + i,
  }));
  room.state.musictimeline.currentSong = { title: 'Last', artist: 'Z', releaseYear: 2020 };
  room.phase = 'placing';

  const place = await call(host, 'mtPlaceSong', { slotIndex: 9 });
  assert.equal(place.ok, true);
  await call(host, 'mtReveal');
  assert.equal(room.state.musictimeline.turnCollected.length, 1);

  const stop = await call(host, 'mtStopTurn');
  assert.equal(stop.ok, true);
  assert.equal(room.state.musictimeline.teams.A.timeline.length, 10);
  assert.equal(room.phase, 'gameover');
  assert.deepEqual(room.state.musictimeline.matchWinners, ['A']);
  assert.equal(room.scoreboard.Ann, 2, 'team A (2 teams) gets top points');
  assert.equal(room.scoreboard.Bob, 1);
});
