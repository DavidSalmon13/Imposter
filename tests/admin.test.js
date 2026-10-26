'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.ADMIN_EMAILS = 'Owner@Example.com, second@example.com';
const db = require('../server/db');
const accounts = require('../server/accounts');
const lobby = require('../server/lobby');
const admin = require('../server/admin');
const { logActivity } = require('../server/activity');
const { createTestCtx, createRoom, emissionsForRoom } = require('./helpers/harness');

// Stands in for the Google login cookie: `Cookie: as=<email>` is "signed in as <email>".
const USERS = {
  'owner@example.com': { id: 1, display_name: 'Owner', email: 'owner@example.com' },
  'player@example.com': { id: 2, display_name: 'Player', email: 'player@example.com' },
};

/**
 * Real express app with the admin routes, on an ephemeral port. The database is reported
 * up (admin access needs a login) and accounts.userFromRequest is stubbed from the cookie.
 * request() sends as the owner unless `as` names another email (or null for signed out).
 */
async function startAdmin(t) {
  const { ctx, io } = createTestCtx();
  t.mock.method(db, 'isEnabled', () => true);
  t.mock.method(accounts, 'userFromRequest', async (req) => {
    const m = /(?:^|;\s*)as=([^;]+)/.exec(req.headers.cookie || '');
    return (m && USERS[m[1]]) || null;
  });
  lobby.initLobby({ ctx, BACKGROUNDS_DIR: '/tmp' });
  const app = express();
  admin.registerAdminRoutes(app, { ctx });
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(method, url, body, as = 'owner@example.com') {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(as ? { Cookie: `as=${as}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  }
  return { ctx, io, request };
}

test('admin: only an account listed in ADMIN_EMAILS gets in', async (t) => {
  const { ctx, request } = await startAdmin(t);
  createRoom(ctx, 'MAIN', ['Ann']);

  for (const as of [null, 'player@example.com']) {
    assert.equal((await request('GET', '/api/admin/overview', null, as)).status, 403);
    assert.equal((await request('POST', '/api/admin/kick', { room: 'MAIN', name: 'Ann' }, as)).status, 403);
  }
  assert.equal(ctx.rooms.get('MAIN').players.has('Ann'), true);

  const signedOut = await request('GET', '/api/admin/me', null, null);
  assert.deepEqual(
    [signedOut.body.signedIn, signedOut.body.admin, signedOut.body.configured],
    [false, false, true]
  );
  const player = await request('GET', '/api/admin/me', null, 'player@example.com');
  assert.deepEqual([player.body.signedIn, player.body.admin], [true, false]);
  // Email match is case-insensitive against ADMIN_EMAILS.
  const owner = await request('GET', '/api/admin/me');
  assert.deepEqual([owner.body.admin, owner.body.name], [true, 'Owner']);
  assert.equal((await request('GET', '/api/admin/overview')).status, 200);
});

test('admin: nobody is an admin when ADMIN_EMAILS is unset', async (t) => {
  const { request } = await startAdmin(t);
  const saved = process.env.ADMIN_EMAILS;
  delete process.env.ADMIN_EMAILS;
  t.after(() => { process.env.ADMIN_EMAILS = saved; });
  assert.equal((await request('GET', '/api/admin/overview')).status, 403);
  assert.equal((await request('GET', '/api/admin/me')).body.configured, false);
});

test('admin: overview lists rooms, players and the activity feed', async (t) => {
  const { ctx, request } = await startAdmin(t);
  const room = createRoom(ctx, 'MAIN', ['Ann', 'Bob']);
  room.players.get('Bob').connected = false;
  logActivity('join', 'Ann joined');

  const { status, body } = await request('GET', '/api/admin/overview');
  assert.equal(status, 200);
  assert.equal(body.rooms.length, 1);
  assert.equal(body.rooms[0].host, 'Ann');
  assert.deepEqual(body.rooms[0].players.map((p) => [p.name, p.connected]), [['Ann', true], ['Bob', false]]);
  assert.ok(body.activity.some((a) => a.message === 'Ann joined'));
});

test('admin: kick removes a lobby player and hands host on; refused mid-game', async (t) => {
  const { ctx, request } = await startAdmin(t);
  const room = createRoom(ctx, 'MAIN', ['Ann', 'Bob', 'Cat']);

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

  assert.equal((await request('POST', '/api/admin/end-game', { room: 'MAIN' })).status, 200);
  assert.equal(room.game, null);
  assert.equal(room.phase, 'lobby');
  assert.ok(emissionsForRoom(io, 'MAIN').some((e) => e.event === 'backToLobby'));
});

test('admin: make host, reset scoreboard, and announce', async (t) => {
  const { ctx, io, request } = await startAdmin(t);
  const room = createRoom(ctx, 'MAIN', ['Ann', 'Bob']);
  room.scoreboard = { Ann: 3 };

  assert.equal((await request('POST', '/api/admin/host', { room: 'MAIN', name: 'Bob' })).status, 200);
  assert.equal(room.hostName, 'Bob');

  assert.equal((await request('POST', '/api/admin/reset-scoreboard', { room: 'MAIN' })).status, 200);
  assert.deepEqual(room.scoreboard, {});

  assert.equal((await request('POST', '/api/admin/announce', { room: 'MAIN', message: '  ' })).status, 400);
  assert.equal((await request('POST', '/api/admin/announce', { room: 'MAIN', message: 'Pizza is here' })).status, 200);
  const notes = emissionsForRoom(io, 'MAIN').filter((e) => e.event === 'adminAnnouncement');
  assert.deepEqual(notes.map((e) => e.payload), [{ message: 'Pizza is here' }]);
});
