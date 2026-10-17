# Account Page & Player Rating Card — Specs

Replaces the lobby's 👤 drop-down with a dedicated page: match history, badges, and
(for signed-in players) a FIFA Ultimate Team–style rating card. Builds on
[`accounts-specs.md`](accounts-specs.md) — read that first for identity, badges,
rivalries and sign-in, none of which change here.

## Relationship to the existing Player Card drop-down

- The in-lobby drop-down (`#card-dropdown` etc.) is **removed**. The 👤 button
  (`#card-btn`) instead opens `/account.html` **in a new tab** — the lobby's socket
  connection is untouched, so there's no disconnect/reconnect to handle.
- `#card-btn` is still hidden/shown by the same rule as today: visible only when
  `GET /api/auth/config` reports `enabled` (or, per Edge cases below, `history`).
- Badge-earned and rivalry pop-up toasts **stay in the lobby** (`public/js/shared/account.js`,
  wired to the socket's `badgesEarned`/`rivalryUpdate` events) — the account page has no
  socket and never receives them live. Nothing about toasts changes.
- The sticker-lock data that feeds the lobby's two sticker pickers (join screen,
  🧸 button) also stays sourced from the lobby's existing `refreshCard()` call to
  `GET /api/me` — unrelated to the account page being open or closed.

## Identity on the account page

- No socket, no room. Identity is:
  - **Device**: `localStorage.getItem('imposterClientId')` — same value `main.js`
    already generates and uses, read directly since it's the same origin.
  - **Account**: the `shorot_session` cookie, already shared across tabs same-origin.
- Calls the same `GET /api/auth/config` and `GET /api/me?clientId=...` endpoints the
  old drop-down used. No new read endpoint for identity/history/badges/rivals — see
  "Match history" below for why.

## Page layout (top to bottom)

1. **Header** — display name (Google name if signed in, else "Guest") and sign-in/out
   controls, same copy as today's drop-down.
2. **Rating card** — signed-in only. Guests see a locked/grayed placeholder card
   ("Sign in to unlock your card") in its place, not nothing.
3. **Sticker switcher** — signed-in only, directly below the card (see "Sticker
   unification" below). Guests keep using the existing lobby 🧸 picker, unaffected.
4. **Summary line** — "N games · W wins · P pts", same as today's `cardSummary`.
5. **Match history table** — one row per game type the player has actually played
   (not a per-match log): columns **Game · Played · Won · Lost**. Shown for guests
   and signed-in alike. `Lost = Played − Won` (every game module always records
   `won` as a strict boolean — confirmed across all 8 `server/games/*.js` — so this
   subtraction is always exact, never needs a "draw" column).
   - Sourced from `card.byGame` in the existing `GET /api/me` response
     (`server/accounts.js` `playerCard()`) — no new query. Sort by `played` desc.
6. **Badges grid** — shown for both, same rendering as today's drop-down (earned
   first, then locked-with-🔒, tap for name + description).
7. **Rivals list** — shown for both, same as today (5 most-played opponents, tap to
   expand per-game record).
8. **Sign out** / **Delete my account** — signed-in only, same confirm-dialog flow
   as today.

## Rating card

A FIFA Ultimate Team–style card, signed-in players only. Exactly the FUT layout:
sticker-as-photo + big OVR number at top, name below, then the six stats as **three
pairs per row, two rows** underneath. No extra rows (no badge count, no position
label) — six stats and OVR is the whole card, matching the reference images.

### The six stats

Six stats total, each fed by a weighted combination of game types the player has
played (excludes Music Timeline and Mind Meld entirely, per the original ask).
Every game contributes to **at least two** stats.

**Game → stat weight matrix** (primary = 1.0, secondary = 0.6, tertiary = 0.3):

| Game | Primary | Secondary | Tertiary |
|---|---|---|---|
| 10 Seconds | Speed (1.0) | Nerve (0.6) | — |
| Codenames | Communication (1.0) | Strategy (0.6) | — |
| Imposter | Deception (1.0) | Communication (0.6) | — |
| Menifot | Tactics (1.0) | Strategy (0.6) | — |
| All-In or Fold | Strategy (1.0) | Nerve (0.6) | — |
| Bluff | Nerve (1.0) | Tactics (0.6) | Communication (0.3) |

**Stat → contributing games** (derived from the table above, for reference):

| Stat | Abbr. | Contributing games (weight) |
|---|---|---|
| Speed | SPD | 10 Seconds (1.0) |
| Communication | COM | Codenames (1.0), Imposter (0.6), Bluff (0.3) |
| Strategy | STR | All-In or Fold (1.0), Codenames (0.6), Menifot (0.6) |
| Tactics | TAC | Menifot (1.0), Bluff (0.6) |
| Nerve | NRV | Bluff (1.0), 10 Seconds (0.6), All-In or Fold (0.6) |
| Deception | DEC | Imposter (1.0) |

