# All-In or Fold — Implementation Plan

Turns `../specs/all-in-or-fold-specs.md` into code. That spec is the source of truth for
*rules* (stakes, side pots, seating, rebuy, leave/rejoin, scoreboard math); this doc is the
source of truth for *how it gets built* — concrete file names, function names, event names,
room-state shape, and a step order that keeps every step browser-testable per this repo's
testing convention (`CLAUDE.md` — no automated suite, verify by playing the affected flow in
a browser after every change).

**Read `../specs/all-in-or-fold-specs.md` in full before starting Step 1.** This doc assumes
its content and doesn't re-derive rules (side-pot math, rebuy semantics, etc.), only where in
the code they land. Also skim `implementation/refactor_plan.md` §4 (the game module contract)
and `implementation/music-timeline-plan.md` (closest sibling plan in this repo, same format).

## Why this game is architecturally different from the other six

Every other game in this app is **synchronous per room**: the whole room moves through one
shared sequence of phases together (`lobby` → game → `gameover` → `lobby`), and a player who
disconnects/reconnects always lands back on whatever screen matches the room's current phase.
Choosing a game is host-only and blocked once `room.phase !== 'lobby'` (see
`server/lobby.js`'s `chooseGame` handler) — that's why every other game shows "game in
progress, wait for the next round" to new joiners.

All-In or Fold breaks this on purpose (per the spec's "open seating" rules): a player can step
away mid-match ("Leave Lobby") and a **different** player (or the same one later) can sit in
their vacated seat, mid-match, without the room ever leaving `room.game === 'allinorfold'`.
That means **individual players can be on different screens at the same time** — some at the
table, some back at the shared "choose a game" lobby screen — which nothing else in this
codebase does. Two consequences, both handled entirely inside the new files (no changes to
`server/lobby.js` or `server/gameRegistry.js` needed):

1. **A new socket event pair, `aiofLeaveTable` / `enterAllInOrFold`, lives entirely inside
   `server/games/allInOrFold.js`**, separate from the shared `chooseGame`/`backToLobby`
   handlers. `chooseGame` is still used exactly once per match — by the host, from
   `room.phase === 'lobby'` — to create the table. `enterAllInOrFold` is what any player
   (including ones who never left) uses to (re)view an **already-active** AIOF match; it works
   regardless of `room.phase`, which `chooseGame` deliberately does not allow for any other
   game.
2. **The client tracks a local `aiofAtTable` boolean**, independent of `room.game`/`currentGame`.
   The `aiofState` broadcast is still sent to *every* connected player in the room (simplest,
   matches every other game's broadcast pattern) — but the client only calls
   `showScreen('allInOrFold')` on receipt of that event when `aiofAtTable` is true. Leaving sets
   it false and navigates to the shared lobby screen; entering/re-entering sets it true.
3. **Reconnects don't resume the table automatically.** Per the spec, a real disconnect is
   handled identically to a voluntary "Leave Lobby" — seat freed immediately, stack/buy-ins
   preserved by name. So `allInOrFold.reconnectPayload` deliberately returns a "you're at the
   shared lobby" indicator, not table state — the reconnecting client shows the normal
   game-choice screen (with the AIOF tile in "rejoin" mode, see Step 7) rather than being
   dropped back at a seat. This is a **deliberate exception** to the pattern every other game's
   `reconnectPayload` follows (which resumes the in-progress screen) — don't copy this
   exception into any other game.

Keep this section in mind for Steps 2, 7, and 10 — it's the one place this game's shape doesn't
match its five siblings.

## Target files

**New:**
- `server/games/pokerEval.js` — extracted from `server/games/menifot-eval.js` (see Step 1).
- `server/games/allInOrFold.js` — the game module (contract shape per `refactor_plan.md` §4).
- `public/js/games/allInOrFold.js` — the client module (`init`/`applyJoin`/`applyState`/`stop`
  shape, matching every other game module).

**Touched:**
- `server/games/menifot.js` — swap its `require('./menifot-eval')` for
  `require('./pokerEval')`, no logic change (Step 1).
- `server/roomStore.js` — add `aiof*` fields to `createRoomState()`.
- `server/gameRegistry.js` — add `allinorfold` to the `GAMES` map (2 lines, per the contract's
  own promise — no other edits here).
- `public/index.html` — new `#aiof-screen` section (poker table + seats + decision UI + ranking
  screen) + an "All-In or Fold" tile on the choose-game screen.
- `public/js/main.js` — import the new client module, add it to the `GAMES` map, wire the
  choose-game tile with the dual `chooseGame`/`enterAllInOrFold` logic (Step 7), add
  `AIOF_MIN_PLAYERS` to the lobby button-enable logic, add the `aiofState` listener with the
  `aiofAtTable` gate described above.
- `public/style.css` — `aiof-*` classes; reuse the existing poker-table visual language from
  the Menifot/Codenames restyle (`9800b93 Restyle Menifot boards and cards as a poker table`)
  since this game *is* a poker table, more literally than Menifot is.

## Event & function naming reference

Prefix convention: `aiof*` (matching `mf*`/`cn*`/`ts*`/`kr*`/`mt*`).

**Socket events (server → client):**
- `aiofState` — full personalized state broadcast, built by
  `aiofStatePayload(ctx, room, viewerName)`, mirrors `menifotStatePayload`. Sent to **every**
  connected player in the room on every mutation, regardless of whether they're currently
  "at the table" client-side (see architecture note above) — the client decides whether to
  navigate, the server doesn't track who's "watching."
- `hostUpdate` — reused as-is (existing app-wide event), fires on host handoff whether from a
  real disconnect or an `aiofLeaveTable` call by the host.

**Socket events (client → server), all with `(data, callback)` ack shape:**
- `startAllInOrFold` — host-only, `room.phase === 'seating'`, requires ≥ `AIOF_MIN_PLAYERS`
  occupied seats. Moves to `room.phase = 'playing'` and deals the first hand.
- `aiofSitSeat` — `{ seatIndex }`, any player without a current seat, valid during `'seating'`
  or `'playing'`. First-time sit this match grants `AIOF_STARTING_STACK` and 1 buy-in; a
  returning player (same name, already has `aiofStacks[name]` from earlier this match) resumes
  their existing stack/buy-in count instead of granting a fresh one.
- `aiofDecision` — `{ decision: 'ALL_IN' | 'FOLD' }`, only the seat whose turn it currently is
  (`room.aiofHand.actingSeat`), only during `room.aiofHand.stage === 'deciding'`.
- `aiofBuyIn` — the seated player whose stack is 0 and who is `sittingOut`. Resets their stack,
  increments their buy-in count, clears `sittingOut`.
- `aiofDeclineBuyIn` — same eligibility as `aiofBuyIn`; explicitly sets `sittingOut = true`
  (distinguishing "haven't decided yet" from "chose to sit out," relevant for the UI prompt).
- `aiofLeaveTable` — **any** seated or sitting-out player, at any time. Auto-folds them if it's
  currently their decision or one is pending on them later this hand, frees their seat
  immediately, preserves `aiofStacks[name]`/`aiofBuyIns[name]`/`aiofEverSeated` untouched. Server
  responds `{ ok: true }`; the client then sets `aiofAtTable = false` and navigates to the
  shared lobby screen itself (server doesn't push a screen change).
- `enterAllInOrFold` — any player, valid whenever `room.game === 'allinorfold'` (any phase).
  Does **not** assign a seat — just returns the current `aiofStatePayload` so the client can
  render the table (with an open-seat picker for whoever isn't currently seated). This is the
  event the "rejoin" version of the lobby tile uses (see Step 7); it deliberately bypasses the
  shared `chooseGame` handler's `room.phase === 'lobby'` guard.
- `endAllInOrFoldGame` — host-only, only when `room.aiofHand == null` (strictly between hands —
  reject if a hand is in progress). Computes final ranking, awards `room.scoreboard`, sets
  `room.phase = 'gameover'`.
- Back to Lobby reuses the app's existing shared `backToLobby` handler (host-only, room-wide
  hard reset) — `gameRegistry.clearAllGameState` calls `allInOrFold.clearState`. This stays
  available as the contract-required escape hatch, but the *designed* end-of-match flow is
  `endAllInOrFoldGame` → ranking screen → each player's own `aiofLeaveTable` (or the room's
  `leaveLobby` if they want to leave the room entirely — a different, pre-existing event, not
  built here).

**Server-side functions in `server/games/allInOrFold.js`** (suggested names — keep the module
reading like its siblings):
- `occupiedSeatIndexes(room)` / `activeSeatIndexes(room)` — the latter excludes `sittingOut`
  seats; both skip `null` seats. Used everywhere "next seat clockwise" is needed.
- `nextSeatClockwise(room, fromIndex, { activeOnly })` — wraps around `AIOF_MAX_SEATS`.
- `sitInSeat(ctx, room, name, seatIndex)` — validates the seat is open and in range; grants a
  fresh stack/buy-in only if `aiofStacks[name]` doesn't already exist this match; adds `name`
  to `aiofEverSeated`.
- `leaveSeat(ctx, roomCode, room, name)` — shared by `aiofLeaveTable` and `onDisconnect`. If
  `room.aiofHand` exists and `name` hasn't acted yet this hand (including if it's currently
  their turn), record an implicit FOLD for them via `applyDecision` first, **then** clear their
  seat. Does not touch `aiofStacks`/`aiofBuyIns`/`aiofEverSeated`.
- `dealNextHand(ctx, roomCode, room)` — the top of the hand loop: checks
  `activeSeatIndexes(room).length >= AIOF_MIN_PLAYERS` (else sets `room.aiofHand = null` and
  broadcasts a "waiting for players" state); otherwise shuffles a 52-card deck (reuse
  `pokerEval.buildDeck`), deals 6 hole cards to each active seat + 5 board cards, advances
  `room.aiofDealerSeat` to the next occupied seat clockwise, posts blinds via `postBlinds`, and
  builds the action order (every non-folded active seat clockwise from the seat after the big
  blind, wrapping to end with small blind then big blind — see spec's decision-phase section).
- `postBlinds(room)` — posts SB/BB from `aiofStacks`, capping at the poster's stack if short
  (the short-stack-blind exception — that poster is immediately marked as having "acted" this
  hand with an implicit ALL-IN for the reduced amount, per spec).
- `applyDecision(ctx, roomCode, room, name, decision)` — validates it's `name`'s turn, records
  ALL-IN (moves their full remaining stack into `room.aiofHand.contributions[name]`) or FOLD,
  advances to the next actor via the action-order queue built in `dealNextHand`. After every
  FOLD, calls `checkUncontestedWin` before advancing further.
- `checkUncontestedWin(ctx, roomCode, room)` — if exactly one non-folded seat remains (whether
  or not everyone has technically acted), immediately awards that player the entire pot
  (main + all side pots collapse to them), skips reveal/showdown entirely, and calls
  `finishHand`.
- `buildSidePots(room)` — the layered side-pot algorithm from the spec: dead money from folded
  blinds into the main pot; sort live ALL-IN amounts ascending; build one pot layer per distinct
  threshold with the correct eligible-player set per layer. Returns
  `[{ amount, eligibleNames }, ...]`. **Write this as a standalone pure function** (takes
  `{ contributions, foldedNames }`, no `room`/`ctx`) so it's unit-testable later, matching this
  repo's own guidance in `refactor_plan.md` §8 about pure logic being "cheapest to unit test,
  highest value."
- `runReveal(ctx, roomCode, room)` — the staged flop/turn/river/showdown sequence using
  `setTimeout` (mirrors Codenames' `cnTimerHandles` pattern for module-local timer handles keyed
  by room code, so a room reset can clear a pending timer). Each stage updates
  `room.aiofHand.stage`/revealed board slice and broadcasts; the final stage calls
  `pokerEval.rankBoard` once per pot layer (via `buildSidePots`), passing only that layer's
  eligible players' hole cards + the full revealed board, and calls `awardPots`.
- `awardPots(ctx, room, sidePots, rankingsPerLayer)` — adds each layer's pot (split evenly among
  tied winners, per `rankBoard`'s existing split behavior) to the winners' `aiofStacks`, then
  calls `finishHand`.
- `finishHand(ctx, roomCode, room)` — clears `room.aiofHand`, checks every seated player's stack
  for 0 (prompts rebuy via the state payload's `needsBuyInDecision` flag — no separate event
  fired, the client just renders the prompt when it sees `stack === 0 && !sittingOut`), then
  either calls `dealNextHand` again after a short pause (auto-advance) or sets the
  "waiting for players" state.
- `aiofStatePayload(ctx, room, viewerName)` — personalized: seat list (name/stack/sittingOut per
  seat, no hole cards for anyone but `viewerName`), viewer's own hole cards (only while they hold
  a seat and cards have been dealt), current hand stage/board (only the revealed slice — never
  send unrevealed board or other players' hole cards to the client at all, not just hide them in
  the UI), whose turn it is, pot total(s), last hand's result summary (brief, for the pause
  before the next auto-deal), and — only when `room.phase === 'gameover'` — the final ranking
  table (`aiofEverSeated` names × final stack × net profit × scoreboard points awarded).
- `broadcastAiof(ctx, roomCode, room)` — iterates `room.players`, emits personalized `aiofState`
  per connected socket, mirrors `broadcastMenifot`.
- `computeNetProfit(room, name)` — `aiofStacks[name] - AIOF_STARTING_STACK * aiofBuyIns[name]`.
- `awardAiofScoreboard(ctx, room)` — ranks `aiofEverSeated` by `computeNetProfit` descending,
  standard competition ranking (ties share rank/points, next rank skips), mirrors
  `awardMenifotScoreboard`'s tie logic exactly.

## Server state additions (`room.aiof*`)

Add to `createRoomState()` in `roomStore.js`, grouped under a `// All-In or Fold` comment block,
plus a phase-enum comment line:

```js
// All-In or Fold phases: 'seating' | 'playing' | 'gameover'
// (intra-hand sub-state lives in room.aiofHand.stage, not room.phase — the client stays on
// the same table screen for the whole 'playing' phase; only aiofHand.stage changes the UI.)
```

```js
// All-In or Fold
aiofSeats: [null, null, null, null, null, null], // seatIndex -> name | null
aiofStacks: {}, // name -> current chip stack, present once they've ever sat this match
aiofBuyIns: {}, // name -> total buy-in count this match (starts at 1 on first sit)
aiofSittingOut: {}, // name -> true if busted and declined rebuy (seat stays theirs)
aiofDealerSeat: -1, // seat index; -1 until the first hand deals (starts at the host's seat)
aiofEverSeated: [], // every name that has ever occupied a seat this match, for final ranking
aiofHand: null, // { stage, deck, holeCards, board, revealedCount, contributions, folded,
                //   actionOrder, actingIndex } while a hand is in progress; null between hands
aiofResults: null, // last hand's brief outcome, shown during the auto-advance pause
```

`aiofHand.stage` values: `'deciding'` → `'revealingFlop'` → `'revealingTurn'` →
`'revealingRiver'` → `'showdown'`. An uncontested fold-out (Step 4) skips straight from
`'deciding'` to hand end without ever entering a `revealing*` stage.

`ROOM_SAVED_FIELDS` includes `aiofSeats`, `aiofStacks`, `aiofBuyIns`, `aiofSittingOut`,
`aiofDealerSeat`, `aiofEverSeated` — enough to resume a match cleanly after a restart.
`aiofHand`/`aiofResults` are deliberately excluded — `repairOnLoad` drops any in-flight hand
back to "waiting for next hand," same simplification Menifot uses for its in-flight allocation
state (see Step 10).

## Implementation order

Work through this as a stack of small, independently browser-verifiable steps — not one big
PR. Each item is a checkbox. **Convention (same as `refactor_plan.md` §7 / the Music Timeline
plan): find the first `- [ ]` item, implement only that one, verify it in a real browser per its
Verify note, then flip it to `- [x]`. Don't start the next box in the same pass.** After every
step, also spot-check that the other six games still work (choose game → play → back to lobby),
since `roomStore.js`/`gameRegistry.js`/`main.js` are shared files.

- [x] **Step 1 — Extract the shared poker evaluator.** Create `server/games/pokerEval.js`
  containing exactly what's in `menifot-eval.js` today (`buildDeck`, `combinations`,
  `bestOmahaHand`, `rankBoard`) — a pure rename/move, no logic changes. Update
  `server/games/menifot.js`'s `require('./menifot-eval')` to `require('./pokerEval')`. Delete
  `menifot-eval.js`. **Verify:** play a full Menifot round (2+ players, allocate, lock, reveal,
  confirm a winner is computed correctly, including at least one split-board scenario if you can
  force one) — behavior must be pixel-identical to before, since no logic changed.

