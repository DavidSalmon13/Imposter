/**
 * Google sign-in, login sessions, the Player Card, and recording finished games to
 * Postgres. See plans/accounts-plan.md for the design.
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
const { BADGES, publicBadge } = require('./badges');

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
 * Whose data a query covers, as a WHERE clause on `players p`: a signed-in user spans
 * every device they've claimed; a guest is just one browser.
 */
function scopeFor({ userId, clientId }) {
  if (userId) {
    return { where: 'p.user_id = $1', notWhere: 'tp.user_id IS DISTINCT FROM $1', param: userId };
  }
  if (clientId) return { where: 'p.client_id = $1', notWhere: 'tp.client_id <> $1', param: clientId };
  return null;
}

const MAX_RIVALS = 5;

/**
 * Head-to-head records against everyone this identity has shared a game with. An
 * opponent is their account if they have one (all their devices together), else their
 * device. In each shared game the better result wins: a win beats a loss, and with the
 * same outcome more points beats fewer; anything else (e.g. teammates) is a draw.
 * Returns opponents most-played first (the top `limit`, or all with limit = Infinity):
 * [{ key, name, games, wins, losses, byGame: { [type]: { games, wins, losses } } }]
 * `key` is 'u<userId>' or 'p<playerId>' - see opponentKey().
 */
async function rivalries(scope, limit = MAX_RIVALS) {
  const { rows } = await db.query(
    `WITH me AS (
       SELECT gp.game_id, coalesce(gp.won, false)::int AS won, gp.points
         FROM game_participants gp JOIN players p ON p.id = gp.player_id
        WHERE ${scope.where}
     )
     SELECT CASE WHEN tp.user_id IS NOT NULL THEN 'u' || tp.user_id ELSE 'p' || tp.id END AS opponent,
            g.game_type,
            count(*)::int AS games,
            count(*) FILTER (WHERE (me.won, me.points) > (coalesce(t.won, false)::int, t.points))::int AS wins,
            count(*) FILTER (WHERE (me.won, me.points) < (coalesce(t.won, false)::int, t.points))::int AS losses,
            (array_agg(t.name_used ORDER BY g.ended_at DESC, g.id DESC))[1] AS name,
            max(g.ended_at) AS last_played
       FROM me
       JOIN game_participants t ON t.game_id = me.game_id
       JOIN players tp ON tp.id = t.player_id
       JOIN games g ON g.id = me.game_id
      WHERE ${scope.notWhere}
      GROUP BY opponent, g.game_type`,
    [scope.param]
  );
  const byOpponent = new Map();
  for (const r of rows) {
    let o = byOpponent.get(r.opponent);
    if (!o) {
      o = { key: r.opponent, name: r.name, last: r.last_played, games: 0, wins: 0, losses: 0, byGame: {} };
      byOpponent.set(r.opponent, o);
    }
    // Show the name they used most recently across all game types.
    if (r.last_played > o.last) {
      o.name = r.name;
      o.last = r.last_played;
    }
    o.games += r.games;
    o.wins += r.wins;
    o.losses += r.losses;
    o.byGame[r.game_type] = { games: r.games, wins: r.wins, losses: r.losses };
  }
  return [...byOpponent.values()]
    .sort((a, b) => b.games - a.games || b.last - a.last)
    .slice(0, limit)
    .map(({ last, ...o }) => o);
}

/** Same identity key rivalries() uses for an opponent. */
function opponentKey(player) {
  return player.user_id ? `u${player.user_id}` : `p${player.id}`;
}

/** +1 if a beat b in a game, -1 if b beat a, 0 for a draw (same rule as rivalries()). */
function compareResults(a, b) {
  const aw = a.won ? 1 : 0;
  const bw = b.won ? 1 : 0;
  if (aw !== bw) return aw > bw ? 1 : -1;
  if (a.points !== b.points) return a.points > b.points ? 1 : -1;
  return 0;
}

const MIN_RIVALRY_GAMES = 3;

