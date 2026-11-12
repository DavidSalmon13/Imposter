# Bluff — Implementation Plan

Turns `../specs/bluff-specs.md` into code. That spec is the source of truth for *rules*
(dealing, round progression, scoreboard math, what persists); this doc is the source of truth
for *how it gets built* — file names, function names, event names, room-state shape, and a
step order that keeps every step browser-testable per this repo's testing convention
(`CLAUDE.md` — no automated suite, verify by playing the affected flow in a browser after
every change).

**Read `../specs/bluff-specs.md` in full before starting Step 1.** This doc assumes its
content and doesn't re-derive rules, only where in the code they land. Also skim
`docs/implementation/refactor_plan.md` §4 (the game module contract) and
`docs/implementation/all-in-or-fold-plan.md` (closest sibling plan — same card-game shape, though
Bluff is architecturally much closer to Menifot: frozen roster, host-driven phases, no open
seating).

## Why this game is simpler than its card-game siblings

Unlike Menifot/All-In or Fold, **no player ever submits a gameplay decision to the server**.
The only two things that ever happen are: the host starts the match (once), and the host taps
a seat to record that round's loser (repeatedly). There is no allocation phase, no betting,
no reveal sequencing driven by player input, no side pots, no rebuy. The one piece of real
complexity is the auto-advancing round transition (highlight pause → deal animation → next
round), which is a single-stage version of All-In or Fold's `scheduleRevealStage`/`finishHand`
timer pattern — reuse that shape, not Menifot's host-gated "click Next Round" pattern.

## Target files

**New:**
- `server/games/bluff.js` — the game module (contract shape per `refactor_plan.md` §4).
- `public/js/games/bluff.js` — the client module (`init`/`applyJoin`/`applyState`/`stop`
  shape, matching every other game module).

**Touched:**
- `server/roomStore.js` — add `bf*` fields to `createRoomState()`, plus a `'bluff'` phase
  comment line (`'seating' | 'playing' | 'gameover'`) and add `'bluff'` to the `game` field's
  doc comment.
- `server/gameRegistry.js` — add `bluff` to the `GAMES` map (2 lines, per the contract's own
  promise — no other edits here).
- `public/index.html` — new `#bluff-screen` section (seating screen with count
  slider/Start button + round-table screen with seats/own-hand/host controls + game-over
  ranking screen) + a "Bluff" tile (`choose-bluff-btn`) on the choose-game screen.
- `public/js/main.js` — import the new client module, add it to the `GAMES` map, wire the
  choose-game tile (plain `chooseGame('bluff')` call — no dual-entry complexity like AIOF,
  since there's no open seating), add `BF_MIN_PLAYERS`/`BF_MAX_PLAYERS` to the lobby
  button-enable logic, add the `bluffState` listener.
- `public/style.css` — `bf-*` classes; circular seat layout is new (AIOF's is an oval with
  fixed poker-table seats; Menifot has no table shape at all) — build it as N seats placed via
  `transform: rotate(...) translate(...)` or precomputed `left/top` percentages around a
  circle, whichever this app's existing CSS leans toward (check for any prior circular-layout
  CSS before inventing a new technique).

## Event & function naming reference

Prefix convention: `bf*` (matching `mf*`/`cn*`/`ts*`/`kr*`/`mt*`/`aiof*`).

**Socket events (server → client):**
- `bluffState` — full personalized state broadcast, built by `bluffStatePayload(ctx, room,
  viewerName)`, mirrors `menifotStatePayload`/`aiofStatePayload`. Sent to every connected
  player in the room on every mutation.
- `hostUpdate` — reused as-is on host disconnect/handoff, no special handling needed here.