- [x] **Step 2 — Server scaffolding + empty seating screen + the dual-entry lobby tile.** Add
  the `aiof*` fields to `createRoomState()`. Create `server/games/allInOrFold.js` with the full
  contract shape (`id: 'allinorfold'`, `minPlayers: AIOF_MIN_PLAYERS`,
  `maxPlayers: AIOF_MAX_SEATS`, `savedFields`, a minimal `onChoose` that resets `aiof*` fields
  and sets `phase = 'seating'`, stub `registerHandlers` with just `enterAllInOrFold`, a
  `reconnectPayload` that returns `{ ok: true, atLobby: true }` per the architecture note above,
  a no-op `onDisconnect`/`clearState`). Add it to `gameRegistry.js`'s `GAMES` map. Add
  `#aiof-screen` to `index.html` (bare-bones: "All-In or Fold (under construction)" heading +
  the standard back-to-lobby button). Create `public/js/games/allInOrFold.js` exporting
  `{ init, applyJoin, applyState, stop }` with a module-local `aiofAtTable` boolean; `applyState`
  only calls `showScreen('allInOrFold')` when `aiofAtTable` is true, otherwise it's a no-op (the
  data still updates hidden state so a later screen-show has fresh data). Wire into `main.js`:
  import, add to `GAMES`, add `AIOF_MIN_PLAYERS` to `renderLobby`'s button-enable logic, and give
  the "All-In or Fold" tile **dual behavior**: if `currentGame !== 'allinorfold'`, clicking it
  calls `chooseGame('allinorfold')` (host-only, existing shared handler) and sets
  `aiofAtTable = true` on success; if `currentGame === 'allinorfold'` already (i.e. a match is
  running and this player isn't currently rendered at it), clicking it instead calls
  `enterAllInOrFold` and sets `aiofAtTable = true` on success — render the tile's label as
  "All-In or Fold" vs. "Rejoin All-In or Fold" accordingly. **Verify:** from the lobby, host taps
  the tile, lands on the stub screen; a second browser tab (different player) also taps the tile
  and — because `currentGame` is already `'allinorfold'` for them once they see the
  `gameChosen` broadcast — goes through the `enterAllInOrFold` path instead and also lands on
  the stub screen; "Back to Lobby" returns everyone cleanly; all six other games still work.

- [x] **Step 3 — Seat picking + Start.** Client: render 6 seat slots on the table; tapping an
  open seat (only when the viewer doesn't already have one) emits `aiofSitSeat`; occupied seats
  show the sitter's name + stack. Server: `aiofSitSeat` handler (validate seat range/openness,
  call `sitInSeat`, broadcast). `startAllInOrFold` handler: host-only, `phase === 'seating'`,
  requires `occupiedSeatIndexes(room).length >= AIOF_MIN_PLAYERS`; sets `aiofDealerSeat` to the
  host's own seat index, `phase = 'playing'`, and calls `dealNextHand` (Step 4 will make this
  actually deal — for now it can just set `phase` and leave `aiofHand` null so Step 3 is
  independently verifiable). **Verify:** with 2+ tabs, sit in different seats, confirm a seat
  someone else already took can't be double-taken, confirm "Start" stays unavailable below
  `AIOF_MIN_PLAYERS` occupied, confirm the host's seat is recorded as the initial dealer.

