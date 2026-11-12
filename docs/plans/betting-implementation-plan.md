# Tokens & Betting — Implementation Plan

Status: **code complete, not yet rolled out.** Every line item in §16 "Build checklist"
is done except its final "Rollout" section — applying the migration against a real
Postgres and running the signed-in manual pass both need a real `DATABASE_URL` +
`GOOGLE_CLIENT_ID`, neither available in the environment this was built in. That's the
one thing left before this can ship; see §16's "Rollout" for exactly what's left. Builds
on the shipped accounts feature
([`accounts-plan.md`](accounts-plan.md), [`accounts-specs.md`](../specs/accounts-specs.md)).
Player-facing rules: [`docs/specs/betting-specs.md`](../specs/betting-specs.md) — read that
first for *what* this does; this document is the *how*.

Supersedes the original scoping draft, [`betting-plan.md`](betting-plan.md) (kept for
history — this plan resolves all of its §11 open questions; see "Decisions" below).

---

## 1. Goal

Give signed-in players an active, replayable reason to engage with a game they're
already playing — not just a trophy case (badges/rivalries already cover that). Ship
the smallest version that proves the loop is fun: Bluff only, both bet types.

### Non-goals (v1)

Unchanged from `betting-plan.md` §3: no guest tokens, no purchases/cash-out, no
leaderboard/shop, no cross-room carryover beyond the daily grant, no betting outside
Bluff.

## 2. Decisions (resolves `betting-plan.md` §11)

| # | Question | Decision |
|---|---|---|
| 1 | Signup / daily grant | **1000 / 100** |
| 2 | House edge | **10%, fixed constant**, not per-game (only one game exists in v1) |
| 3 | Min / max stake | **Min 10, no max** (capped only by current balance) |
| 4 | Balance cap | **None** |
| 5 | Zero-balance backstop | **None** — running out is part of the experience |
| 6 | Hide bets from the host | **Generalized by viewer status, not host-specific**: active players (host included) see only their own bets; eliminated/spectating players additionally see other eliminated players' bets. See `betting-specs.md` "Who can see whose bets." |
| 7 | Side-bet expiry | **Round end only** — no separate timer |

Additional decisions made during scoping, not in the original draft's open-questions list:

| Topic | Decision |
|---|---|
| Side-bet scope | **Round-loser prediction only.** Betting on Bluff's hand-check call is out of scope for v1. |
| Side bets voided by a host edit | **Void and refund**, not resolved off the edit's result — an edit is a correction tool, not a real round outcome. |
| Feature gate | **New `BETTING_ENABLED` env var**, independent of accounts being configured — can be toggled off in production without touching sign-in. |
| Per-player opt-out toggle | **Not in v1** — dismissing each offer is enough. |
| Disconnect mid-bet | **Resolves normally** at match/round end, same as the scoreboard. |
| Admin economy visibility | **Not in v1.** |

## 3. Architecture

```
 phone (public/js)                    server (Node, one process)                Postgres
 ───────────────────                  ──────────────────────────                ────────
 games/bluff.js (client)  ◀─ socket ─ server/games/bluff.js
   bet offer modals,                    │  calls ctx.betting.* at the same
   side-bet composer,                   │  points it already calls
   wallet readout                       │  ctx.recordGameResult / ctx.addScore
                                        ▼
                                  server/betting.js ── wallets, bets ──────────▶ read/write
                                        │                                       (1 txn each)
                                        ▼
 shared/account.js        ◀─ socket ─ server.js's ctx.betting wrapper
   reuses existing toast                 (adds clientId/userId/room code,
   queue for resolution                  routes pop-ups to the right socket,
   toasts                                same shape as ctx.recordGameResult today)
```

Principles, copied deliberately from the accounts feature because the same reasoning
applies:

- **Optional by design, two layers deep.** No `DATABASE_URL`/`GOOGLE_CLIENT_ID` means no
  accounts at all, same as today. `BETTING_ENABLED` unset on top of a working accounts
  setup means accounts/badges/rivalries work exactly as they do today, with no wallet,
  no bet offers, nothing betting-shaped anywhere.
- **Never in the live game loop.** Wallet/bet writes are fire-and-forget from the game
  module's point of view, exactly like `ctx.recordGameResult`. A database error mid-bet
  is logged; the match/round continues regardless.
