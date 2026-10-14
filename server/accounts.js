/**
 * Google sign-in, login sessions, the Player Card, and recording finished games to
 * Postgres. See implementation/accounts_plan.md for the design.
 *
 * Identity model: every browser already has a random `clientId` (localStorage). A
 * `players` row is keyed by it, and game results are recorded against it whether or
 * not the player is signed in. Signing in with Google attaches that `players` row to
 * the account, so everything earned as a guest is kept.
 *
 * Everything here is a no-op when the database is disabled (see server/db.js), and
 * sign-in is additionally disabled without GOOGLE_CLIENT_ID.
 */
const crypto = require('crypto');
const express = require('express');
const { OAuth2Client } = require('google-auth-library');
const db = require('./db');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const SESSION_COOKIE = 'shorot_session';
const SESSION_DAYS = 180;
// Guests who never sign in are forgotten after this long without playing.
const GUEST_RETENTION_DAYS = 60;
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

function signInEnabled() {
  return db.isEnabled() && !!googleClient;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function cleanClientId(value) {
  const id = String(value || '').trim();
  return id && id.length <= 64 ? id : null;
}

/** The signed-in user for this request, or null. */
async function userFromRequest(req) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const { rows } = await db.query(
    `SELECT u.id, u.display_name, u.email, u.avatar_url
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)]
  );
  return rows[0] || null;
}

/** Finds or creates the user for a verified Google ID token payload. */
async function upsertGoogleUser(client, payload) {
  const found = await client.query(
    `SELECT user_id FROM user_identities WHERE provider = 'google' AND provider_sub = $1`,
    [payload.sub]
  );
  const displayName = String(payload.name || payload.email || 'Player').slice(0, 80);
  const email = payload.email_verified ? payload.email : null;
  if (found.rows.length) {
    const userId = found.rows[0].user_id;
    // Keep the profile picture fresh; don't touch display_name (the player may rename later).
    await client.query('UPDATE users SET avatar_url = $2 WHERE id = $1', [userId, payload.picture || null]);
    return userId;
  }
  // ON CONFLICT: a different identity already claimed this email - don't fail sign-in over it.
  const created = await client.query(
    `INSERT INTO users (display_name, email, avatar_url)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO NOTHING
     RETURNING id`,
    [displayName, email, payload.picture || null]
  );
  const userId = created.rows.length
    ? created.rows[0].id
    : (await client.query(
        `INSERT INTO users (display_name, avatar_url) VALUES ($1, $2) RETURNING id`,
        [displayName, payload.picture || null]
      )).rows[0].id;
  await client.query(
    `INSERT INTO user_identities (user_id, provider, provider_sub) VALUES ($1, 'google', $2)`,
    [userId, payload.sub]
  );
  return userId;
}

/**
 * Attaches this browser's guest history to the user. A device already linked to a
 * different account is left alone, so signing in can never pull someone else's stats.
 */
async function claimClientId(client, userId, clientId) {
  if (!clientId) return;
  await client.query(
    `INSERT INTO players (client_id, user_id) VALUES ($1, $2)
     ON CONFLICT (client_id) DO UPDATE SET user_id = $2
       WHERE players.user_id IS NULL`,
    [clientId, userId]
  );
}

/**
 * Lifetime stats for the user (every device they've claimed) or, for a guest, for
 * this one browser. Shape: { gamesPlayed, wins, points, byGame: { [type]: {...} } }.
 */
async function playerCard({ userId, clientId }) {
  const where = userId ? 'p.user_id = $1' : 'p.client_id = $1';
  const param = userId || clientId;
  if (!param) return null;
  const { rows } = await db.query(
    `SELECT g.game_type,
            count(*)::int                              AS played,
            count(*) FILTER (WHERE gp.won)::int        AS won,
            coalesce(sum(gp.points), 0)::int           AS points
       FROM game_participants gp
       JOIN players p ON p.id = gp.player_id
       JOIN games g   ON g.id = gp.game_id
      WHERE ${where}
      GROUP BY g.game_type`,
    [param]
  );
  const byGame = {};
  let gamesPlayed = 0;
  let wins = 0;
  let points = 0;
  for (const r of rows) {
    byGame[r.game_type] = { played: r.played, won: r.won, points: r.points };
    gamesPlayed += r.played;
    wins += r.won;
    points += r.points;
  }
  return { gamesPlayed, wins, points, byGame };
}

function publicUser(u) {
  return { id: String(u.id), name: u.display_name, avatar: u.avatar_url || null };
}

function setSessionCookie(req, res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function registerAccountRoutes(app) {
  app.get('/api/auth/config', (req, res) => {
    res.json({ enabled: signInEnabled(), googleClientId: signInEnabled() ? GOOGLE_CLIENT_ID : null });
  });

  // Returns the signed-in user (if any) and the Player Card - the account's, or this
  // browser's guest stats so the lobby can show what signing in would keep.
  app.get('/api/me', async (req, res) => {
    if (!db.isEnabled()) return res.json({ enabled: false, user: null, card: null });
    try {
      const user = await userFromRequest(req);
      const card = await playerCard({
        userId: user && user.id,
        clientId: cleanClientId(req.query.clientId),
      });
      res.json({ enabled: signInEnabled(), user: user ? publicUser(user) : null, card });
    } catch (err) {
      console.error('GET /api/me failed:', err.message);
      res.status(500).json({ ok: false, error: 'Could not load your card' });
    }
  });

  app.post('/api/auth/google', express.json({ limit: '16kb' }), async (req, res) => {
    if (!signInEnabled()) return res.status(503).json({ ok: false, error: 'Sign-in is not available' });
    const credential = req.body && req.body.credential;
    if (typeof credential !== 'string' || !credential) {
      return res.status(400).json({ ok: false, error: 'Missing credential' });
    }
    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
      payload = ticket.getPayload();
    } catch (err) {
      return res.status(401).json({ ok: false, error: 'Google sign-in could not be verified' });
    }
    try {
      const token = crypto.randomBytes(32).toString('base64url');
      const userId = await db.transaction(async (client) => {
        const id = await upsertGoogleUser(client, payload);
        await claimClientId(client, id, cleanClientId(req.body.clientId));
        await client.query(
          `INSERT INTO auth_sessions (token_hash, user_id, expires_at)
           VALUES ($1, $2, now() + make_interval(days => $3))`,
          [hashToken(token), id, SESSION_DAYS]
        );
        return id;
      });
      setSessionCookie(req, res, token);
      const { rows } = await db.query(
        'SELECT id, display_name, email, avatar_url FROM users WHERE id = $1',
        [userId]
      );
      res.json({ ok: true, user: publicUser(rows[0]), card: await playerCard({ userId }) });
    } catch (err) {
      console.error('Google sign-in failed:', err.message);
      res.status(500).json({ ok: false, error: 'Sign-in failed, try again' });
    }
  });

  // Permanently erases the account and everything recorded for it: every linked device's
  // game history and badges, the Google link, and all sessions. Other players' rows in
  // shared games are kept; games left with no participants are removed.
  app.delete('/api/account', async (req, res) => {
    if (!db.isEnabled()) return res.status(503).json({ ok: false, error: 'Accounts are not available' });
    try {
      const user = await userFromRequest(req);
      if (!user) return res.status(401).json({ ok: false, error: 'Not signed in' });
      await db.transaction(async (client) => {
        // players -> game_participants/achievements cascade; users -> identities/sessions cascade.
        await client.query('DELETE FROM players WHERE user_id = $1', [user.id]);
        await client.query('DELETE FROM users WHERE id = $1', [user.id]);
        await client.query(
          `DELETE FROM games g
            WHERE NOT EXISTS (SELECT 1 FROM game_participants gp WHERE gp.game_id = g.id)`
        );
      });
      res.clearCookie(SESSION_COOKIE, { path: '/' });
      res.json({ ok: true });
    } catch (err) {
      console.error('Account deletion failed:', err.message);
      res.status(500).json({ ok: false, error: 'Could not delete your account, try again' });
    }
  });

  app.post('/api/auth/logout', async (req, res) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token && db.isEnabled()) {
      await db.query('DELETE FROM auth_sessions WHERE token_hash = $1', [hashToken(token)]).catch(() => {});
    }
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });
}

/**
 * Records one finished game. Called by game modules via ctx.recordGameResult once per
 * round/match that produced a result. Fire-and-forget: it never throws and never
 * delays the game - if the database is down the game just isn't recorded.
 *
 * participants: [{ clientId, name, role?, team?, won?, points?, details? }]
 * Participants without a clientId (very old clients) are skipped.
 */
function recordGameResult({ roomCode, gameType, participants }) {
  if (!db.isEnabled()) return;
  const rows = (participants || []).filter((p) => cleanClientId(p.clientId));
  if (!rows.length) return;
  db.transaction(async (client) => {
    const game = await client.query(
      'INSERT INTO games (room_code, game_type) VALUES ($1, $2) RETURNING id',
      [roomCode, gameType]
    );
    const gameId = game.rows[0].id;
    for (const p of rows) {
      const player = await client.query(
        `INSERT INTO players (client_id) VALUES ($1)
         ON CONFLICT (client_id) DO UPDATE SET last_seen = now()
         RETURNING id`,
        [cleanClientId(p.clientId)]
      );
      await client.query(
        `INSERT INTO game_participants (game_id, player_id, name_used, role, team, won, points, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (game_id, player_id) DO NOTHING`,
        [
          gameId,
          player.rows[0].id,
          String(p.name || '').slice(0, 80),
          p.role || null,
          p.team || null,
          typeof p.won === 'boolean' ? p.won : null,
          Number(p.points) || 0,
          JSON.stringify(p.details || {}),
        ]
      );
    }
  }).catch((err) => console.error(`Failed to record ${gameType} result:`, err.message));
}

/** Drops expired sessions and long-idle guests (and games left with no participants). */
async function cleanup() {
  if (!db.isEnabled()) return;
  try {
    await db.query('DELETE FROM auth_sessions WHERE expires_at < now()');
    await db.query(
      `DELETE FROM players
        WHERE user_id IS NULL AND last_seen < now() - make_interval(days => $1)`,
      [GUEST_RETENTION_DAYS]
    );
    await db.query(
      `DELETE FROM games g
        WHERE NOT EXISTS (SELECT 1 FROM game_participants gp WHERE gp.game_id = g.id)`
    );
  } catch (err) {
    console.error('Account cleanup failed:', err.message);
  }
}

function startCleanup() {
  cleanup();
  setInterval(cleanup, CLEANUP_INTERVAL_MS).unref();
}

module.exports = { registerAccountRoutes, recordGameResult, startCleanup };