- [x] **Step 4 — Dealing, blinds, decisions, uncontested fold-out, single-pot showdown.** Get
  one full hand playable end-to-end with the *simple* pot case first (skip multi-layer side pots
  until Step 5 — if all-in amounts happen to differ this step can just sum everything into one
  pot and award it all to the showdown winner; Step 5 will correct this). Implement
  `dealNextHand` fully: shuffle, deal 6 hole cards + 5 board cards, post blinds (including the
  short-stack exception), build the action order, set `stage = 'deciding'`. Implement
  `applyDecision` and the `aiofDecision` handler (auth-check it's the acting seat's turn).
  Implement `checkUncontestedWin`. Implement a **single-pot** version of `runReveal` (stage
  through flop/turn/river on `AIOF_REVEAL_STAGE_DELAY_MS` timers, then reveal all-in players'
  hole cards, call `pokerEval.rankBoard` once across everyone still live, award the whole pot to
  the winner(s) with splits). Client: hole-card display (own cards only), board reveal
  animation per stage, ALL-IN/FOLD buttons enabled only for the acting seat, pot total display.
  **Verify:** play several hands with 2-3 players where nobody folds down to one — confirm blinds
  post correctly (including a forced short-stack all-in if you engineer a low stack), confirm
  action order goes clockwise from after the big blind and wraps through SB then BB last,
  confirm the staged reveal shows flop-pause-turn-pause-river before hole cards, confirm ties
  split the pot. Also play one hand where everyone but one player folds before the last player's
  turn — confirm the hand ends instantly with no reveal and no prompt for that last player.

