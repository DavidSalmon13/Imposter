'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.STATS_PASSWORD = 'test-admin-pw';
const lobby = require('../server/lobby');
const admin = require('../server/admin');
const { logActivity } = require('../server/activity');
const { createTestCtx, createRoom, emissionsForRoom } = require('./helpers/harness');

/** Real express app with the admin routes, on an ephemeral port, plus a logged-in fetch. */
async function startAdmin(t) {
  const { ctx, io } = createTestCtx();
  lobby.initLobby({ ctx, BACKGROUNDS_DIR: '/tmp' });
  const app = express();
  admin.registerAdminRoutes(app, { ctx });
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  let cookie = '';
  async function request(method, url, body) {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, body: await res.json() };
  }
  return { ctx, io, request };
}

test('admin: every API route needs a login, and a wrong password gets none', async (t) => {
  const { request } = await startAdmin(t);
  assert.equal((await request('GET', '/api/admin/overview')).status, 401);
  assert.equal((await request('POST', '/api/admin/kick', { room: 'MAIN', name: 'Ann' })).status, 401);

  const wrong = await request('POST', '/api/admin/login', { password: 'nope' });
  assert.equal(wrong.status, 401);
  assert.equal((await request('GET', '/api/admin/overview')).status, 401);
});

test('admin: overview lists rooms, players and the activity feed', async (t) => {
  const { ctx, request } = await startAdmin(t);
  const room = createRoom(ctx, 'MAIN', ['Ann', 'Bob']);
  room.players.get('Bob').connected = false;
  logActivity('join', 'Ann joined');

  assert.equal((await request('POST', '/api/admin/login', { password: 'test-admin-pw' })).status, 200);
  const { status, body } = await request('GET', '/api/admin/overview');
  assert.equal(status, 200);
  assert.equal(body.rooms.length, 1);
  assert.equal(body.rooms[0].host, 'Ann');
  assert.deepEqual(body.rooms[0].players.map((p) => [p.name, p.connected]), [['Ann', true], ['Bob', false]]);
  assert.ok(body.activity.some((a) => a.message === 'Ann joined'));
  assert.equal(body.server.database, false);
});

test('admin: kick removes a lobby player and hands host on; refused mid-game', async (t) => {
  const { ctx, request } = await startAdmin(t);
  const room = createRoom(ctx, 'MAIN', ['Ann', 'Bob', 'Cat']);
  await request('POST', '/api/admin/login', { password: 'test-admin-pw' });

  const kicked = await request('POST', '/api/admin/kick', { room: 'MAIN', name: 'Ann' });
  assert.equal(kicked.status, 200);
  assert.equal(room.players.has('Ann'), false);
  assert.equal(room.hostName, 'Bob');

  room.game = 'imposter';
  room.phase = 'playing';
  const refused = await request('POST', '/api/admin/kick', { room: 'MAIN', name: 'Cat' });
  assert.equal(refused.status, 409);
  assert.equal(room.players.has('Cat'), true);

  const missing = await request('POST', '/api/admin/kick', { room: 'NOPE', name: 'Cat' });
  assert.equal(missing.status, 404);
});

test('admin: end game sends the room back to the lobby', async (t) => {
  const { ctx, io, request } = await startAdmin(t);
  const room = createRoom(ctx, 'MAIN', ['Ann', 'Bob', 'Cat'], { game: 'imposter', phase: 'playing' });
  await request('POST', '/api/admin/login', { password: 'test-admin-pw' });

  assert.equal((await request('POST', '/api/admin/end-game', { room: 'MAIN' })).status, 200);
  assert.equal(room.game, null);
  assert.equal(room.phase, 'lobby');
  assert.ok(emissionsForRoom(io, 'MAIN').some((e) => e.event === 'backToLobby'));
});

test('admin: make host, reset scoreboard, and announce', async (t) => {
  const { ctx, io, request } = await startAdmin(t);
  const room = createRoom(ctx, 'MAIN', ['Ann', 'Bob']);
  room.scoreboard = { Ann: 3 };
  await request('POST', '/api/admin/login', { password: 'test-admin-pw' });

  assert.equal((await request('POST', '/api/admin/host', { room: 'MAIN', name: 'Bob' })).status, 200);
  assert.equal(room.hostName, 'Bob');

  assert.equal((await request('POST', '/api/admin/reset-scoreboard', { room: 'MAIN' })).status, 200);
  assert.deepEqual(room.scoreboard, {});

  assert.equal((await request('POST', '/api/admin/announce', { room: 'MAIN', message: '  ' })).status, 400);
  assert.equal((await request('POST', '/api/admin/announce', { room: 'MAIN', message: 'Pizza is here' })).status, 200);
  const notes = emissionsForRoom(io, 'MAIN').filter((e) => e.event === 'adminAnnouncement');
  assert.deepEqual(notes.map((e) => e.payload), [{ message: 'Pizza is here' }]);
});

test('admin: account routes answer 503 without a database', async (t) => {
  const { request } = await startAdmin(t);
  await request('POST', '/api/admin/login', { password: 'test-admin-pw' });
  assert.equal((await request('GET', '/api/admin/users')).status, 503);
  assert.equal((await request('GET', '/api/admin/games')).status, 503);
});