Speed and Deception are each fed by only one game — intentional: no other game
involves a hard countdown (Speed) or lying/blending in (Deception), so no artificial
secondary source was forced onto them.

### Rating formula

**Step 1 — per-game performance score** (0–99), for each game type the player has
played at least once:

```
perf(gameType) = 50 + (winRate(gameType) × 99 − 50) × min(1, played(gameType) / 8)
```

A brand-new game type sits at a neutral baseline of 50 and only converges toward its
true win-rate-implied score once 8+ rounds of that specific game are played. This
avoids "1 win in 1 round = 99 rating" noise. `winRate`/`played` come from the same
`byGame` data the match-history table uses — no new query.

**Step 2 — stat score**, for each of the six stats: the weighted average of
`perf(gameType)` over every game in that stat's contributor list that the player has
actually played (`played(gameType) > 0`), using the weights in the matrix above. A
contributing game the player has never played is simply excluded from the average
(not treated as 0). If **none** of a stat's contributing games have been played at
all, that stat is a flat **50** (every card shows all six numbers, never blank).

**Step 3 — OVR**: the unweighted mean of the six stat scores, rounded to the nearest
integer.

### Card tier (visual only, from OVR)

| OVR | Tier | Treatment |
|---|---|---|
| < 65 | Bronze | bronze/copper gradient border + background |
| 65–74 | Silver | gray/silver gradient |
| 75–84 | Gold | gold/yellow gradient |
| 85+ | Gold (bright) | same gold family, more saturated/metallic — not a separately-named tier |

Tier changes the card's background/border styling only; nothing else about the card
or its data changes between tiers.

## Sticker unification

Signed-in players have **one sticker everywhere**, not a per-device choice.

- `users.sticker` (an existing, previously-unused column from `migrations/001_accounts.sql`)
  becomes the canonical sticker for a signed-in account.
- **The rating card's photo is this sticker.** The account page has a switcher
  below the card letting the player pick any sticker they've unlocked (same lock
  rules as the lobby picker — badge-locked stickers show 🔒 and are rejected
  server-side).
- **Joining a room**: if the joining connection carries a valid login cookie for an
  account with a non-null `users.sticker`, that sticker is used for the room **regardless
  of what the client's local sticker selection was** — the account sticker always
  wins once signed in.
- **Changing it**: from either the account page's switcher *or* the lobby's 🧸
  picker while signed in — both write through to `users.sticker`, so a change made
  anywhere is reflected everywhere (other open devices pick it up on their next
  join/reconnect).
- Guests (not signed in) are entirely unaffected: still the existing per-device
  `localStorage` sticker, chosen only via the lobby/join-screen pickers.

## New/changed API

- `GET /api/me` — `card` gains a `ratings` field: `{ ovr, tier, stats: { SPD, COM,
  STR, TAC, NRV, DEC } }`, computed server-side from the same `byGame` data already
  in the response. `tier` is one of `'bronze' | 'silver' | 'gold'`. Always present
  (guests get it too; the frontend decides whether to render the card based on
  sign-in state, not on whether `ratings` exists).
- `publicUser()` gains `sticker` (the account's `users.sticker`, or `null`).
- **New** `POST /api/account/sticker` — body `{ sticker }` (a valid sticker id, or
  `null`/omitted to clear it back to the default). Requires a signed-in session
  (401 otherwise). Rejects a locked sticker the account hasn't unlocked (403), same
  rule `canUseSticker` already enforces for the lobby picker.
- `socket.on('join', ...)` / `socket.on('changeSticker', ...)` (`server/lobby.js`) —
  both now additionally resolve/persist the account-level sticker for a signed-in
  `clientId`, per "Sticker unification" above. Guests are unaffected.

## Edge cases

- **No database / no `GOOGLE_CLIENT_ID`**: same fallback as today — `#card-btn`
  stays hidden, `/account.html` is simply unreachable from the UI (direct visits
  would show the guest-only view if history is enabled, or nothing useful if not).
- **Signed in, but has never played a game feeding a given stat**: that stat shows
  50, not 0 — see rating formula.
- **A locked sticker is chosen via `POST /api/account/sticker`**: rejected (403);
  the account's sticker is left unchanged.
- **Account deleted**: `users` row (and its `sticker`) is deleted along with it —
  already covered by the existing cascade in `DELETE /api/account`.