- [x] **Step 5 — Full side-pot math.** Implement `buildSidePots` as a standalone pure function
  per the spec's algorithm (dead money from folded blinds into the main pot; layered pots by
  distinct all-in thresholds; correct eligibility per layer). Rewire `runReveal`/`awardPots` to
  call `buildSidePots`, then run `pokerEval.rankBoard` **once per layer** (only that layer's
  eligible players) and award each layer independently. **Verify:** engineer the spec's worked
  example directly — 3 players, get one to shove a smaller stack than the other two (adjust
  starting stacks via a few hands of losing, or temporarily lower `AIOF_STARTING_STACK` while
  testing to force this faster) — confirm the short stack can only win the main pot even when
  they'd have won the side pot's showdown too, and confirm the side pot is correctly contested
  only between the two larger stacks. Also verify a hand with folded blinds contributes their
  dead money into the main pot without making the folder eligible to win it.

- [x] **Step 6 — Busting & rebuy / sit-out.** In `finishHand`, after payouts, check every seated
  player's stack; if 0, leave them seated but flag them (via the state payload, not a fresh
  event) as needing a buy-in decision. Client: "Buy-in" / "Sit out" prompt for that player only,
  wired to `aiofBuyIn` / `aiofDeclineBuyIn`. Server handlers: `aiofBuyIn` resets stack to
  `AIOF_STARTING_STACK`, increments `aiofBuyIns[name]`, clears `aiofSittingOut[name]`.
  `aiofDeclineBuyIn` sets `aiofSittingOut[name] = true`. `dealNextHand`/`activeSeatIndexes` must
  already skip sitting-out seats (confirm this from Step 4, don't re-derive). A sitting-out
  player still shows on the table (seat occupied, grayed out, their own "Buy-in" button always
  visible to them regardless of whose turn anything is). **Verify:** play stacks down until
  someone busts, confirm the prompt appears only for them, confirm declining leaves their seat
  visibly reserved and excludes them from the next deal's blinds/cards, confirm "Buy-in" works
  later (not just immediately after busting) and resumes them next hand.

- [x] **Step 7 — Leave Lobby / rejoin / open seating mid-match.** This is the architectural
  piece from the top of this doc. Server: `aiofLeaveTable` handler — call `leaveSeat` (which
  itself calls `applyDecision(..., 'FOLD')` first if the leaver's decision is currently pending
  or hasn't happened yet this hand), broadcast the freed seat to everyone still at the table.
  `enterAllInOrFold` handler — no seat side effects, just returns the current
  `aiofStatePayload`. Confirm `aiofSitSeat` already allows a **brand-new player** (never in
  `aiofEverSeated`) to take any open seat mid-`'playing'` phase, dealt into the very next
  `dealNextHand` call automatically (should already fall out of Step 3's implementation — this
  step is really about verifying it, plus wiring the leave/rejoin round trip). Client: wire the
  "Leave Lobby" button (available any time on the table screen, for every player including the
  host) to `aiofLeaveTable`, then locally set `aiofAtTable = false` and `showScreen('lobby')` —
  no server-pushed screen change. Confirm the dual-entry tile logic from Step 2 correctly routes
  a since-left player back in via `enterAllInOrFold`, landing them on the seat-picker with a
  **new** empty seat choice (their old seat is gone) but their **preserved** `aiofStacks`/
  `aiofBuyIns` from before they left. **Verify, with 3+ tabs:** Player A leaves mid-match via
  "Leave Lobby" while it's *not* their turn — confirm their seat instantly opens and everyone
  else's table updates. Have Player C (a brand-new joiner who was never in this match) sit into
  that now-open seat and get dealt into the very next hand. Have Player A tap "All-In or Fold"
  again from the lobby, confirm they see the "Rejoin" tile behavior, land back at an open seat
  (a different one, since C took A's old seat) with their exact prior stack. Separately, test
  leaving while it *is* your turn — confirm it auto-folds you and the hand continues without
  hanging.

- [x] **Step 8 — Dealer rotation, auto-advancing hands, waiting-for-players.** Confirm/implement
  `nextSeatClockwise` is actually used in `dealNextHand` to advance `aiofDealerSeat` every hand
  (not just set once at Start), skipping empty and sitting-out seats. Implement the heads-up
  exception (exactly 2 active seats: dealer posts SB). Implement auto-advance: `finishHand`
  schedules the next `dealNextHand` call after a short pause (a few seconds, showing
  `aiofResults`) rather than waiting for any host action, **unless**
  `activeSeatIndexes(room).length < AIOF_MIN_PLAYERS`, in which case set `aiofHand = null` and
  show a "Waiting for players" state instead of scheduling anything — re-trigger `dealNextHand`
  the moment `aiofSitSeat` or `aiofBuyIn` brings the active count back up to
  `AIOF_MIN_PLAYERS`. **Verify:** play several consecutive hands and confirm the dealer button
  visibly moves one seat clockwise each time, skipping any empty/sitting-out seats; drop the
  active count below 2 (have players leave/bust-and-decline) and confirm the table shows
  "Waiting for players" and does not deal; bring it back to 2 and confirm dealing resumes
  automatically without any button press. Also confirm hands auto-advance without a host click
  in the normal case.

- [x] **Step 9 — End Game, ranking table, scoreboard integration.** Server: `endAllInOrFoldGame`
  handler (host-only, reject if `room.aiofHand != null`) — computes `computeNetProfit` for every
  name in `aiofEverSeated`, calls `awardAiofScoreboard` (standard competition ranking, ties share
  rank/points), sets `phase = 'gameover'`. `aiofStatePayload` now includes the ranking table
  (name, final stack, net profit, scoreboard points awarded) when `phase === 'gameover'`. Client:
  ranking screen listing every player who ever sat this match (including ones no longer present),
  sorted by net profit descending, with a **per-player "Leave Lobby" button** available to
  everyone still viewing this screen (same `aiofLeaveTable` → local navigation as Step 7, not a
  new event). **Verify:** run a match with a mix of outcomes (someone who busted and rebought,
  someone who never busted, someone who left mid-match and never returned) through to End Game —
  confirm the ranking table includes the departed player with their last-known numbers, confirm
  net profit math matches `stack - 150 * buyIns` for each row, confirm scoreboard points follow
  standard competition ranking with ties, confirm each remaining viewer can leave independently
  without affecting who else still sees the ranking screen.

- [x] **Step 10 — Disconnect handling & restart resilience.** Server: `onDisconnect` calls the
  same `leaveSeat` used by `aiofLeaveTable` (per the architecture note, a real disconnect is
  handled identically to a voluntary leave) — auto-fold if pending, free the seat, broadcast.
  Confirm host handoff (already generic, handled by `lobby.js`) works unchanged when the host
  disconnects mid-match. `repairOnLoad`: if `room.game === 'allinorfold'` and `room.aiofHand` is
  non-null on load (a restart caught a hand mid-flight), clear it to `null` and fall back to the
  "waiting for players" / auto-deal path — do not try to resume mid-hand state. Confirm
  `reconnectPayload`'s `{ ok: true, atLobby: true }` (from Step 2) means a reconnecting player's
  client lands on the shared lobby with the tile in "Rejoin" mode, exactly like a voluntary
  leave — **not** back at their old seat (which was already freed by `onDisconnect` the moment
  they dropped). **Verify:** disconnect a seated player mid-decision (close their tab), confirm
  their seat frees and the hand continues; reconnect under the same name and confirm they land on
  the lobby screen (not the table) with "Rejoin All-In or Fold" available, and that tapping it
  drops them at a fresh open seat with their preserved stack; restart the dev server mid-hand and
  confirm the room reloads into a clean "waiting for next hand" state with seats/stacks intact.

- [x] **Step 11 — Visual polish + full regression.** Style `aiof-*` elements in `style.css` to
  match the app's poker-table aesthetic (reuse the Menifot/Codenames restyle as the reference —
  seat layout, card faces, chip/pot displays). Confirm the existing global click-sound/haptics
  listener in `main.js` covers all new buttons (generic `document.addEventListener('click', ...)`
  on any `<button>` — should be automatic, just verify no dead zones, especially the seat-tap
  targets). Final full regression: play all seven games back-to-back in one sitting per
  `CLAUDE.md`'s testing convention, plus one disconnect/reconnect for All-In or Fold specifically
  since it's the newest and most likely to have missed an edge case.

## Testing notes

No automated suite exists (per `CLAUDE.md`); this plan leans on the same manual-QA convention
every other game in this repo uses. Functions worth keeping test-friendly even without a runner
yet, per `refactor_plan.md` §8's own reasoning ("cheapest to unit test, highest value since
they're the easiest to silently break during a copy-paste move"):

- `buildSidePots` — no `room`/`ctx`/socket dependency, pure logic with sharp edge cases (3+
  distinct all-in tiers, folded dead money, a tie at the shortest stack).
- `pokerEval.bestOmahaHand` / `rankBoard` — already trusted via Menifot; Step 1 doesn't change
  their behavior, only their file location.
- `computeNetProfit` / `awardAiofScoreboard`'s ranking/tie math — same shape as
  `awardMenifotScoreboard`, already a pattern this repo trusts.

## Out of scope

Everything already listed in `../specs/all-in-or-fold-specs.md`'s own "Explicitly out of scope
(v1)" section applies here unchanged — this plan doesn't add scope beyond that spec, only
sequences building it.
