# Account Page & Rating Card — Implementation Plan

Spec: [`docs/specs/account-page-specs.md`](../specs/account-page-specs.md). Build order
goes backend data/logic first (independently testable via curl/console), then the
new page, then the lobby-side wiring and cleanup last (since it deletes code the
page needs to already have replaced).

## 1. Ratings math (pure, no DB/HTTP)

- New `server/ratings.js`: the game→stat weight matrix, `perf(gameType, {played,
  won})`, and `computeRatings(byGame)` → `{ ovr, tier, stats: {SPD,COM,STR,TAC,NRV,DEC} }`.
  Pure function of the `byGame` shape `playerCard()` already produces — no imports
  from `db`/`accounts`, easy to sanity-check with a few hand-picked `byGame` inputs.

## 2. Backend: expose ratings + account sticker

- `server/accounts.js`:
  - `playerCard()`: add `ratings: computeRatings(byGame)` to its return value.
  - `publicUser()`: add `sticker: u.sticker || null`.
  - Extract a `canUseStickerForScope(scope, sticker)` helper from the existing
    `canUseSticker(clientId, sticker)` (which becomes a thin wrapper calling it with
    `scopeFor({...})`), so the new route can reuse the lock check from a `userId`
    directly instead of only from a `clientId`.
  - New route `POST /api/account/sticker`: requires `userFromRequest`; validates
    `isValidSticker` (import from `./stickers`) and the lock check; updates
    `users.sticker`; returns `{ ok: true, sticker }`.
  - New exports for lobby.js: `accountStickerForClient(clientId)` (reads
    `users.sticker` via `players.client_id` join) and
    `setAccountStickerForClient(clientId, sticker)` (no-op if `clientId` isn't
    linked to an account).

## 3. Lobby wiring for sticker unification

- `server/lobby.js`:
  - `join` handler: after the existing lock check, if `accountStickerForClient(clientId)`
    returns a sticker, it wins over the client-sent one (still subject to the same
    `canUseSticker` check — an account sticker that got locked since it was set
    should still be dropped, not force-applied).
  - `changeSticker` handler: after persisting to the room as today, also call
    `setAccountStickerForClient(player.clientId, sticker)` (fire, don't block the
    callback on it mattering — mirrors how `recordGameResult` treats the DB as
    best-effort elsewhere).
- Manually verify: sign in on device A, set sticker, open the app fresh on device B
  (or a private window) with the same Google account — confirm the joined sticker
  matches without touching device B's picker.

## 4. The account page itself

- `public/account.html`: new static page, links `style.css`, structure per the
  spec's layout list (header, card, sticker switcher, summary, history table,
  badges, rivals, sign-out/delete). Reuses the existing markup/classes from the
  old `#card-dropdown` block in `index.html` for the parts that carry over
  unchanged (profile, summary, games list → now a table, rivals, badges, guest
  CTA) rather than inventing new class names.
- New `public/js/account-page.js` (ES module, its own entry point — this page has
  no socket, no `main.js`):
  - Reads `localStorage.getItem('imposterClientId')` directly (no getter needed,
    unlike `main.js` which also *creates* one — this page never creates a new
    device id; if it's missing, treat as a guest with no history yet).
  - Fetches `GET /api/auth/config` then `GET /api/me?clientId=...`.
  - Renders: header/sign-in-or-out, the rating card (or locked placeholder for
    guests) with tier-based CSS class, sticker switcher (reusing the sticker-grid
    builder — see "shared render helpers" below), summary line, history table
    (`byGame` sorted by `played` desc, `lost = played - won`), badges grid, rivals
    list.
  - Sign-in button: same Google Identity Services flow as today
    (`POST /api/auth/google`).
  - Sticker switcher: `POST /api/account/sticker`, re-renders the card on success.
  - Sign out (`POST /api/auth/logout`) / delete (`DELETE /api/account`, behind the
    existing `confirmDialog`).
- Extract shared rendering into `public/js/shared/cardRender.js` (badge art/grid,
  rivals list, game-table/row building) so `account-page.js` and the trimmed
  `public/js/shared/account.js` (toasts still need badge art for their pop-ups)
  both import it instead of duplicating DOM-building code.
- Add the six-stat CSS (two rows of three, OVR number, tier gradients per the
  bronze/silver/gold/bright-gold rules) to `style.css`.

## 5. Trim the lobby's account.js + remove the drop-down

- `public/js/shared/account.js`: delete `render()`, `renderRivals()`,
  `renderBadges()` (now in `cardRender.js`), `renderGoogleButton()`/
  `onGoogleCredential()`, and the sign-out/delete handlers — all moved to
  `account-page.js`. What's left: `initAccount()` (config fetch, show/hide
  `#card-btn`, wire `badgesEarned`/`rivalryUpdate` toasts, initial `refreshCard()`),
  `refreshCard()` (now only computes the locked-stickers map from `/api/me`, no
  DOM render of profile/games/etc.), `onLockedStickers()`, and the toast functions
  (`showBadgeToast`/`showRivalryToast`/`queueToast` — these import `badgeArt` from
  the new `cardRender.js` instead of defining it locally).
- `public/js/main.js`: change the `#card-btn` click handler from toggling
  `#card-dropdown` to `window.open('/account.html', '_blank')`.
- `public/index.html`: delete the entire `#card-dropdown` block and its contents.
- Update the "Sign in with Google from 👤 in the lobby" toast copy if it reads
  oddly now that 👤 opens a new tab instead of a dropdown (spec says keep it close
  to today's wording — just confirm it still reads naturally).

## 6. Manual verification (no automated suite — see root `CLAUDE.md`)

- Guest, no sign-in: open `/account.html` — see locked card placeholder, summary,
  history table, badges, rivals (if any), no crash with zero games played.
- Play a few rounds across 3+ of the six games as a guest, then sign in: confirm
  the rating card appears with sensible (not all-50) stats, OVR/tier look right at
  a couple of different OVR values (spot-check the tier thresholds), and guest
  history merged into the account.
- Badge pop-up and rivalry pop-up in the **lobby** still fire correctly after this
  refactor (they're the one thing that must survive `account.js` being gutted).
- Sticker switch on the account page → rejoin a room on the same device → sticker
  matches. Try picking a locked sticker → rejected with the expected error.
- `GOOGLE_CLIENT_ID`/`DATABASE_URL` unset locally: confirm `#card-btn` stays
  hidden and nothing on the lobby/join screens throws.
