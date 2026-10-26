/**
 * Owner-only admin page at /admin: what's happening right now (rooms, players, the
 * activity feed), moderation (kick, make host, end game, announce, ban), and account
 * management (search, rename, ban, delete) plus recent game history from Postgres.
 *
 * Access: only a Google-signed-in account (the normal Shorot sign-in, server/accounts.js)
 * whose verified email is listed in ADMIN_EMAILS (comma-separated). Unset = nobody is an
 * admin. So the page needs DATABASE_URL and GOOGLE_CLIENT_ID; the session cookie is the
 * regular SameSite=Lax login cookie, and every mutating route takes JSON, which a
 * cross-site form can't send without a preflight.
 */
const path = require('path');
const express = require('express');
const db = require('./db');
const stats = require('./stats');
const { logActivity, recentActivity } = require('./activity');
const accounts = require('./accounts');
const {
  connectedNames,
  scoreboardEntries,
  broadcastLobby,
  setHost,
  resetToLobby,
  kickPlayer,
} = require('./lobby');

const MAX_ANNOUNCEMENT = 200;
const STARTED_AT = Date.now();

function adminEmails() {
  return (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** The signed-in admin for this request, or null. */
async function adminFromRequest(req) {
  const allowed = adminEmails();
  if (!allowed.length || !db.isEnabled()) return null;
  const user = await accounts.userFromRequest(req);
  // users.email is only ever stored when Google says it's verified.
  return user && user.email && allowed.includes(String(user.email).toLowerCase()) ? user : null;
}

async function requireAdmin(req, res, next) {
  try {
    const user = await adminFromRequest(req);
    if (!user) return res.status(403).json({ ok: false, error: 'Not an admin' });
    req.admin = user;
    next();
  } catch (err) {
    console.error('Admin check failed:', err.message);
    res.status(500).json({ ok: false, error: 'Something went wrong' });
  }
}

function requireDb(req, res, next) {
  if (!db.isEnabled()) return res.status(503).json({ ok: false, error: 'Database not configured' });
  next();
}

/** Wraps an async route so a thrown error becomes a 500 instead of an unhandled rejection. */
function route(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error(`Admin ${req.method} ${req.path} failed:`, err.message);
      if (!res.headersSent) res.status(500).json({ ok: false, error: 'Something went wrong' });
    });
  };
}