/** One-line story of what this game did to a head-to-head record (after the game). */
function rivalryLine(opponent, beat, wins, losses) {
  const record = `${wins}–${losses}`;
  if (beat) {
    if (wins === losses) return `You drew level with ${opponent}: ${record} all-time`;
    if (wins === losses + 1) return `You took the lead over ${opponent}! ${record} all-time`;
    if (wins > losses) return `You beat ${opponent} again: ${record} all-time`;
    return `You beat ${opponent}, closing in: ${record} all-time`;
  }
  if (wins === losses) return `${opponent} drew level with you: ${record} all-time`;
  if (losses === wins + 1) return `${opponent} took the lead over you: ${record} all-time`;
  if (losses > wins) return `${opponent} beat you again: ${record} all-time`;
  return `${opponent} got you, but you still lead: ${record} all-time`;
}

/**
 * For each participant of a just-recorded game, picks the opponent in it they've
 * played most (among those this game had a winner between, with at least
 * MIN_RIVALRY_GAMES together) and calls onRivalry(name, { text, beat }). Never throws.
 */
async function announceRivalries(recorded, onRivalry) {
  try {
    const ids = recorded.map((r) => r.playerId);
    const { rows } = await db.query('SELECT id, client_id, user_id FROM players WHERE id = ANY($1)', [ids]);
    const players = new Map(rows.map((p) => [String(p.id), p]));
    for (const me of recorded) {
      const mine = players.get(String(me.playerId));
      if (!mine) continue;
      const records = new Map(
        (await rivalries(scopeFor({ userId: mine.user_id, clientId: mine.client_id }), Infinity))
          .map((r) => [r.key, r])
      );
      let best = null;
      for (const other of recorded) {
        const theirs = players.get(String(other.playerId));
        if (!theirs || opponentKey(theirs) === opponentKey(mine)) continue;
        const result = compareResults(me, other);
        const record = records.get(opponentKey(theirs));
        if (!result || !record || record.games < MIN_RIVALRY_GAMES) continue;
        if (!best || record.games > best.record.games) best = { other, record, beat: result > 0 };
      }
      if (best) {
        onRivalry(me.name, {
          beat: best.beat,
          text: rivalryLine(best.other.name, best.beat, best.record.wins, best.record.losses),
        });
      }
    }
  } catch (err) {
    console.error('Rivalry announcement failed:', err.message);
  }
}

/** Badge ids already earned anywhere in this scope. */
async function earnedBadgeIds(scope) {
  const { rows } = await db.query(
    `SELECT DISTINCT a.badge_id FROM achievements a JOIN players p ON p.id = a.player_id
      WHERE ${scope.where}`,
    [scope.param]
  );
  return new Set(rows.map((r) => r.badge_id));
}

/**
 * Checks every badge against the full history of the identity that `playerId` belongs
 * to (the whole account if it's claimed), records newly earned ones on `playerId`, and
 * returns them. Never throws.
 */
