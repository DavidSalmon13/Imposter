# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Shorot: a same-room party game web app. Players join a shared room by 4-character
code from their own phones; one game runs at a time per room, with a shared
scoreboard that persists across games. Games today: Imposter, Codenames,
10 Seconds, Menifot, Music Timeline, All-In or Fold, Mind Meld, Bluff, and
Warfront (a real-time strategy game still being built step by step from
`docs/implementation/warfront-plan.md`; its pure engine is `server/games/warfrontEngine.js`, driven by
a per-room `setInterval` sim loop in `server/games/warfront.js` that pushes each player a fogged
`wfLive` snapshot 5×/s).
Game rules/UX for each live in `docs/specs/*.md` — read the
relevant one before changing that game's logic.

## Commands

```
npm start          # node server.js — no build step, serves public/ statically
npm test           # node --test — runs the server/games/*.js unit suite in tests/
```

No lint command exists yet. `tests/` holds Node's built-in test runner suite
covering each game's server-side logic (one file per game under
`tests/games/`, shared ctx/socket/room fakes and an OpenAI-call mock in
`tests/helpers/harness.js`) — see "Testing" below for what it does and
doesn't cover.

Requires Node >=18. Environment variables (see `.env.example`):
- `OPENAI_API_KEY`, `OPENAI_MODEL` (default `gpt-4o-mini`) — used for
  Imposter word/hint generation and Codenames board generation.
- `DATA_DIR` — where `rooms.json` (room state snapshot), uploaded
  background images, and player-uploaded stickers (`DATA_DIR/stickers`) are persisted; point this at a mounted volume in
  production (e.g. Railway) so state survives redeploys.
- `STATS_PASSWORD` — enables the owner-only stats page at `/stats` (daily
  visitors/players/games, `server/stats.js`, persisted to `DATA_DIR/stats.json`).
  Also the owner password for `/admin`. Unset = owner login is disabled (no fallback).
- `CREW_CODE` — the built-in sticker photos are crew-only (`server/crew.js`): a device
  unlocks them once via `/crew?code=<CREW_CODE>` (httpOnly cookie); everyone else gets a
  neutral generated avatar from the same `/images/stickers/<file>` URL, so no client code
  knows about the gate. Uploading stickers also needs the crew cookie. Unset = nobody unlocks.
- `DATABASE_URL` — Postgres for accounts and lifetime game history
  (`server/db.js`, `server/accounts.js`, schema in `migrations/`, applied on boot).
  Optional: unset or unreachable = no accounts, games still run.
- `GOOGLE_CLIENT_ID` — enables Google sign-in and the lobby's 👤 Player Card.
  Design and setup: `docs/plans/accounts-plan.md`.
- `ADMIN_EMAILS` — comma-separated Google account emails allowed into the admin
  page at `/admin` (`server/admin.js`, `public/admin.html`); unset = no admin.
  Needs `DATABASE_URL` + `GOOGLE_CLIENT_ID` (the admin signs in like any player).
  Admins get an Admin button in the lobby and on the account page (the installed
  app has no address bar).
  Live rooms/players with kick, make-host, end-game, reset-scores and announce;
  an in-memory activity feed (`server/activity.js`, not persisted); account
  search/rename/ban/delete, device bans (enforced on `join` and Google sign-in)
  and recent game history.

## Architecture

**Backend** (CommonJS, `server/`): all room state lives in-process in one
`Map` (`rooms`, in `server/roomStore.js`), keyed by room code. Every 5s it's
snapshotted to `data/rooms.json` (`server/persistence.js`) and reloaded on
boot — this is a single-process design, not built for multiple server
instances (see `docs/implementation/refactor_plan.md` §9 if that ever becomes necessary).

Each game is a self-contained module under `server/games/` implementing a
common contract (`id`, `minPlayers`/`maxPlayers`, `onChoose`,
`registerHandlers`, `reconnectPayload`, `onDisconnect`, `savedFields`, plus
optional `repairOnLoad`/`clearState`/`onReconnectBroadcast`). `server/gameRegistry.js`
wires all four into shared dispatch points (choosing a game, disconnect,
reconnect, persisted-fields list), so **adding a game is one new file
implementing the contract plus one line in `gameRegistry.js`'s `GAMES` map —
no existing game file needs to change.** The full contract shape and rationale
are documented in `docs/implementation/refactor_plan.md` §4; read that before adding or
restructuring a game module.

Room state (`createRoomState()` in `roomStore.js`) is one flat object with
every game's fields at the top level (`cnBoard`, `tsActivePlayers`, `mfHands`,
...) plus shared fields (`scoreboard`, `hostName`, `phase`) — deliberately not
namespaced per game yet. A `ctx` object (`{ rooms, roomEmit, io, getRoom,
connectedNames, scoreboardEntries, addScore, broadcastLobby, attachToRoom,
saveRoomsToDisk, recordGameResult }`) is built once in `server.js` and passed into every game
module's functions, so games never `require` the room store or lobby
directly — this avoids circular requires and keeps each game's dependencies
explicit.

`server/lobby.js` owns everything cross-game: create/join room, host
handoff, scoreboard, background image upload, back-to-lobby, and the
disconnect/reconnect socket handlers that delegate into the active game via
`gameRegistry`.

**Frontend** (`public/`): `index.html` + `style.css` + ES modules under `public/js/`
(`main.js` bootstrap/lobby, `shared/` helpers, `games/<name>.js` per game). Entry is
`<script type="module" src="js/main.js">`. Each game module exports
`init` / `applyState` (or `applyJoin`) / `stop`, matching the Menifot client pattern.

The look is the "Afterglow" theme (dark ground, glass panels, lime accent): `public/theme-afterglow.css`,
loaded after `style.css` and switched on by `<html data-theme="afterglow">` in `index.html` and
`account.html`. It overrides `style.css`'s colour tokens and restyles components with
zero-specificity `:where(...)` selectors, so it never changes ids, markup or JS. Removing the
attribute brings back the original wooden theme. Restyle a component there, not in `style.css`.

## Testing

`npm test` runs the server-side unit suite (`tests/games/*.test.js`, one file
per game, plus pure-logic tests for `pokerEval.js`/`bluffHands.js`). It drives
each game module's real `registerHandlers`/`onChoose`/etc. against a fake
`ctx`/`io`/socket (see `tests/helpers/harness.js`) — no real socket.io server,
no real OpenAI calls (mocked via `global.fetch`), no real multi-second
timers (driven with `node:test`'s `t.mock.timers` where a game schedules
one). This catches regressions in scoring, win conditions, and handler
guard clauses (host-only, phase checks, input validation) across all 8 games.

It does **not** cover the frontend (`public/js/`), the lobby/reconnect glue
in `server/lobby.js`, or persistence (`server/persistence.js`). After any
change, still manually run the affected game's full happy path in a browser:
create room → choose game → play a full round → confirm scoreboard updates →
back to lobby — plus one disconnect/reconnect mid-round, since
reconnect/persistence logic is the most likely thing to silently regress.
`docs/implementation/refactor_plan.md` §8 has more detail on what's cheapest to
unit-test if the suite grows.

`npm test` runs automatically on every push to `main` and on every PR via
GitHub Actions (`.github/workflows/test.yml`, pinned to the Node version it
was verified against - the suite uses `node:test`'s experimental
`mock.timers`, which needs Node >=20, newer than this repo's own `>=18`
app-runtime minimum).