function userIdParam(req) {
  const id = Number(req.params.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function roomSummary(code, room) {
  return {
    code,
    game: room.game,
    phase: room.phase,
    host: room.hostName,
    players: Array.from(room.players.entries()).map(([name, p]) => ({
      name,
      connected: !!p.connected,
      signedIn: !!p.signedIn,
      userId: p.userId || null,
      clientId: p.clientId || null,
      host: name === room.hostName,
    })),
    scoreboard: scoreboardEntries(room),
  };
}

function registerAdminRoutes(app, { ctx }) {
  const json = express.json({ limit: '4kb' });

  function findRoom(req, res) {
    const code = String((req.body && req.body.room) || '');
    const room = ctx.rooms.get(code);
    if (!room) {
      res.status(404).json({ ok: false, error: 'Room not found' });
      return null;
    }
    return { code, room };
  }

  /** Drops every live connection belonging to this account or device (after a ban). */
  function kickEverywhere(match) {
    for (const [code, room] of ctx.rooms) {
      for (const [name, p] of room.players) {
        if (match(p)) kickPlayer(code, room, name, { reason: 'You have been banned', force: true });
      }
    }
  }

  app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
  });

  // Who's looking at /admin: lets the page say "sign in" vs "this account isn't an admin".
  app.get('/api/admin/me', async (req, res) => {
    try {
      const user = db.isEnabled() ? await accounts.userFromRequest(req) : null;
      const admin = await adminFromRequest(req);
      res.json({
        ok: true,
        signedIn: !!user,
        name: user ? user.display_name : null,
        admin: !!admin,
        configured: adminEmails().length > 0,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: 'Something went wrong' });
    }
  });

  // Everything the Live tab shows, polled every few seconds.
  app.get('/api/admin/overview', requireAdmin, (req, res) => {
    const memory = process.memoryUsage();
    res.json({
      ok: true,
      server: {
        startedAt: STARTED_AT,
        uptimeMs: Date.now() - STARTED_AT,
        sockets: ctx.io.engine ? ctx.io.engine.clientsCount : null,
        memoryMb: Math.round(memory.rss / 1024 / 1024),
        database: db.isEnabled(),
      },
      today: stats.todaySummary(),
      rooms: Array.from(ctx.rooms.entries()).map(([code, room]) => roomSummary(code, room)),
      activity: recentActivity(200),
    });
  });

  app.post('/api/admin/kick', requireAdmin, json, (req, res) => {
    const found = findRoom(req, res);
    if (!found) return;
    const name = String(req.body.name || '');
    const error = kickPlayer(found.code, found.room, name);
    if (error) return res.status(409).json({ ok: false, error });
    logActivity('admin', `Admin kicked ${name}`);
    res.json({ ok: true });
  });

  app.post('/api/admin/host', requireAdmin, json, (req, res) => {
    const found = findRoom(req, res);
    if (!found) return;
    const name = String(req.body.name || '');
    const player = found.room.players.get(name);
    if (!player || !player.connected) return res.status(409).json({ ok: false, error: 'Player is not connected' });
    setHost(found.code, found.room, name);
    if (found.room.phase === 'lobby') broadcastLobby(found.code, found.room);
    logActivity('admin', `Admin made ${name} the host`);
    res.json({ ok: true });
  });

  app.post('/api/admin/end-game', requireAdmin, json, (req, res) => {
    const found = findRoom(req, res);
    if (!found) return;
    const { game } = found.room;
    resetToLobby(found.code, found.room);
    logActivity('admin', `Admin ended ${game || 'the game'} in ${found.code}`);
    res.json({ ok: true });
  });

  app.post('/api/admin/reset-scoreboard', requireAdmin, json, (req, res) => {
    const found = findRoom(req, res);
    if (!found) return;
    found.room.scoreboard = {};
    broadcastLobby(found.code, found.room);
    logActivity('admin', `Admin reset the scoreboard in ${found.code}`);
    res.json({ ok: true });
  });

  // A banner on every phone in the room (see 'adminAnnouncement' in public/js/main.js).
  app.post('/api/admin/announce', requireAdmin, json, (req, res) => {
    const found = findRoom(req, res);
    if (!found) return;
    const message = String(req.body.message || '').trim().slice(0, MAX_ANNOUNCEMENT);
    if (!message) return res.status(400).json({ ok: false, error: 'Message is empty' });
    ctx.roomEmit(found.code, 'adminAnnouncement', { message });
    logActivity('admin', `Admin announced: ${message}`);
    res.json({ ok: true });
  });

  // Bans one device (by clientId), guest or signed in. Live connections from it are dropped.
  app.post('/api/admin/devices/ban', requireAdmin, requireDb, json, route(async (req, res) => {
    const clientId = String(req.body.clientId || '').trim().slice(0, 64);
    if (!clientId) return res.status(400).json({ ok: false, error: 'Missing device' });
    const banned = req.body.banned !== false;
    await db.query(
      `INSERT INTO players (client_id, banned_at) VALUES ($1, CASE WHEN $2 THEN now() END)
       ON CONFLICT (client_id) DO UPDATE SET banned_at = CASE WHEN $2 THEN now() END`,
      [clientId, banned]
    );
    if (banned) kickEverywhere((p) => p.clientId === clientId);
    const who = req.body.name ? `${String(req.body.name).slice(0, 40)}'s device` : 'a device';
    logActivity('admin', `Admin ${banned ? 'banned' : 'unbanned'} ${who}`);
    res.json({ ok: true });
  }));

  app.get('/api/admin/devices/banned', requireAdmin, requireDb, route(async (req, res) => {
    const { rows } = await db.query(
      `SELECT p.client_id, p.banned_at, p.last_seen, u.display_name,
              (SELECT gp.name_used FROM game_participants gp JOIN games g ON g.id = gp.game_id
                WHERE gp.player_id = p.id ORDER BY g.ended_at DESC LIMIT 1) AS last_name
         FROM players p LEFT JOIN users u ON u.id = p.user_id
        WHERE p.banned_at IS NOT NULL
        ORDER BY p.banned_at DESC`
    );
    res.json({ ok: true, devices: rows });
  }));

  app.get('/api/admin/users', requireAdmin, requireDb, route(async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 80);
    const pattern = q ? `%${q.replace(/[\\%_]/g, '\\$&')}%` : null;
    const { rows } = await db.query(
      `SELECT u.id, u.display_name, u.email, u.avatar_url, u.created_at, u.banned_at,
              COUNT(DISTINCT p.id)::int AS devices,
              MAX(p.last_seen) AS last_seen,
              COUNT(gp.game_id)::int AS games,
              COUNT(gp.game_id) FILTER (WHERE gp.won)::int AS wins
         FROM users u
         LEFT JOIN players p ON p.user_id = u.id
         LEFT JOIN game_participants gp ON gp.player_id = p.id
        WHERE $1::text IS NULL OR u.display_name ILIKE $1 OR u.email ILIKE $1
        GROUP BY u.id
        ORDER BY MAX(p.last_seen) DESC NULLS LAST, u.id DESC
        LIMIT 200`,
      [pattern]
    );
    const totals = await db.query(
      `SELECT (SELECT COUNT(*) FROM users)::int AS users,
              (SELECT COUNT(*) FROM users WHERE banned_at IS NOT NULL)::int AS banned_users,
              (SELECT COUNT(*) FROM players WHERE user_id IS NULL)::int AS guests,
              (SELECT COUNT(*) FROM players WHERE banned_at IS NOT NULL)::int AS banned_devices,
              (SELECT COUNT(*) FROM games)::int AS games`
    );
    res.json({ ok: true, users: rows, totals: totals.rows[0] });
  }));

  app.get('/api/admin/users/:id', requireAdmin, requireDb, route(async (req, res) => {
    const id = userIdParam(req);
    if (!id) return res.status(400).json({ ok: false, error: 'Bad user id' });
    const user = await db.query(
      `SELECT u.id, u.display_name, u.email, u.avatar_url, u.sticker, u.created_at, u.banned_at,
              (SELECT COUNT(*) FROM auth_sessions s WHERE s.user_id = u.id AND s.expires_at > now())::int AS sessions,
              (SELECT array_agg(provider) FROM user_identities i WHERE i.user_id = u.id) AS providers
         FROM users u WHERE u.id = $1`,
      [id]
    );
    if (!user.rows.length) return res.status(404).json({ ok: false, error: 'User not found' });
    const devices = await db.query(
      `SELECT client_id, created_at, last_seen, banned_at FROM players
        WHERE user_id = $1 ORDER BY last_seen DESC`,
      [id]
    );
    const games = await db.query(
      `SELECT g.id, g.game_type, g.ended_at, gp.name_used, gp.won, gp.points, gp.role, gp.team
         FROM game_participants gp
         JOIN players p ON p.id = gp.player_id
         JOIN games g ON g.id = gp.game_id
        WHERE p.user_id = $1
        ORDER BY g.ended_at DESC
        LIMIT 30`,
      [id]
    );
    const badges = await db.query(
      `SELECT DISTINCT a.badge_id FROM achievements a JOIN players p ON p.id = a.player_id
        WHERE p.user_id = $1`,
      [id]
    );
    res.json({
      ok: true,
      user: user.rows[0],
      devices: devices.rows,
      games: games.rows,
      badges: badges.rows.map((r) => r.badge_id),
    });
  }));

  // { displayName? , banned? } - either or both.
  app.post('/api/admin/users/:id', requireAdmin, requireDb, json, route(async (req, res) => {
    const id = userIdParam(req);
    if (!id) return res.status(400).json({ ok: false, error: 'Bad user id' });
    const found = await db.query('SELECT display_name FROM users WHERE id = $1', [id]);
    if (!found.rows.length) return res.status(404).json({ ok: false, error: 'User not found' });
    const label = found.rows[0].display_name;

    if (req.body.displayName !== undefined) {
      const displayName = String(req.body.displayName || '').trim().slice(0, 80);
      if (!displayName) return res.status(400).json({ ok: false, error: 'Name is empty' });
      await db.query('UPDATE users SET display_name = $2 WHERE id = $1', [id, displayName]);
      logActivity('admin', `Admin renamed account ${label} to ${displayName}`);
    }
    if (typeof req.body.banned === 'boolean') {
      await db.query(
        'UPDATE users SET banned_at = CASE WHEN $2 THEN now() END WHERE id = $1',
        [id, req.body.banned]
      );
      if (req.body.banned) {
        await db.query('DELETE FROM auth_sessions WHERE user_id = $1', [id]);
        const devices = await db.query('SELECT client_id FROM players WHERE user_id = $1', [id]);
        const clientIds = new Set(devices.rows.map((r) => r.client_id));
        kickEverywhere((p) => String(p.userId || '') === String(id) || clientIds.has(p.clientId));
      }
      logActivity('admin', `Admin ${req.body.banned ? 'banned' : 'unbanned'} account ${label}`);
    }
    res.json({ ok: true });
  }));

  app.delete('/api/admin/users/:id', requireAdmin, requireDb, route(async (req, res) => {
    const id = userIdParam(req);
    if (!id) return res.status(400).json({ ok: false, error: 'Bad user id' });
    const found = await db.query('SELECT display_name FROM users WHERE id = $1', [id]);
    if (!found.rows.length) return res.status(404).json({ ok: false, error: 'User not found' });
    await accounts.deleteUser(id);
    logActivity('admin', `Admin deleted account ${found.rows[0].display_name}`);
    res.json({ ok: true });
  }));

  app.get('/api/admin/games', requireAdmin, requireDb, route(async (req, res) => {
    const type = String(req.query.type || '').slice(0, 40) || null;
    const { rows } = await db.query(
      `SELECT g.id, g.room_code, g.game_type, g.ended_at,
              json_agg(json_build_object(
                'name', gp.name_used, 'won', gp.won, 'points', gp.points,
                'role', gp.role, 'team', gp.team, 'userId', p.user_id
              ) ORDER BY gp.points DESC, gp.name_used) AS participants
         FROM games g
         JOIN game_participants gp ON gp.game_id = g.id
         JOIN players p ON p.id = gp.player_id
        WHERE $1::text IS NULL OR g.game_type = $1
        GROUP BY g.id
        ORDER BY g.ended_at DESC
        LIMIT 100`,
      [type]
    );
    res.json({ ok: true, games: rows });
  }));
}

module.exports = { registerAdminRoutes };