async function evaluateBadges(playerId, gameId = null) {
  try {
    const owner = await db.query('SELECT client_id, user_id FROM players WHERE id = $1', [playerId]);
    if (!owner.rows.length) return [];
    const scope = scopeFor({ userId: owner.rows[0].user_id, clientId: owner.rows[0].client_id });
    const earned = await earnedBadgeIds(scope);
    const pending = BADGES.filter((b) => !earned.has(b.id));
    if (!pending.length) return [];

    const { rows } = await db.query(
      `SELECT g.game_type, gp.role, gp.team, gp.won, gp.points, gp.details
         FROM game_participants gp
         JOIN players p ON p.id = gp.player_id
         JOIN games g   ON g.id = gp.game_id
        WHERE ${scope.where}
        ORDER BY g.ended_at, g.id`,
      [scope.param]
    );
    const history = rows.map((r) => ({
      gameType: r.game_type,
      role: r.role,
      team: r.team,
      won: r.won,
      points: r.points,
      details: r.details || {},
    }));

    const fresh = [];
    for (const badge of pending) {
      if (!badge.check(history)) continue;
      const ins = await db.query(
        `INSERT INTO achievements (player_id, badge_id, game_id) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [playerId, badge.id, gameId]
      );
      if (ins.rowCount) fresh.push(publicBadge(badge));
    }
    return fresh;
  } catch (err) {
    console.error('Badge evaluation failed:', err.message);
    return [];
  }
}

/** sticker filename -> ids of the badges that unlock it. */
const BADGE_STICKERS = new Map();
for (const b of BADGES) {
  if (!b.sticker) continue;
  if (!BADGE_STICKERS.has(b.sticker)) BADGE_STICKERS.set(b.sticker, []);
  BADGE_STICKERS.get(b.sticker).push(b.id);
}

/**
 * Whether this browser may wear `sticker`. Stickers used as badge art are locked until
 * one of their badges is earned (by this device, or by the account it's linked to);
 * every other sticker is free. Fails open: no database, or a database error, means
 * nothing is locked.
 */
async function canUseSticker(clientId, sticker) {
  const badgeIds = BADGE_STICKERS.get(sticker);
  if (!badgeIds || !db.isEnabled()) return true;
  const id = cleanClientId(clientId);
  if (!id) return false;
  try {
    const { rows } = await db.query('SELECT user_id FROM players WHERE client_id = $1', [id]);
    if (!rows.length) return false;
    const earned = await earnedBadgeIds(scopeFor({ userId: rows[0].user_id, clientId: id }));
    return badgeIds.some((b) => earned.has(b));
  } catch (err) {
    console.error('Sticker unlock check failed:', err.message);
    return true;
  }
}

/**
 * Lifetime stats for the user (every device they've claimed) or, for a guest, for
 * this one browser. Shape: { gamesPlayed, wins, points, byGame: { [type]: {...} },
 * badges: [{ id, emoji, sticker, name, description, earned }], rivals: [...] }
 * (rivals: see rivalries()).
 */
async function playerCard({ userId, clientId }) {
  const scope = scopeFor({ userId, clientId });
  if (!scope) return null;
  const { where, param } = scope;
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
  const earned = await earnedBadgeIds(scope);
  const badges = BADGES.map((b) => ({ ...publicBadge(b), earned: earned.has(b.id) }));
  const lockedStickers = [...BADGE_STICKERS]
    .filter(([, ids]) => !ids.some((id) => earned.has(id)))
    .map(([sticker]) => sticker);
  return {
    gamesPlayed,
    wins,
    points,
    byGame,
    badges,
    lockedStickers,
    rivals: await rivalries(scope),
  };
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
    res.json({
      enabled: signInEnabled(),
      // Game history (and so badges and sticker locks) works even without sign-in.
      history: db.isEnabled(),
      googleClientId: signInEnabled() ? GOOGLE_CLIENT_ID : null,
    });
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
      // Merging this device's history into the account can complete new badges.
      const device = await db.query(
        'SELECT id FROM players WHERE client_id = $1 AND user_id = $2',
        [cleanClientId(req.body.clientId), userId]
      );
      const newBadges = device.rows.length ? await evaluateBadges(device.rows[0].id) : [];
      const { rows } = await db.query(
        'SELECT id, display_name, email, avatar_url FROM users WHERE id = $1',
        [userId]
      );
      res.json({ ok: true, user: publicUser(rows[0]), card: await playerCard({ userId }), newBadges });
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
 * onBadges(name, badges) is called for each participant who earned new badges, and
 * onRivalry(name, { text, beat }) with a head-to-head update (see announceRivalries).
 */
function recordGameResult({ roomCode, gameType, participants, onBadges, onRivalry }) {
  if (!db.isEnabled()) return;
  const rows = (participants || []).filter((p) => cleanClientId(p.clientId));
  if (!rows.length) return;
  const recorded = [];
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
      recorded.push({
        name: p.name,
        playerId: player.rows[0].id,
        won: p.won === true,
        points: Number(p.points) || 0,
      });
    }
    return gameId;
  })
    .then(async (gameId) => {
      for (const { name, playerId } of recorded) {
        const badges = await evaluateBadges(playerId, gameId);
        if (badges.length && onBadges) onBadges(name, badges);
      }
      if (onRivalry) await announceRivalries(recorded, onRivalry);
    })
    .catch((err) => console.error(`Failed to record ${gameType} result:`, err.message));
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

module.exports = { registerAccountRoutes, recordGameResult, canUseSticker, startCleanup };
