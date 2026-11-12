# Accounts, Player Card, Badges & Rivalries — Plan

Status: **shipped to `main`** (merge commit `3269e8d`). Dormant in production until
`DATABASE_URL` and `GOOGLE_CLIENT_ID` are set on Railway (see [Rollout](#8-rollout)).
Player-facing rules live in [`docs/specs/accounts-specs.md`](../specs/accounts-specs.md); this
document covers the why, the design, and how to operate and extend it.

---

## 1. Goal

Give players a reason to open an account, without making the game any harder to start.

- Joining a room stays instant: type a name, play. No sign-up wall, ever.
- Every finished game is recorded for everyone, guests included, so there is always
  something to keep.
- Signing in with Google keeps that history forever and across devices. The pitch is
  loss aversion: "you already earned this, sign in so you don't lose it".
- Recurring reasons to come back: badges with unlockable stickers, and head-to-head
  rivalries between friends who play together every week.

### Non-goals (for now)

- Password accounts. The schema reserves `users.username` and `users.password_hash`,
  but only Google sign-in is built.
- Moving room state into Postgres. Rooms stay in memory plus `rooms.json`.
- Multiple server instances. Postgres would allow it later, but rooms still pin the app
  to one process (`docs/implementation/refactor_plan.md` §9).
- Leaderboards beyond your own rivals, and friend lists.

---

## 2. What was built (in order)

| # | Commit | What |
|---|---|---|
| 1 | `659ec7a` | Postgres foundation (`server/db.js`, migrations), Google sign-in, sessions, Player Card, `ctx.recordGameResult` wired into Imposter |
| 2 | `33e4642` | Result recording for the other 7 games |
| 3 | `0fb4eab` | "Delete my account" (permanent erase) |
| 4 | `96eb2d1` | 14 badges, earned pop-up, badge grid on the card |
| 5 | `6c17645` | Badge pictures use the app's built-in stickers |
| 6 | `b582174` | Rivalries on the Player Card |
| 7 | `1d9b793` | Badge stickers locked until earned; rivalry news pop-up after each game |
| — | `3269e8d` | Merge into `main` |

---

## 3. Architecture

```
 phone (public/js)                         server (Node, one process)              Postgres
 ───────────────────                       ──────────────────────────              ────────
 shared/account.js ── GET /api/me ───────▶ accounts.js ── playerCard() ─────────▶ read
   Player Card UI     POST /api/auth/google  │  rivalries(), badges
   badge/rivalry      DELETE /api/account    │
   pop-ups            POST /api/auth/logout  │
                                             │
 main.js ── socket 'join'/'changeSticker' ─▶ lobby.js ── canUseSticker() ───────▶ read
   sticker picker locks                      │
                                             │
 games/*.js (client) ◀── socket ─────────── games/*.js (server)
   'badgesEarned'                            └─ ctx.recordGameResult(room, type, [...])
   'rivalryUpdate'                                └─ server.js wrapper
                                                      └─ accounts.recordGameResult ──▶ write (1 txn)
                                                           ├─ evaluateBadges ──────────▶ read/write
                                                           └─ announceRivalries ───────▶ read
```

Principles:

- **Optional by design.** No `DATABASE_URL`, or Postgres unreachable at boot, means the
  feature is off and every game works exactly as before. A database error mid-game
  is logged and that game simply isn't recorded.
- **Never in the live game loop.** The database is written once per finished
  round/match, fire-and-forget. Games never `await` it.
- **Room state is unchanged.** Nothing new in `rooms.json` or `ROOM_SAVED_FIELDS`, so
  rolling back keeps the live scoreboard intact.
- **Stats are derived, never stored as totals.** Everything (card totals, badges,
  rivalries) is computed from per-game rows, so nothing can drift, and new badges
  apply retroactively.

### Files

| File | Role |
|---|---|
| `server/db.js` | `pg` pool from `DATABASE_URL`; `initDb()` runs migrations on boot; `isEnabled()`, `query()`, `transaction()` |
| `migrations/001_accounts.sql` | Schema (section 4). Applied once, tracked by filename in `schema_migrations` |
| `server/accounts.js` | HTTP routes, sessions, Player Card, `recordGameResult`, badge evaluation, rivalries, sticker locks, cleanup |
| `server/badges.js` | Badge definitions: id, sticker, emoji fallback, name, description, `check(history)` |
| `server.js` | Mounts routes, starts DB and cleanup; `ctx.recordGameResult` wrapper adds `clientId` and room code and routes pop-ups to the right socket |
| `server/lobby.js` | `join` / `changeSticker` call `canUseSticker` |
| `server/games/*.js` | One `ctx.recordGameResult(...)` call where each game awards scoreboard points |
| `public/js/shared/account.js` | Player Card UI, Google button, sign out/delete, pop-up queue, sticker-lock feed |
| `public/js/main.js` | Sticker picker renders locks; calls `initAccount`, `refreshCard` |
| `public/index.html`, `public/style.css` | 👤 button, card markup, badge/rival/toast styles |
| `public/sw.js` | Never caches `/api/me` or `/api/auth/*` |

---

## 4. Data model

```
users ─┬─< user_identities         (provider, provider_sub) → user
       ├─< auth_sessions           sha256(token) → user, expires_at
       └─< players                 client_id (browser) → user_id (NULL = guest)
             ├─< game_participants >── games
             └─< achievements      (player_id, badge_id)
```

| Table | Key columns | Notes |
|---|---|---|
| `users` | `id`, `display_name`, `email` (citext, unique), `avatar_url`, `sticker`, `username`, `password_hash` | `username`/`password_hash` reserved, unused |
| `user_identities` | PK `(provider, provider_sub)`, `user_id` | `provider_sub` is Google's permanent `sub`, never the email |
| `players` | `id`, `client_id` (unique), `user_id` (nullable), `last_seen` | One row per browser. Stats hang off this |
| `games` | `id`, `room_code`, `game_type`, `ended_at` | One row per recorded round/match |
| `game_participants` | PK `(game_id, player_id)`, `name_used`, `role`, `team`, `won`, `points`, `details` JSONB | `won` NULL = no per-player winner |
| `achievements` | PK `(player_id, badge_id)`, `game_id`, `earned_at` | Badge definitions live in code |
| `auth_sessions` | `token_hash` PK, `user_id`, `expires_at` | Raw token only ever in the cookie |
| `schema_migrations` | `name` PK | Created by the migration runner |

Cascades: deleting a `users` row cascades to identities and sessions and sets
`players.user_id` to NULL. Deleting a `players` row cascades to its participations and
achievements. Account deletion deletes the players explicitly (section 5.6).

---

## 5. Flows

### 5.1 Identity

- Each browser has had a random `clientId` in localStorage (`imposterClientId`) since
  before this work; it's also used for reconnects.
- Every recorded game upserts a `players` row for that `clientId`. Guests accumulate
  history with no account.
- **Scope** of a query (`scopeFor()`): a signed-in user covers every `players` row with
  their `user_id`, so all their devices count together. A guest covers one `client_id`.

### 5.2 Google sign-in

1. Client loads Google Identity Services, which renders "Continue with Google". Only
   loaded when the card is opened, never for players who don't look.
2. Google returns a signed ID token. Client `POST /api/auth/google { credential, clientId }`.
3. Server verifies the token with `google-auth-library` (audience = `GOOGLE_CLIENT_ID`).
4. Looks up `user_identities` by `sub`. Found: existing user, avatar refreshed.
   Not found: new `users` row (email kept only if Google says it's verified; a clash
   on email doesn't fail sign-in), plus an identity row.
5. **Claims the device**: sets `players.user_id` for this `clientId`, only if it's
   currently unclaimed. A device linked to someone else is never re-linked.
6. Creates a session (32 random bytes; stores SHA-256) and sets cookie `shorot_session`
   (httpOnly, SameSite=Lax, Secure on https, 180 days).
7. Re-evaluates badges for the merged history and returns the card plus `newBadges`.

Every later request is recognized by the cookie: hash, look up an unexpired session,
get the user.

### 5.3 Recording a game

Each game calls, exactly where it already calls `ctx.addScore` at round/match end:

```js
ctx.recordGameResult(room, 'codenames', [
  { name, role, team, won, points, details },
]);
```

The `server.js` wrapper resolves each `name` to `room.players.get(name).clientId` and
the room code, then calls `accounts.recordGameResult`, which:

1. In one transaction: inserts `games`, upserts `players` (bumping `last_seen`),
   inserts `game_participants`. Participants with no `clientId` are skipped.
2. After commit: `evaluateBadges` for each participant, then emits `badgesEarned`.
3. Then `announceRivalries`, which emits `rivalryUpdate`.

What each game records:

| Game | Recorded when | `won` | `role` / `team` | `details` |
|---|---|---|---|---|
| Imposter | Reporting finishes | survived (not eliminated) | `imposter` / `crew` | `{ eliminated }` |
| Codenames | Game over with a winner | on the winning team | `spymaster` / `operative`, team colour | — |
| 10 Seconds | Champion decided | is champion | — | `{ place }` (waves share a place) |
| Menifot | Someone reaches target | in `mfMatchWinners` | — | `{ score, place }` |
| Music Timeline | Team reaches target | team in `mtMatchWinners` | team id | `{ cards }` |
| Mind Meld | Rotation completes | rank 1 (ties share) | — | `{ score, place }` |
| All-In or Fold | Host ends the game | top net profit (ties share) | — | `{ netProfit, totalBoughtIn }` |
| Bluff | Last player standing | is the winner | — | `{ place }` |

`points` is always exactly what was added to the room scoreboard.

### 5.4 Badges

- Definitions: `server/badges.js`. Each has `check(history)` over the identity's full
  history, oldest first: `{ gameType, role, team, won, points, details }`.
- `evaluateBadges(playerId, gameId)`: loads the scope's earned badge ids and history,
  runs every not-yet-earned check, inserts achievements (`ON CONFLICT DO NOTHING`),
  and returns the new ones.
- Runs after every recorded game and on sign-in (merging a device can complete a badge).
- Retroactive by construction: a badge added later is awarded on the next game or
  sign-in to anyone whose history already qualifies.
- Art: `sticker` (a built-in sticker filename). If the file is missing, the server
  falls back to `emoji` and logs a warning at boot.
- Never rename or reuse a badge `id`; earned rows reference it.

The 14 badges are listed in the spec.

### 5.5 Rivalries

- `rivalries(scope, limit)`: one query joins `game_participants` with itself on
  `game_id`, grouped by opponent and game type.
- **Opponent identity**: `u<user_id>` if they have an account (all their devices
  merged), otherwise `p<player_id>`. The name shown is the `name_used` from the most
  recent shared game.
- **Per shared game**: compare `(won ? 1 : 0, points)` as a pair. Higher wins; equal is
  a draw (e.g. Codenames teammates). The same rule is used in JS by `compareResults`.
- Card: the top 5 by games together.
- **After-game news** (`announceRivalries`): for each participant, among the opponents
  in this game where the result was decisive and the pair has 3 or more shared games,
  pick the most-played and send one line (`rivalryLine`): "beat again", "took the
  lead", "drew level", "closing in", or the mirror-image loss lines.

### 5.6 Sign out and delete

- `POST /api/auth/logout`: deletes the session row and clears the cookie. Account and
  stats remain. The device stays linked (section 9).
- `DELETE /api/account` (behind a confirm dialog), in one transaction:
  delete all `players` of the user (cascading participations and achievements),
  then delete the user (cascading identities and sessions), then delete games left
  with no participants. Other players' rows in shared games remain. Signing in again
  creates a fresh, empty account.
- Not touched: the room's in-memory scoreboard (name-keyed, temporary) and the
  anonymous counts in `stats.json`.

### 5.7 Sticker unlocks

- A sticker that is some badge's art is locked until one of those badges is earned in
  scope. Uploaded stickers and the 8 built-ins that aren't badge art are always free.
- **Server enforcement** (`canUseSticker(clientId, sticker)`): `join` silently drops a
  locked sticker (join still succeeds); `changeSticker` refuses with
  "Earn its badge to unlock this sticker".
- **Client**: the card's `lockedStickers` drives the picker (silhouette, 🔒, and an
  "Earn the X badge" hint on tap). A saved locked choice in localStorage is cleared on
  load.
- Fails open: no database, or a database error during the check, means nothing is locked.
- Locks follow the database, not sign-in: with `DATABASE_URL` set but no
  `GOOGLE_CLIENT_ID`, locks are active (and shown) even though the card is hidden.
  `/api/auth/config` exposes `history` separately from `enabled` for this.

### 5.8 Retention

Every 6 hours (and at boot): delete expired sessions; delete guest `players` (no
`user_id`) not seen for 60 days, with their history; delete games left with no
participants.

---

## 6. API and events

| Kind | Name | Purpose |
|---|---|---|
| GET | `/api/auth/config` | `{ enabled, history, googleClientId }` |
| GET | `/api/me?clientId=` | `{ enabled, user, card }`. Card = account's if signed in, else this device's |
| POST | `/api/auth/google` | `{ credential, clientId }` → `{ ok, user, card, newBadges }` |
| POST | `/api/auth/logout` | Ends the session |
| DELETE | `/api/account` | Permanently erases the signed-in account |
| socket → client | `badgesEarned` | `{ badges: [{ id, emoji, sticker, name, description }] }` |
| socket → client | `rivalryUpdate` | `{ text, beat }` |
| ctx | `recordGameResult(room, gameType, participants)` | Used by game modules |

Card shape: `{ gamesPlayed, wins, points, byGame, badges[], lockedStickers[], rivals[] }`.

---

## 7. Configuration

| Variable | Effect |
|---|---|
| `DATABASE_URL` | Turns on recording, badges, rivalries, sticker locks. Add `?sslmode=require` for an external connection; Railway's private URL needs none |
| `GOOGLE_CLIENT_ID` | Turns on sign-in and the 👤 Player Card (also needs `DATABASE_URL`) |

---

## 8. Rollout

1. ✅ Merged to `main`. Production runs with both variables unset, which is identical
   to before.
2. Google Cloud Console → OAuth consent screen (External, app name, support email) →
   Credentials → Create OAuth client ID → **Web application**. Add the production
   origin (e.g. `https://<app>.up.railway.app`) and `http://localhost:3000` under
   **Authorized JavaScript origins**.
3. Railway: add a **Postgres** service. On the Shorot service set
   `DATABASE_URL = ${{Postgres.DATABASE_URL}}` and `GOOGLE_CLIENT_ID`, and save both in
   one change (one redeploy, so players get the full feature at once).
4. Deploy log should show `Applied migration 001_accounts.sql` and `Postgres connected`.
5. Smoke test on a phone: lobby → 👤 shows the card → play one Imposter round → card
   shows 1 game and the "Welcome!" pop-up appears → sign in → stats kept → sign out → sign in.
6. Before opening to the public: publish a privacy note ("delete your account from the
   Player Card; this erases your account and game history"). Google expects it for
   the consent screen to leave testing mode.

**Heads-up at step 3:** the 14 badge stickers lock for everyone, including players
currently wearing one.

## 9. Rollback

Fastest first:

1. **Kill switch**: delete `DATABASE_URL` on Railway. Everything turns off and all
   stickers are free again. Re-adding it restores everything, data included.
   Deleting only `GOOGLE_CLIENT_ID` hides sign-in but keeps recording and locks.
2. **Redeploy** the pre-merge deployment from Railway's Deployments list (temporary;
   the next push to `main` redeploys the new code).
3. **Revert**: `git revert -m 1 3269e8d` and push to `main`. The pre-merge commit is
   `4da6b6f`.

The Postgres tables and data survive any rollback and are ignored by the old code.

---

## 10. Testing done

No automated suite exists; everything was verified against a real local Postgres 16
with headless Chromium and socket.io clients:

- Recording: Imposter rounds via the real server (roles, wins, points, room code). The
  other 7 games' result builders were exercised with crafted room states, including
  ties and team games, and the scoreboard points were confirmed unchanged.
- Sign-in (Google verifier stubbed): guest history kept, a second account can't claim a
  linked device, one account on two devices merges, sign out, cookie flags.
- Deletion: refuses when signed out; erases both devices' history and achievements;
  other players' records stay; re-sign-in gives a fresh account.
- Badges: every rule unit-checked against sample histories; live pop-ups in order;
  retroactive award on sign-in merge.
- Rivalries: a seeded scenario with hand-computed expected records (merged
  multi-device opponent, draws, guest vs account views); after-game line in the browser.
- Sticker locks: locked join is dropped, locked change refused, unlock after earning,
  picker hints, saved locked choice cleared; no-database and no-sign-in modes.
- Failure modes: no `DATABASE_URL` boots normally; Postgres stopped mid-game means the
  game continues and the failure is logged.

**Not tested**: a real Google login (needs the production client ID), and a full live
playthrough of the 7 non-Imposter games end to end.

### Regression checklist (run after changes here)

- [ ] Imposter round: card +1 game, scoreboard unchanged from before
- [ ] One other game (e.g. Bluff) to game over: recorded with the right winner
- [ ] Disconnect and reconnect mid-round: sticker and name kept, the game continues
- [ ] Badge pop-up then rivalry pop-up queue correctly
- [ ] Locked sticker can't be worn; unlocked after its badge
- [ ] Server boots with `DATABASE_URL` unset

---

## 11. Known limitations and risks

- **`clientId` is client-chosen.** Someone who copies another browser's localStorage
  could have their games recorded to that player. Acceptable for party stats. Fix if
  needed: record by the session cookie's user (the socket handshake carries cookies).
- **Shared devices.** After sign-out, games on that device still count for the account
  it's linked to. Phones are assumed personal.
- **Playing from a friend's phone** while signed in elsewhere: those games go to that
  phone's guest history.
- **Same account on two devices in one game** counts the game twice.
- **Sticker locks hit existing wearers** when the database is first connected.
- **Rival names** are whatever was typed that night; renames show the latest.
- **Cost.** `/api/me` runs a few aggregate queries (card, badges, rivalries) on lobby
  return. Fine at party scale; add caching or a summary table if it ever matters.

---

## 12. Extending it

- **New game**: add one `ctx.recordGameResult(room, '<type>', [...])` where it awards
  points, plus a label in `GAME_LABELS` in `public/js/shared/account.js`.
- **New badge**: append to `BADGES` in `server/badges.js` with a fresh `id`, a built-in
  `sticker` and an `emoji` fallback. It's awarded retroactively. If it needs new data,
  add it to that game's `details`.
- **Schema change**: add `migrations/002_<name>.sql`. It's applied once on boot. Never
  edit a migration that has run in production (comments aside).

### Ideas not built

- Rivalry badges ("Nemesis": lose 5 in a row to the same person).
- Show the rivalry line on the results screen itself, not only in a pop-up.
- Password sign-in (columns reserved), Apple sign-in (`user_identities` is ready).
- Shareable "game night recap" link.
- Let signed-in players set a display name that pre-fills the join screen.
