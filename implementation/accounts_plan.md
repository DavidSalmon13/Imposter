# Accounts & Player Card — plan

Goal: give players a reason to sign in. Everyone plays as a guest exactly as before,
but every finished game is recorded. Signing in with Google keeps those stats forever
and across devices (the "Player Card"). Later: badges, rivalries, unlockable stickers.

## Status

Done (foundation):
- Postgres via `DATABASE_URL` (`server/db.js`), schema in `migrations/001_accounts.sql`,
  applied automatically on boot (tracked in `schema_migrations`).
- Google sign-in (`server/accounts.js`, `public/js/shared/account.js`), httpOnly
  session cookie, only a SHA-256 of the token stored.
- `ctx.recordGameResult(...)` hook, called by all eight games when a round/match
  awards scoreboard points.
- Lobby 👤 button → Player Card dropdown (guest stats + "Continue with Google", or the
  account's stats + Sign out).

Next:
1. Badges: definitions in code, evaluated after each `recordGameResult`, written to
   `achievements`. Show newly earned ones on the results screen with a "save it" prompt
   for guests (the main sign-up hook).
2. Rivalries (head-to-head from `game_participants` joined with itself on `game_id`).
3. Unlockable stickers gated on badges.

## Design

Room state is unchanged: in-memory `rooms` Map + `rooms.json`. Postgres only holds data
that must outlive a room, and is written once per finished game, never in the live loop.

**Identity.** Every browser already has a random `clientId` (localStorage). A `players`
row is keyed by it and game results attach to it, signed in or not. Signing in sets
`players.user_id`, so guest history is kept; signing in on more devices links each
device's `players` row to the same user. A device already linked to a different user is
never re-linked (signing in can't pull someone else's stats).

**Tables** (see the migration for exact columns):
- `users` — the account. `username` / `password_hash` are reserved for a possible
  password sign-in later; unused today.
- `user_identities` — (provider, provider_sub) → user. Google today.
- `players` — client_id → optional user_id.
- `games` + `game_participants` — one row per finished game and per participant
  (role, team, won, points, game-specific `details` JSONB). All stats are computed
  from these; no running totals to drift.
- `achievements` — earned badges (unused until badges ship).
- `auth_sessions` — hashed session tokens, 180-day expiry.

**Failure mode.** No `DATABASE_URL`, or Postgres unreachable at boot → accounts hidden,
games unaffected. Postgres dying at runtime → that game's result is logged as failed and
skipped; the game carries on.

**Retention.** A 6-hourly cleanup deletes expired sessions and guest `players` rows not
seen for 60 days (with their participations), then games left with no participants.

## Recording a game (for new games)

```js
ctx.recordGameResult(room, 'codenames', [
  { name, role, team, won, points, details },
]);
```

Call it right where the game calls `ctx.addScore` at round/match end. The ctx wrapper
in `server.js` fills in each player's `clientId` and the room code. Fire-and-forget;
it returns nothing and never throws.
`won` may be `null` for games without a per-player winner.

## Known limitations

- `clientId` is client-chosen, so someone who copies another browser's localStorage
  could have their games recorded to that player. Acceptable for party-game stats; if
  it ever matters, record by the session cookie's user instead.
- After signing out, games played on that device still go to the account its
  `players` row is linked to (devices are assumed to be personal phones).
- Playing in one game from two devices signed into the same account counts the game
  twice on the card.

## Setup (Railway + Google)

1. Railway: add a **Postgres** service to the project; on the Shorot service add the
   variable `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`.
2. Google Cloud Console → APIs & Services → OAuth consent screen (External, app name,
   support email). Then Credentials → Create OAuth client ID → **Web application**;
   add the site origin (e.g. `https://<your-app>.up.railway.app`, and
   `http://localhost:3000` for dev) under **Authorized JavaScript origins**.
3. Set `GOOGLE_CLIENT_ID` on the Shorot service to that client ID and redeploy. The
   migration runs on boot; the 👤 button appears in the lobby.
