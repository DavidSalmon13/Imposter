'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const lobby = require('../server/lobby');
const { createTestCtx, createRoom, makeHandlerSocket, call, emissionsForRoom } = require('./helpers/harness');

function registerLobby(ctx, socket) {
  lobby.initLobby({ ctx, BACKGROUNDS_DIR: '/tmp' });
  lobby.registerLobbyHandlers(socket);
  return socket;
}

test('sendReaction: rejects stickers outside the curated whitelist', async () => {
  const { ctx } = createTestCtx();
  createRoom(ctx, 'AAAA', ['Ann', 'Bob']);
  const socket = registerLobby(ctx, makeHandlerSocket('AAAA', 'Ann'));

  const res = await call(socket, 'sendReaction', 'custom-not-on-the-list.webp');
  assert.equal(res.ok, false);
});

test('sendReaction: a valid reaction broadcasts to the whole room with the sender\'s name', async () => {
  const { ctx, io } = createTestCtx();
  createRoom(ctx, 'AAAA', ['Ann', 'Bob']);
  const socket = registerLobby(ctx, makeHandlerSocket('AAAA', 'Ann'));

  const sticker = '7818f961-efbf-41e6-94ee-99d8934cf823.webp';
  const res = await call(socket, 'sendReaction', sticker);
  assert.equal(res.ok, true);

  const broadcasts = emissionsForRoom(io, 'AAAA').filter((e) => e.event === 'reaction');
  assert.equal(broadcasts.length, 1);
  assert.deepEqual(broadcasts[0].payload, { name: 'Ann', sticker });
});

test('sendReaction: rate-limits rapid-fire reactions from the same socket', async () => {
  const { ctx, io } = createTestCtx();
  createRoom(ctx, 'AAAA', ['Ann', 'Bob']);
  const socket = registerLobby(ctx, makeHandlerSocket('AAAA', 'Ann'));
  const sticker = '7818f961-efbf-41e6-94ee-99d8934cf823.webp';

  const first = await call(socket, 'sendReaction', sticker);
  assert.equal(first.ok, true);
  const second = await call(socket, 'sendReaction', sticker);
  assert.equal(second.ok, false, 'too soon after the first reaction');

  const broadcasts = emissionsForRoom(io, 'AAAA').filter((e) => e.event === 'reaction');
  assert.equal(broadcasts.length, 1, 'the rate-limited attempt never broadcast');
});

test('leaveLobby: the player leaves the room and the scoreboard', async () => {
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob']);
  room.scoreboard = { Ann: 3, Bob: 5 };
  const socket = registerLobby(ctx, makeHandlerSocket('AAAA', 'Bob'));
  socket.leave = () => {};

  const res = await call(socket, 'leaveLobby');
  assert.equal(res.ok, true);
  assert.equal(room.players.has('Bob'), false);
  assert.deepEqual(room.scoreboard, { Ann: 3 });
});

test('sweepStalePlayers: drops players gone 30+ minutes, with their points', () => {
  const { ctx } = createTestCtx();
  lobby.initLobby({ ctx, BACKGROUNDS_DIR: '/tmp' });
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob', 'Cid']);
  room.scoreboard = { Ann: 1, Bob: 2, Cid: 3, LeftLongAgo: 4 };
  const now = Date.now();
  Object.assign(room.players.get('Bob'), { connected: false, disconnectedAt: now - 31 * 60 * 1000 });
  Object.assign(room.players.get('Cid'), { connected: false, disconnectedAt: now - 5 * 60 * 1000 });

  lobby.sweepStalePlayers(now);
  assert.deepEqual([...room.players.keys()], ['Ann', 'Cid'], 'Cid has only been gone 5 minutes');
  assert.deepEqual(room.scoreboard, { Ann: 1, Cid: 3 }, 'Bob and the orphaned entry are gone');
});

test('sweepStalePlayers: never removes anyone mid-game, and starts the clock for restored players', () => {
  const { ctx } = createTestCtx();
  lobby.initLobby({ ctx, BACKGROUNDS_DIR: '/tmp' });
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob', 'Cid'], { game: 'imposter', phase: 'playing' });
  const now = Date.now();
  Object.assign(room.players.get('Bob'), { connected: false, disconnectedAt: now - 60 * 60 * 1000 });
  Object.assign(room.players.get('Cid'), { connected: false }); // e.g. loaded from rooms.json

  lobby.sweepStalePlayers(now);
  assert.equal(room.players.size, 3);
  assert.equal(room.players.get('Cid').disconnectedAt, now);

  room.phase = 'lobby';
  room.game = null;
  lobby.sweepStalePlayers(now);
  assert.deepEqual([...room.players.keys()], ['Ann', 'Cid']);
});