- **Room state barely changes.** Bluff's `room.bf*` fields are untouched. Betting state
  (open offers, pending bets) lives in new in-memory room fields the same way
  `room.bfHands`/`bfLastResult` do — **not persisted**, since an in-flight bet riding on
  a round that no longer exists after a restart is meaningless (see "Restart
  resilience" below). Settled wallet balances live in Postgres, same durability class as
  lifetime stats.
- **Game-agnostic primitives, Bluff-only wiring.** `server/betting.js` exposes generic
  `openGlobalBetWindow` / `resolveGlobalBets` / `placeSideBet` / `acceptSideBet` /
  `resolveSideBets` / `voidSideBets` calls that take a room, a viewer list, and a
  predicate — no Bluff-specific logic lives in that file. Only `server/games/bluff.js`
  calls them in v1, at the exact points it already calls `ctx.recordGameResult`/
  `ctx.addScore`. This mirrors `recordGameResult`'s own design and is what makes "v2:
  match-start bets on the other 7 games" a one-line-per-game addition later, not a
  rewrite.

### Files

| File | Role |
|---|---|
| `server/betting.js` | **New.** Wallet grants/reads, bet placement/acceptance/resolution/void, all SQL. Mirrors `server/accounts.js`'s shape (one module, `db.isEnabled()` guards, fail-open). |
| `migrations/004_betting.sql` | **New.** `wallets`, `bets` tables (see §4). |
| `server.js` | Add `BETTING_ENABLED` constant; build `ctx.betting` the same way `ctx.recordGameResult` is built today (wraps `server/betting.js` calls, resolves names → clientId/userId, routes pop-ups via `emitToPlayer`). |
| `server/games/bluff.js` | Four or five call sites added at existing hooks — see §5. No existing logic changed, only new calls inserted alongside it. |
| `public/js/games/bluff.js` | Render bet offer modals, side-bet composer/accept prompt, wallet readout, from new fields on the existing `bluffState` payload. |
| `public/js/shared/account.js` / `account-page.js` | Wallet balance on the Player Card; reuse the existing toast queue for resolution toasts (`queueToast`/`showNextToast`, already shared infra — see `public/js/shared/account.js`). |
| `public/index.html`, `public/style.css` | New modal/composer markup and styles, token readout chrome. |

## 4. Data model

```
users ──< wallets            (1:1, created with the signup grant on first sign-in)
users ──< bets                (bettor_user_id, opponent_user_id nullable)
games ──< bets                (nullable game_id FK — set once the match is recorded,
                                null while a bet is still in flight mid-match)
```

```sql
-- migrations/004_betting.sql
-- Tokens & betting. Play money only; see docs/specs/betting-specs.md. New tables only —
-- nothing here changes any existing table.

CREATE TABLE wallets (
  user_id          BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance          INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  last_grant_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE bets (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN ('global', 'side')),
  game_id            BIGINT REFERENCES games(id) ON DELETE SET NULL,
  room_code          TEXT NOT NULL,
  bettor_user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opponent_user_id   BIGINT REFERENCES users(id) ON DELETE CASCADE, -- null for global
  pick_name          TEXT NOT NULL,       -- name_used at bet time, not a player_id FK
  stake              INTEGER NOT NULL CHECK (stake > 0),
  payout             INTEGER,             -- null until resolved
  status             TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'resolved', 'expired', 'voided')),
  trigger            TEXT,                -- 'start' | 'elimination' | null for side bets
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at        TIMESTAMPTZ
);
CREATE INDEX bets_bettor_idx ON bets (bettor_user_id);
CREATE INDEX bets_opponent_idx ON bets (opponent_user_id);
CREATE INDEX bets_game_idx ON bets (game_id);
```

Notes:

- `pick_name` is a plain string, not a `player_id` FK — same reasoning as
  `game_participants.name_used`: it's whatever that player was called that night,
  and the predicted player may be a guest with no `players`/`users` row at all.
- `game_id` is nullable because a bet exists (tokens staked) *before* the match ends
  and `games` gets its row (that only happens at `ctx.recordGameResult`, i.e. match
  end). It's backfilled onto every bet for that match at resolution time, purely for
  later joinability — nothing reads it before then.
- No `wallets` row until a user is created; created in the same transaction as the
  `users` insert in `accounts.js`'s Google sign-in flow, seeded at
  `TOKENS_SIGNUP_GRANT`.
- Like every other table here: fails open. No `DATABASE_URL`, or a write failure mid-bet,
  never blocks the game — `server/betting.js` mirrors `accounts.js`'s `db.isEnabled()`
  guard on every function.

## 5. Flows

### 5.1 Daily grant

- Checked lazily, the same two places `players.last_seen` already gets bumped:
  `GET /api/me` and the Google sign-in handler.
- `grantDailyIfNeeded(userId)`: `UPDATE wallets SET balance = balance + :grant,
  last_grant_date = CURRENT_DATE WHERE user_id = :id AND last_grant_date <
  CURRENT_DATE` — single statement, race-safe, no read-then-write.
- Calendar day = Postgres server clock (effectively UTC on Railway). Not
  timezone-aware per player; same tradeoff class as every other timestamp in this app.

### 5.2 Global bets

1. **Opening a window.** `server/games/bluff.js`'s `startBluffMatch` handler, right
   after `dealBluffRound(ctx, roomCode, room)`, calls
   `ctx.betting.openGlobalBetWindow(room, roomCode, { trigger: 'start', offerTo: room.bfPlayers, eligible: room.bfPlayers })`.
   `applyBluffLoss`, right after pushing onto `bfEliminationOrder`, calls
   `ctx.betting.openGlobalBetWindow(room, roomCode, { trigger: 'elimination:' + name, offerTo: [name], eligible: activeBluffPlayers(room) })`
   — note `offerTo` is just the one newly-eliminated player, not the table.
2. Window state lives on the room (new, unpersisted fields — see §6), keyed by
   trigger id, holding `eligible` (frozen at open time, used for the payout formula)
   and which of `offerTo` have already placed or dismissed.
3. **Placing.** New socket handler `betPlaceGlobal({ trigger, pick, stake })`, guarded
   like every other Bluff handler (room/phase check, signed-in check via
   `room.players.get(name).userId`, stake between `BET_MIN_STAKE` and current balance,
   pick inside that window's frozen `eligible` list, no existing bet on this exact
   trigger from this player). On success: `server/betting.js` debits the stake
   immediately (so the UI can show it's committed) and inserts a `pending`... actually
   a global bet has no "accept" step, so it's inserted directly as the terminal
   "placed" state (reuse `status = 'accepted'` to mean "live, awaiting resolution" for
   global bets, since `'pending'` is reserved for side-bet-not-yet-accepted — document
   this reuse in `betting.js`'s header comment).
4. **Resolving.** `finishBluffMatch`, right after `ctx.recordGameResult(...)`, calls
   `ctx.betting.resolveGlobalBets(room, roomCode, { gameId, winnerName })`. For every
   open global bet on this room: payout = `floor(stake * eligibleCount * (1 - BET_HOUSE_EDGE))`
   if `pick === winnerName`, else `0`; credit the bettor's wallet (winners only — the
   losing stake was already debited at placement time, so a loss needs no further
   write beyond marking `resolved`/`payout = 0`); emit a resolution toast via
   `onBetResolved`.

### 5.3 Side bets

1. **Proposing.** New socket handler `betProposeSide({ pick, stake, targetName })`
   (`targetName` nullable = open to the table). Guards: round must be live
   (`hasActiveRound(room)`, same predicate `canEdit` already uses), proposer is
   signed-in, stake valid against current balance, proposer has no other unaccepted
   proposal open, `pick` is a currently-active player. Debits nothing yet — no stake is
   at risk until accepted. Stored on the room (unpersisted, §6) keyed by round number.
2. **Accepting.** New socket handler `betAcceptSide({ proposalId })`. Guards: proposal
   still exists for the *current* round number (it's gone the instant the round
   changed), accepter is signed-in, not the proposer, matches `targetName` if the
   proposal was targeted, accepter's balance covers the stake. On success: debit both
   stakes, insert the `bets` row as `accepted`, remove the proposal from the pending
   list, broadcast so the composer/prompt disappears for everyone who saw it.
3. **Resolving.** `applyBluffLoss`, right after setting `room.bfLastResult = {...}`
   (same tick, before the highlight broadcast), calls
   `ctx.betting.resolveSideBets(room, roomCode, { roundNumber: room.bfRoundNumber, loserName: name })`.
   Every `accepted` side bet for that round number: the side whose `pick_name` equals
   `loserName` takes both stakes (credit `stake * 2` to that side's wallet, the other
   side gets nothing further — their stake was already debited at accept time); mark
   `resolved`; emit resolution toasts to both. Any still-`pending` (unaccepted)
   proposals for that round are just dropped (no stake to return).
4. **Voiding on an edit.** `bfConfirmEdit`, before calling `dealBluffRound`/
   `finishBluffMatch`, calls
   `ctx.betting.voidSideBets(room, roomCode, room.bfRoundNumber)`: every `accepted` bet
   for that round refunds both stakes (credit each side their own stake back); every
   `pending` proposal is dropped. Marks rows `voided`.
5. **Round-change cleanup.** `dealBluffRound` incrementing `room.bfRoundNumber` is
   implicitly "the round changed" — any proposal left over from the prior round number
   is simply no longer reachable by `betAcceptSide` (the guard in step 2 checks the
   *current* round number), so no extra cleanup call is needed beyond what steps 3/4
   already do before a new round is dealt.

### 5.4 Visibility filtering

- `bluffStatePayload(ctx, room, viewerName)` gains a `betting` key, built by a new
  `server/betting.js` helper `bettingViewFor(room, viewerName)`:
  - `null` entirely if `!BETTING_ENABLED` or the viewer isn't signed in.
  - Otherwise: `{ balance, minStake: BET_MIN_STAKE, openGlobalWindows: [...offers
    addressed to this viewer...], myGlobalBets: [...], mySideProposal: ... | null,
    incomingSideOffers: [...proposals targeting this viewer, or open, if a round is
    live...], mySideBets: [...], visibleOthersBets: isBluffSpectator(room, viewerName)
    ? [...every OTHER eliminated player's bets...] : [] }`.
  - This is exactly the `isBluffSpectator` predicate Bluff already computes for hand
    visibility — reused verbatim for bet visibility, so the two "you're a spectator
    now, you see more" rules stay in sync automatically.
- `broadcastBluff` needs no change — it already calls `bluffStatePayload` once per
  connected viewer by name; the new `betting` key just rides along.

## 6. Server state additions (unpersisted, room-scoped)

Mirrors Bluff's own `bfHands`/`bfLastResult`/`bfEditing` pattern: live-only, dropped on
restart, rebuilt from nothing because nothing meaningful survives a restart anyway (any
bet in flight was riding on round/match state that's about to be re-dealt regardless).

- `room.betGlobalWindows`: `{ [trigger]: { eligible: string[], offerTo: string[],
  responded: Set<string> } }` — open global-bet windows for the current match.
  (Implemented as `responded`, not `resolved` as originally drafted here — this field
  tracks who's already placed or dismissed *this window*, distinct from a bet being
  resolved at match end, which is tracked by the `bets` row's own `status`.)
- `room.betSideProposals`: `{ [roundNumber]: Array<{ id, bettorName, pick, stake,
  targetName }> }` — unaccepted proposals, keyed by the round they're about.
- Nothing else — once a side bet is accepted or a global bet is placed, its durable
  record is the `bets` Postgres row; the room only needs to track what's still *pending*
  in memory.

Not added to `ROOM_SAVED_FIELDS`/`SAVED_FIELDS` for Bluff — consistent with the decision
in §7 below (restart drops in-flight betting state, same as Bluff already drops
`bfHands`).

## 7. Restart resilience

A server restart during a live match drops every open global-bet window and every
pending/accepted-but-unresolved side bet the same way it already drops `bfHands` —
nothing is persisted, by design. Concretely:

- Any stake already debited for an **accepted** bet (global or side) that never gets to
  resolve because the server restarted mid-match is a **lost stake with no refund** in
  v1 — same failure class as Bluff's own `repairOnLoad` re-dealing the current round
  fresh and nobody being owed anything for the interrupted deal. This is a known,
  accepted gap (see "Known limitations"), not something this plan builds a recovery
  path for — restarts are rare and this is play money.
- `repairOnLoad` for Bluff needs no change beyond what it already does; betting simply
  has nothing to repair (empty windows/proposals on a freshly loaded room).

## 8. API and events

| Kind | Name | Purpose |
|---|---|---|
| socket → server | `betPlaceGlobal` | `{ trigger, pick, stake }` |
| socket → server | `betProposeSide` | `{ pick, stake, targetName? }` |
| socket → server | `betAcceptSide` | `{ proposalId }` |
| socket → client | `betResolved` | `{ kind, won, stake, payout, pick, opponentName? }` — feeds the existing toast queue |
| ctx | `betting.openGlobalBetWindow(room, roomCode, { trigger, offerTo, eligible })` | Called by `bluff.js` |
| ctx | `betting.resolveGlobalBets(room, roomCode, { gameId, winnerName })` | Called by `bluff.js` |
| ctx | `betting.resolveSideBets(room, roomCode, { roundNumber, loserName })` | Called by `bluff.js` |
| ctx | `betting.voidSideBets(room, roomCode, roundNumber)` | Called by `bluff.js` |

`bluffState`'s existing payload gains the `betting` key described in §5.4 — no new
socket event needed for state delivery, it rides the existing broadcast.

## 9. Configuration

| Variable | Effect |
|---|---|
| `BETTING_ENABLED` | Turns on wallets, bet offers, and the `betting` key on `bluffState`. Needs `DATABASE_URL` + `GOOGLE_CLIENT_ID` already set (accounts must be live); has no effect otherwise. |

## 10. Phased rollout

1. **v1 (this plan): Bluff only.** Match-start global bet, elimination-moment global
   bet, side bets per round. Ship behind `BETTING_ENABLED`, off by default.
2. **v2 (not committed):** match-start global bets on the other 7 games — each is one
   `ctx.betting.openGlobalBetWindow`/`resolveGlobalBets` pair added at that game's
   existing `ctx.recordGameResult` call site, same shape as §5.2 above. No side bets or
   elimination-moment bets outside a Bluff-style live elimination/spectator shape.
3. **v3 (not committed):** bet history on the Player Card, a pari-mutuel side-bet pool,
   per-game house-edge tuning, admin economy visibility, a per-player opt-out toggle.

## 11. Testing plan

Follow the pattern `tests/games/bluff.test.js` already uses (fake `ctx`/socket/room from
`tests/helpers/harness.js`) plus a new `tests/games/betting.test.js` for
`server/betting.js`'s pure logic:

- **Wallet**: signup grant exactly once; daily grant exactly once per calendar day,
  idempotent on repeated calls same day; balance never goes negative; no wallet writes
  when `db.isEnabled()` is false.
- **Global bets**: payout formula at various `eligibleCandidateCount`/stake
  combinations including the house-edge rounding-down case; one-bet-per-window
  enforced; elimination-moment window only offered to the newly-eliminated player, not
  the table; losing bettor's stake isn't double-debited.
- **Side bets**: propose → accept → resolve happy path (correct side takes both
  stakes); propose with no accept → expires cleanly at round end with no wallet
  writes; targeted proposal rejected by a non-target; one-unaccepted-proposal-at-a-time
  enforced; edit-triggered void refunds both accepted stakes and drops any pending
  proposal.
- **Visibility**: active viewer payload never includes another player's bet; eliminated
  viewer payload includes other eliminated players' bets but not active players'; host
  (active) sees nothing extra.
- **Guards**: every new handler rejects when `BETTING_ENABLED` is off, when the viewer
  isn't signed in, when the stake is below `BET_MIN_STAKE` or above balance, and when
  the game/phase/round state doesn't match (mirrors the existing guard style in every
  `bfXxx` handler).

Manual pass after automated tests (per `CLAUDE.md` "Testing"): two phones + host, full
Bluff match with `BETTING_ENABLED=true` — place a match-start bet, let one player get
eliminated and take the second bet, run a side-bet propose/accept/resolve, trigger an
edit mid-round to confirm void/refund, confirm toasts and balance updates land, confirm
a signed-out guest sees none of it.

## 12. Rollout

1. Add `migrations/004_betting.sql`; confirm it applies cleanly against the existing
   production schema (same "Applied migration ..." boot log accounts introduced).
2. Ship with `BETTING_ENABLED` unset everywhere — identical to pre-betting behavior.
3. Enable `BETTING_ENABLED=true` on a non-production/staging Railway environment (or
   locally against a copy of the Postgres data) first; run the manual pass above.
4. Flip `BETTING_ENABLED=true` in production once satisfied.

## 13. Rollback

Fastest first:

1. **Kill switch**: delete `BETTING_ENABLED` on Railway. Betting disappears; accounts,
   badges, rivalries, sign-in all keep working untouched.
2. **Redeploy** the pre-betting deployment from Railway's Deployments list.
3. **Revert** the merge commit and push to `main`.

The `wallets`/`bets` tables and their data survive any rollback and are ignored by
older code, same as every other migration in this app.

## 14. Known limitations and risks

- **Lost stakes on a mid-match restart.** An accepted bet with no chance to resolve
  before a restart is simply lost (see §7) — accepted for v1, play money only.
- **Lost stakes on a mid-match `bfResetGame` too.** Same failure class, discovered
  during the Bluff integration (§16): the host resetting a live match abandons any open
  bet with no refund — an already-debited stake isn't returned. `bfResetGame`/`clearState`
  clear the in-memory `betGlobalWindows`/`betSideProposals` **and** call
  `betting.expireDanglingBets(roomCode)`, which marks the already-accepted Postgres rows
  `'expired'`. That second step is required for correctness, not just tidiness: the
  resolution sweeps (`resolveGlobalBets`, `liveSideBets`) key only on `room_code` +
  `status='accepted'`, so without expiring the rows, a bet abandoned by a reset would be
  **mis-resolved against the next match played in that same room**. The boot path runs the
  same sweep with no room code (every room), since any bet still `accepted` after a restart
  was riding on unpersisted in-flight state and is dangling by definition.
- **No explicit "dismiss" for a global-bet offer.** A player simply not placing one costs
  nothing, but there's no server call marking the window "responded" for them either -
  it stays an open offer (re-shown on every broadcast) until the window itself is cleared
  at match end/reset. Not a correctness bug (no stake, no wrong state), just means a
  dismissed offer can resurface if something else re-triggers a broadcast before the
  match ends - a candidate for a real `betDismissGlobal` call in a later pass.
- **Host collusion isn't prevented, only its ambient-visibility version is.** See
  `betting-specs.md` "Economy & fairness risks" — a host who already knows a specific
  player is betting on them can still collude; this plan only removes the *passive*
  information leak (seeing bets you weren't told about).
- **Calendar day is server-clock, not per-player timezone.** Same tradeoff class as
  every other timestamp in this app (e.g. `/stats`'s daily counts).
- **No admin visibility into the economy.** Tuning `BET_HOUSE_EDGE`/grant amounts after
  launch means reading the `bets`/`wallets` tables directly, not a dashboard.

## 15. Extending it

- **New game, v2 match-start bets**: add the `openGlobalBetWindow`/`resolveGlobalBets`
  pair at that game's existing `ctx.recordGameResult` call site. No side bets or
  elimination bets unless that game has a Bluff-style live elimination/spectator
  moment.
- **New bettable round-outcome type** (e.g. Bluff's hand-check call): extend
  `betProposeSide`'s accepted "kind" of pick and `resolveSideBets`'s matching logic;
  everything else (propose/accept/visibility/void) is already outcome-agnostic.
- **Schema change**: add `migrations/005_<name>.sql`, applied once on boot, never edit
  a migration that's already run in production.

## 16. Build checklist

Working branch: `feature/betting`. Check items off and commit as you go — **one small
commit per item** (or a tightly related pair), not several items bundled into one
commit. If you're picking this up fresh: read §1-§9 above first, then start at the
first unchecked `[ ]` below, top to bottom — later items depend on earlier ones.

### Schema & server core

- [x] `migrations/004_betting.sql` — `wallets` + `bets` tables, per §4 (picked up
  automatically by `server/db.js`'s filename-ordered migration runner, no extra wiring)
- [x] `server/betting.js` skeleton: config constants (`TOKENS_SIGNUP_GRANT`,
  `TOKENS_DAILY_GRANT`, `BET_MIN_STAKE`, `BET_HOUSE_EDGE`), `BETTING_ENABLED` env flag,
  `isEnabled()` = flag && `db.isEnabled()`, header comment documenting the
  `status = 'accepted'` reuse for live global bets (see §5.2 step 3). No wallet/bet
  functions yet - that's the next few items.
- [x] Wallet functions in `server/betting.js`: `createWallet(client, userId)`,
  `grantDailyIfNeeded(userId)` (race-safe UPDATE, falls back to seeding a
  daily-grant-only wallet if none existed), `getBalance(userId)`. Not wired into
  `accounts.js`/`server.js` yet - see "Wiring" below; this item was just the functions
  themselves plus their unit tests.
- [x] Global bet functions in `server/betting.js`: `openGlobalBetWindow`,
  `placeGlobalBet` (validates window open/offered/not-already-responded, pick in frozen
  `eligible`, stake vs. `BET_MIN_STAKE`/balance; debit+insert in one transaction,
  race-safe on balance), `resolveGlobalBets` (payout formula per window's own frozen
  `eligible.length`, floors, clears `betGlobalWindows`, returns `[{userId, pick, stake,
  payout, won}]` for the caller to map to a room name - betting.js only knows userIds)
- [x] Side bet functions in `server/betting.js`: `proposeSideBet` (stake/pick/balance
  validation, one-unaccepted-proposal-per-player, stored on
  `room.betSideProposals[roundNumber]`), `acceptSideBet` (round-scoped lookup, target
  check, both debits + one `bets` insert in a single transaction - a failed second debit
  throws so the first one's effect rolls back, rather than returning false and letting
  the transaction commit a half-done accept), `resolveSideBets`/`voidSideBets` (both
  query "every currently-accepted side bet in this room" - relies on the invariant that
  a round's side bets are always resolved or voided before the next round deals, so that
  set and "every accepted side bet for this round" are always the same; no
  `round_number` column needed on `bets`). §5.3
- [x] `bettingViewFor(room, roomCode, viewerName, { isSpectator, othersToReveal })`
  visibility helper (§5.4). Signature differs slightly from this plan's original
  `(room, viewerName)` draft: added `roomCode` (needed to scope the `bets` queries) and
  an options object for `isSpectator`/`othersToReveal` - both are the caller's (Bluff's)
  job to compute from its own elimination state, since this module has no business
  knowing what "eliminated" means for a given game. Returns `{ balance, minStake,
  openGlobalWindows, myGlobalBets, mySideProposal, incomingSideOffers, mySideBets,
  visibleOthersBets }`, or `null` if betting is off or the viewer has no `userId`
  (guest). `visibleOthersBets` entries carry `bettorName`/`opponentName` rather than a
  single ambiguous `name`, and exclude any bet the viewer is themselves a side of
  (already covered by `mySideBets`).
- [x] `tests/games/betting.test.js`: wallet tests (signup grant, daily grant match vs.
  fallback-seed, no writes/0 balance when disabled, failures swallowed not thrown)
- [x] `tests/games/betting.test.js`: global bet tests (payout formula incl. rounding,
  one-per-window, elimination window scoped to one player, no double-debit)
- [x] `tests/games/betting.test.js`: side bet tests (propose/accept/resolve,
  expiry-with-no-accept, targeted-rejects-non-target, one-unaccepted-at-a-time,
  edit-void refunds, rolled-back accept on a failed second debit)
- [x] `tests/games/betting.test.js`: visibility tests (null when disabled/guest; only
  un-responded-to windows shown; own bets split correctly by role; proposal/offer
  visibility; spectator sees others' bets minus their own involvement)

### Wiring

- [x] `server.js`: built `ctx.betting` wrapping `server/betting.js`'s four
  cross-player-notification calls (`openGlobalBetWindow`, `resolveGlobalBets`,
  `resolveSideBets`, `voidSideBets`) - resolves `userId` → room name via the new
  `betting.nameForUserId` export, routes a `betResolved` pop-up to each affected
  player's own socket via `emitToPlayer`, same pattern as `ctx.recordGameResult`. No
  separate `BETTING_ENABLED` constant added in `server.js` as originally drafted here -
  `server/betting.js` already exports `isEnabled()` and every function in it already
  no-ops/returns a harmless default when disabled, so the wrapper methods stay
  unconditional and safe to call either way. `placeGlobalBet`/`proposeSideBet`/
  `acceptSideBet` are *not* in `ctx` - they're synchronous request/response within the
  socket handler that calls them (the ack is enough), so `server/games/bluff.js` will
  call `server/betting.js` directly for those, the same way it already requires
  `./bluffHands` directly rather than through `ctx`.
- [x] `server/accounts.js`: `upsertGoogleUser` calls `betting.createWallet(client,
  userId)` right after inserting a brand-new `users` row (both the primary-insert and
  the `ON CONFLICT`-fallback-insert paths converge before this call) - never for a
  returning user.
- [x] `GET /api/me` and the Google sign-in handler (`POST /api/auth/google`) both call
  `betting.grantDailyIfNeeded(userId)` once the signed-in user is known.

### Bluff integration

- [x] `server/games/bluff.js`: new socket handlers `betPlaceGlobal`, `betProposeSide`,
  `betAcceptSide` - guarded like existing `bfXxx` handlers, calling `server/betting.js`
  directly (not through `ctx`, same reasoning noted under "Wiring" above).
- [x] `server/games/bluff.js`: call sites — `startBluffMatch` opens the `'start'` window
  *before* `dealBluffRound` (so that single broadcast already reflects it);
  `applyBluffLoss` opens an `'elimination:<name>'` window when a player is newly
  eliminated and unconditionally fire-and-forgets `resolveSideBets` for every round's
  loser, win or not; `finishBluffMatch` passes `ctx.recordGameResult` a new 4th-arg
  `onRecorded(gameId)` that fire-and-forgets `resolveGlobalBets`; `bfConfirmEdit`
  fire-and-forgets `voidSideBets` before branching into `dealBluffRound`/
  `finishBluffMatch`. `bfResetGame` and `clearState` also reset `betGlobalWindows`/
  `betSideProposals` to `{}` **and** call `betting.expireDanglingBets(roomCode)` -
  **fixes beyond what this plan originally called for**: the in-memory reset stops a
  never-dismissed elimination window from leaking into a future match, and
  `expireDanglingBets` closes the already-accepted *Postgres rows* so the room_code-scoped
  resolution sweeps can't mis-resolve a reset-abandoned bet against the next match (see
  §14; boot runs the same sweep room-wide).
- [x] `server/games/bluff.js`: `bluffStatePayload` gains the `betting` key (§5.4), but
  **not populated synchronously** - `betting.bettingViewFor` needs a DB round trip, and
  `bluffStatePayload`/`broadcastBluff` must stay synchronous (every existing handler's
  ack-then-broadcast ordering, and most of this file's own tests, depend on that).
  Resolved by keeping `broadcastBluff` synchronous (it **omits** the `betting` key
  entirely rather than sending `betting: null`) and adding a new
  `pushBettingViews(ctx, roomCode, room)` that fire-and-forgets a follow-up correction on
  the same `bluffState` event a tick later - still **no new socket event**, per the plan,
  just a second emission of the existing one. The omit (vs. `null`) matters: the client
  treats an absent `betting` key as "no change, keep the current UI," so the betting panel
  and any open bet modal survive every intervening broadcast; it only tears them down on an
  explicit `null` (betting off / guest), which rides the follow-up. When betting is disabled
  that follow-up resolves to `null` for everyone and nothing extra is ever emitted, so the
  disabled case has zero added behavior, not just zero added network event *types*.
- [x] Cross-cutting, not originally scoped: `server/accounts.js`'s
  `recordGameResult`/`server.js`'s `ctx.recordGameResult` gained an optional 4th-arg
  `{ onRecorded(gameId) }`, additive and backward compatible (every other game's call
  site is unchanged) - this is the only place a just-finished match's `games.id` is ever
  available, and `resolveGlobalBets` needs it to backfill.
- [x] `server/roomStore.js`'s `createRoomState()` defaults `betGlobalWindows`/
  `betSideProposals` to `{}`, same as `bfHands` etc. - needed so a freshly loaded room
  (old `rooms.json` snapshot predating this feature) and a brand-new room both start
  with these fields present, with no `repairOnLoad` change needed (matches §7's claim
  that there is nothing to repair).
- [x] Extended `tests/games/bluff.test.js` (18 new tests, 143 total passing): call-site
  wiring verified by spying on `server/betting.js`'s exports (no database mocking
  needed for most of these - that logic is already exhaustively covered by
  `betting.test.js`), plus a few true end-to-end tests (database mocked) for place/
  propose/accept/resolve integration confidence. `tests/helpers/harness.js` gained a
  `ctx.betting` that mirrors `server.js`'s real wrapper (delegating to the real
  `server/betting.js`, routing `betResolved` through the fake `io`) and a
  `recordGameResult` that invokes `onRecorded` with a fake incrementing id.

**Known gap introduced here, not in the original plan**: resetting mid-match
(`bfResetGame`) abandons any open bet with no refund, same failure class as a server
restart (§7/§14) - added to "Known limitations" below.

### Client

- [x] `public/js/games/bluff.js`: wallet readout (`#bf-bet-balance`) + the odds board
  (`#bf-odds-board`, `renderOddsBoard`) for global bets, replacing the original pop-up
  offer: a row per seat with cards left and payout multiplier (from the view's
  `houseEdge`), Back on rows eligible in the first open window, and an inline
  quick-stake picker (`bfOddsPicker`) whose open row/stake survive re-renders.
- [x] `public/js/games/bluff.js`: side-bet composer (pick/target chip rows + stake
  slider, `renderComposer`) + incoming-offer accept rows (`renderIncomingOffers`) +
  own-proposal waiting state (`renderMyProposal`, hides the composer per the
  one-at-a-time server rule) + a short "my bets" confirmation list (`renderMyBets`) +
  the spectator-only ambient view of other eliminated players' bets
  (`renderOthersBets`/`#bf-bet-others`). All driven by one `renderBetting(betting,
  seats)` called from `applyTable`, and fully inert (hidden, no-op) whenever
  `data.betting` is `null`.
- [x] `public/index.html` / `public/style.css`: new markup inside `#bf-table-panel`
  (`#bf-bet-balance`, `#bf-bet-section`, `#bf-bet-others` and their children) and
  matching styles. No `<select>` used for the side-bet target picker - this app has no
  styled select anywhere, so it's a tappable chip row instead, consistent with the
  pick-row chips and every other picker in this game.
- [x] `public/js/shared/account.js`: `betResolved` → `showBetResolvedToast`, reusing the
  existing badge/rivalry toast queue (`queueToast`), not a second notification system.
- [x] `public/js/account-page.js` / `public/account.html`: wallet balance on the Player
  Card (`#acct-wallet`), fed by a new `balance` field on `GET /api/me` and `POST
  /api/auth/google`'s responses (`server/accounts.js`) - `null` (not `0`) when there's
  nothing to show (no account, or betting disabled), so the client can tell "no wallet"
  apart from "an empty one."
- [x] Manually verified (headless Edge via puppeteer-core, see the `verify` skill): two
  guests join, choose Bluff, start a match, play a full round to resolution - no
  betting UI ever renders (confirmed by DOM inspection, not just visual), no client or
  server errors. **Not verified**: the actual signed-in bet-placing/accepting flow,
  since that needs a real `DATABASE_URL` + `GOOGLE_CLIENT_ID`, neither configured in
  this environment - see "Rollout" below, which still needs a real staging pass with
  betting turned on before this ships.

### Rollout

- [ ] Apply migration locally (`npm start` against a local/staging Postgres), confirm
  the "Applied migration ..." boot log
- [ ] Manual pass per §11 with `BETTING_ENABLED=true` locally
- [ ] Update this plan's status line (top of file) once the checklist above is fully
  checked off