**Socket events (client → server), all with `(data, callback)` ack shape:**
- `bfSetStartingCount` — `{ count }`, host-only, `phase === 'seating'`. Clamps to
  `1..floor(52/connectedCount)`. Stores the pending choice in `room.bfPendingStartCount` (not
  yet `bfCounts` — that's only populated at Start Match) so the slider's value survives a
  broadcast round-trip and is visible read-only to non-host players.
- `startBluffMatch` — host-only, `phase === 'seating'`, requires
  `BF_MIN_PLAYERS <= connectedNames(room).length <= BF_MAX_PLAYERS`. Freezes `bfPlayers =
  connectedNames(room)` (fixed order), sets `bfCounts[name] = startCount` for everyone (using
  `bfPendingStartCount`, defaulting to the slider's max if never set), resets
  `bfRoundNumber`/`bfEliminationOrder`, sets `phase = 'playing'`, calls `dealBluffRound`.
- `bfSelectLoser` — `{ name }`, host-only, `phase === 'playing'`, only valid when
  `room.bfHands` is populated and `room.bfLastResult == null` (i.e. a round is actually dealt
  and no transition is already in flight), `name` must be in `bfPlayers` with
  `bfCounts[name] > 0`. Decrements the count, appends to `bfEliminationOrder` if now 0, sets
  `bfLastResult`, broadcasts, checks the win condition, and either ends the match or schedules
  the next deal after `BF_LOSER_HIGHLIGHT_MS + BF_DEAL_ANIMATION_MS`.
- `bfResetGame` — host-only, `phase === 'playing' | 'gameover'`. Clears
  `bfCounts`/`bfRoundNumber`/`bfEliminationOrder`/`bfHands`/`bfLastResult`, keeps `bfPlayers`,
  sets `phase = 'seating'`.
- Back to Lobby reuses the app's existing shared `backToLobby` handler — `clearState` resets
  every `bf*` field including `bfPlayers`.

**Server-side functions in `server/games/bluff.js`** (suggested names):
- `clampStartingCount(count, connectedCount)` — `1..floor(52/connectedCount)`, pure function.
- `dealBluffRound(ctx, roomCode, room)` — the core deal: `shuffle(buildDeck())` (reuse
  `pokerEval.buildDeck` + `lib/shuffle.shuffle`), then for every name in `bfPlayers` with
  `bfCounts[name] > 0`, slice off exactly that many cards in sequence off the shuffled deck
  into `room.bfHands[name]`. Increments `bfRoundNumber`, clears `bfLastResult`, broadcasts.
  Called both from `startBluffMatch` (round 1) and from the scheduled timer after a loser pick
  (every later round) — same function, no special-casing round 1 beyond the caller having just
  set up `bfCounts`.
- `activeBluffPlayers(room)` — `bfPlayers.filter((n) => (bfCounts[n] || 0) > 0)`. Used for both
  "who can be picked as loser" and the win check.
- `applyBluffLoss(ctx, roomCode, room, name)` — validates `name` is active, decrements
  `bfCounts[name]`, pushes to `bfEliminationOrder` if it hit 0, sets `bfLastResult = {
  loserName: name, newCount, eliminated: newCount === 0 }`, broadcasts immediately (for the
  highlight), then either calls `finishBluffMatch` (if `activeBluffPlayers(room).length ===
  1`) or schedules `dealBluffRound` via a module-local timer keyed by `roomCode` (same
  `clearTimeout`-on-reuse pattern as AIOF's `aiofTimers` map — needed so a `Reset Game`/`Back
  to Lobby` mid-transition can't let a stale timer fire into a cleared room).
- `computeBluffRanking(room)` — winner (the one name still active) first, then
  `bfEliminationOrder` reversed; `N - index` points each, `N = bfPlayers.length`. No tie
  handling needed (elimination order is always a strict total order) — simpler than
  `awardMenifotScoreboard`/`awardAiofScoreboard`, don't copy their tie-grouping loop.
- `finishBluffMatch(ctx, roomCode, room)` — sets the winner, calls `computeBluffRanking`, adds
  each row's points via `ctx.addScore`, sets `phase = 'gameover'`, broadcasts.
- `bluffStatePayload(ctx, room, viewerName)` — personalized: `seats` (ordered `bfPlayers` map
  → `{ name, seatIndex, count, eliminated, connected }`, connected pulled from
  `room.players.get(name).connected`), `roundNumber`, `myHand` (only the viewer's own
  `bfHands[viewerName]`, `null` if not dealt/not a player), `lastResult`
  (`room.bfLastResult`), `startCountBounds` (`{ min: 1, max: floor(52/connectedCount) }`,
  seating phase only), `pendingStartCount`, `canStart`, `canResetGame`, and — only when
  `phase === 'gameover'` — `ranking` + `scoreboard`.
- `broadcastBluff(ctx, roomCode, room)` — iterates `room.players`, emits personalized
  `bluffState` per connected socket, mirrors `broadcastMenifot`/`broadcastAiof`.

**Module-local timer map** (mirrors `aiofTimers` in `allInOrFold.js`): a `Map<roomCode,
Timeout>` for the scheduled post-loss deal, with a `clearBluffTimer(roomCode)` helper called
at the top of `applyBluffLoss`, `bfResetGame`, and `clearState` — prevents a stale scheduled
deal from firing into a room that's been reset or left the game since.

## Server state additions (`room.bf*`)

Add to `createRoomState()` in `roomStore.js`, grouped under a `// Bluff` comment block, plus a
phase-enum comment line alongside the existing ones:

```js
// Bluff phases: 'seating' | 'playing' | 'gameover'
```

```js
// Bluff
bfPlayers: [], // frozen match roster, fixed order = round-table seat order
bfCounts: {}, // name -> current card count, persists across rounds, -1 on a loss
bfPendingStartCount: 0, // seating-phase slider value, chosen before Start Match freezes it
bfRoundNumber: 0, // current round number, display-only
bfEliminationOrder: [], // names in the order they hit 0 cards, oldest first
bfHands: {}, // name -> this round's dealt cards (NOT persisted, see ROOM_SAVED_FIELDS below)
bfLastResult: null, // { loserName, newCount, eliminated } during the highlight/deal pause (NOT persisted)
```

`ROOM_SAVED_FIELDS` includes `bfPlayers`, `bfCounts`, `bfRoundNumber`, `bfEliminationOrder` —
enough to resume a match cleanly after a restart. `bfHands`/`bfLastResult` are deliberately
excluded — `repairOnLoad` re-deals the current round fresh instead of trying to resume it (see
Step 6).

## Implementation order

Work through this as a stack of small, independently browser-verifiable steps — not one big
PR. Each item is a checkbox. **Convention (same as `refactor_plan.md` §7 / the sibling plans):
find the first `- [ ]` item, implement only that one, verify it in a real browser per its
Verify note, then flip it to `- [x]`. Don't start the next box in the same pass.** After every
step, also spot-check that the other seven games still work (choose game → play → back to
lobby), since `roomStore.js`/`gameRegistry.js`/`main.js` are shared files.

- [x] **Step 1 — Server scaffolding + seating screen + the tile.** Add the `bf*` fields to
  `createRoomState()`. Create `server/games/bluff.js` with the full contract shape (`id:
  'bluff'`, `minPlayers: BF_MIN_PLAYERS`, `maxPlayers: BF_MAX_PLAYERS`, `savedFields`, a
  minimal `onChoose` that resets `bf*` fields and sets `phase = 'seating'`, a `registerHandlers`
  with just `bfSetStartingCount`, a `reconnectPayload` that returns the current
  `bluffStatePayload` (seating-phase players resume the seating screen; mid-match players
  resume the table, same pattern as Menifot — **not** AIOF's lobby-bounce exception, since
  there's no open seating here), a no-op `onDisconnect` that just rebroadcasts (for the offline
  badge), `clearState`). Add it to `gameRegistry.js`'s `GAMES` map. Add `#bluff-screen` to
  `index.html`: seating sub-view with a starting-count slider (host-editable, others read-only)
  and a "Start Match" button, plus the standard back-to-lobby button. Add the "Bluff" tile.
  Create `public/js/games/bluff.js` exporting `{ init, applyJoin, applyState, stop }`. Wire into
  `main.js` the same plain way every non-AIOF game is wired (import, `GAMES` map entry,
  `BF_MIN_PLAYERS` in the lobby button-enable logic, `bluffState` listener →
  `showScreen('bluff')`). **Verify:** from the lobby, tap the Bluff tile, land on the seating
  screen; move the count slider as host and confirm a second tab (non-host) sees the value
  update read-only; confirm the slider's max shifts down live if a third tab joins the room;
  "Back to Lobby" returns everyone cleanly; all seven other games still work.

- [x] **Step 2 — Start Match + round 1 dealing + private hands.** Implement
  `clampStartingCount` and the `startBluffMatch` handler (freeze `bfPlayers`, set `bfCounts`
  for everyone, reset round/elimination tracking, `phase = 'playing'`). Implement
  `dealBluffRound` using `pokerEval.buildDeck()` + `lib/shuffle.shuffle()`, dealing each active
  player exactly their `bfCounts[name]` cards. Build `#bluff-screen`'s table sub-view: circular
  seat layout (name, seat number, count) in `bfPlayers` order, plus a "my hand" row of cards
  below rendered from `myHand`. No host controls yet (Step 3). **Verify:** with 3+ tabs at
  different starting counts tested via the slider, click Start as host, confirm every tab
  lands on the table showing all seats with the correct starting counts, confirm each tab's
  own hand shows exactly that many real, distinct cards, and confirm no tab can see any other
  player's hand (check the raw `bluffState` payload in devtools, not just the rendered UI, to
  make sure other players' hands truly aren't sent over the wire).

- [x] **Step 3 — Host picks a loser, highlight, auto-advance to the next round.** Implement
  `activeBluffPlayers`, `applyBluffLoss` (decrement, push to `bfEliminationOrder` if now 0, set
  `bfLastResult`, broadcast immediately, then schedule `dealBluffRound` via the module-local
  timer map after `BF_LOSER_HIGHLIGHT_MS + BF_DEAL_ANIMATION_MS` unless the win check fires
  first — Step 4 handles that branch). Implement the `bfSelectLoser` handler (host-only,
  requires `bfHands` populated and `bfLastResult == null`, `name` must be active). Client: only
  the host sees seats as tappable; tapping opens a confirm ("Mark `<name>` as this round's
  loser?"); on confirm emits `bfSelectLoser`. On receiving `lastResult`, every client highlights
  that seat for `BF_LOSER_HIGHLIGHT_MS`, then plays a shuffle/deal CSS animation for the
  remaining `BF_DEAL_ANIMATION_MS` before the next `bluffState` (with the new round's hands)
  naturally replaces it. **Verify:** as host, tap a seat, confirm the dialog, confirm that
  player's count ticks down by 1 on every tab, confirm the seat highlights briefly, confirm a
  new round auto-deals a few seconds later with fresh hands (check your own hand actually
  changed), confirm `bfSelectLoser` is rejected if tapped again before the next round lands
  (no double-decrement from a double-tap).

- [x] **Step 4 — Elimination display + win detection + scoreboard.** Client: seats at
  `count === 0` render grayed-out/eliminated, staying in their fixed circle position (no
  re-layout). Server: in `applyBluffLoss`, after decrementing, check
  `activeBluffPlayers(room).length === 1`; if so, skip scheduling another deal and instead call
  `finishBluffMatch` (implement `computeBluffRanking` — winner first, then
  `bfEliminationOrder` reversed, `N - index` points, no tie logic — and `finishBluffMatch`
  itself: award via `ctx.addScore`, `phase = 'gameover'`, broadcast). Client: game-over screen
  listing the full ranking with points, plus the existing shared scoreboard totals. **Verify:**
  play a full match down to one player standing (fastest with 2 players and a starting count of
  1-2) — confirm eliminated players visibly gray out immediately and stay in their seat,
  confirm the match ends the instant one player remains (no extra deal happens after the
  second-to-last elimination), confirm the ranking order matches reverse elimination order
  exactly, confirm scoreboard points land in `room.scoreboard` correctly with a 3+ player match
  (so there's at least one non-trivial elimination-order rank to check).

- [x] **Step 5 — Reset Game.** Server: `bfResetGame` handler (host-only, `phase === 'playing'`
  or `'gameover'`) — clears the timer via `clearBluffTimer`, resets
  `bfCounts`/`bfRoundNumber`/`bfEliminationOrder`/`bfHands`/`bfLastResult`, keeps `bfPlayers`,
  sets `phase = 'seating'`. Client: "Reset Game" button, visible to the host on both the table
  and game-over screens. **Verify:** mid-match and again from the game-over screen, click Reset
  as host, confirm everyone lands back on the seating screen with the *same* roster (no need to
  re-choose the game from the lobby), confirm a fresh Start Match deals cleanly with newly
  chosen counts.

- [x] **Step 6 — Disconnect handling & restart resilience.** Server: `onDisconnect` just
  rebroadcasts (the offline badge is purely derived from `room.players.get(name).connected` in
  `bluffStatePayload`, no state mutation needed). Confirm host handoff (already generic, handled
  by `lobby.js`) works unchanged when the host disconnects mid-match — the next host can still
  tap seats to pick losers. `repairOnLoad`: if `room.game === 'bluff'` and `room.phase ===
  'playing'`, clear `bfHands`/`bfLastResult` and call `dealBluffRound` immediately (no "waiting
  for players" gate — the roster is frozen and doesn't depend on who's currently connected,
  unlike AIOF). If `room.phase === 'seating'`, just ensure `bfPendingStartCount` is a sane
  number. **Verify:** disconnect a non-host player mid-match (close their tab) — confirm their
  seat shows offline but the host can still pick them as a loser and the match continues
  normally; disconnect the host — confirm handoff to another player and that they can still
  drive the game; restart the dev server mid-match — confirm the room reloads with everyone's
  persisted counts/round number/elimination order intact and a freshly-dealt current round
  (new hands, not the pre-restart ones).

- [x] **Step 7 — Visual polish + full regression.** Style `bf-*` elements in `style.css`:
  circular seat layout, grayed-out eliminated seats, loser-highlight animation, shuffle/deal
  animation, own-hand card row. Confirm the existing global click-sound/haptics listener in
  `main.js` covers all new buttons automatically (generic `document.addEventListener('click',
  ...)` on any `<button>`). Final full regression: play all eight games back-to-back in one
  sitting per `CLAUDE.md`'s testing convention, plus one disconnect/reconnect and one Reset
  Game for Bluff specifically since it's the newest.

## Testing notes

No automated suite exists (per `CLAUDE.md`); this plan leans on the same manual-QA convention
every other game in this repo uses. Functions worth keeping test-friendly even without a
runner yet, per `refactor_plan.md` §8's own reasoning:

- `clampStartingCount` — pure, sharp edge cases at the `floor(52/N)` boundary.
- `computeBluffRanking` — pure, no `room`/`ctx` needed if passed `bfPlayers`/`bfCounts`/
  `bfEliminationOrder` directly; worth extracting with that narrow signature specifically so
  it's trivially testable, even though nothing else in this plan demands pure functions as
  strongly as this one (it's the entire scoreboard-correctness surface of the game).
- `dealBluffRound`'s card-slicing logic — deterministic given a fixed shuffled deck, easy to
  assert "no two players share a card, everyone gets exactly `bfCounts[name]` cards."

## Out of scope

Everything already listed in `../specs/bluff-specs.md`'s own "Explicitly out of scope (v1)"
section applies here unchanged — this plan doesn't add scope beyond that spec, only sequences
building it.
