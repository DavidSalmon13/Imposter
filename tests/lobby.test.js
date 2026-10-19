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
