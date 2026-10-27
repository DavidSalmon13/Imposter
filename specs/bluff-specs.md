# Bluff — Specs

A same-room card-count tracker for an in-person bluffing card game, eighth game in this app.
Players are dealt real cards privately to their own phone (visible only to them); the actual
bluffing/calling-out gameplay is entirely verbal, played by the group in real life, with no
rules or decisions simulated by the app. The app's job is purely: shuffle and deal, show a
circular "round table" of everyone's remaining card count, and let the host — who alone
decides each round's loser based on what happened in real life — advance the match until one
player remains.

## Relationship to existing games / shared app changes

- New option on the "Choose a game" screen: `room.game = 'bluff'`, tile id
  `choose-bluff-btn`, icon suggestion `🂠`.
- Reuses the shared lobby, host concept, room-code model, and `room.scoreboard`
  (`scoreboard-specs.md`).
- **Frozen roster at Start**, same rule as Menifot: every currently-connected room member
  becomes a player the moment the host clicks "Start Match." No seat-picking, no mid-match
  joining — unlike All-In or Fold's open seating.
- Reuses the existing `buildDeck()` (from `server/games/pokerEval.js`) and `shuffle()` (from
  `server/lib/shuffle.js`) for a real, standard 52-card deck — no new deck-building code.
  Card identity (suit/rank) is real and dealt for real, but **only the owning player ever
  sees their own hand**; it is never shown to anyone else, including the host, and never
  factors into any rule the app enforces.

## Configurable constants

| Constant | Value | Meaning |
|---|---|---|
| `BF_MIN_PLAYERS` | 2 | Connected players needed to start a match |
| `BF_MAX_PLAYERS` | 10 | Max frozen roster size |
| `BF_LOSER_HIGHLIGHT_MS` | 1500 | How long the picked loser stays highlighted before the deal animation starts |
| `BF_DEAL_ANIMATION_MS` | 2200 | Duration of the shuffle/deal animation before the next round's state is usable |
| `BF_CHECK_COUNTDOWN_MS` | 3000 | Countdown everyone sees before a hand check's verdict is revealed |

## Seating phase (`room.phase === 'seating'`)

- Choosing this game takes every room member to a seating screen. Nobody is dealt anything
  yet.
- The host sees a **starting-card-count scroll wheel**, bounded 1 to
  `floor(52 / connectedPlayerCount)`, recalculated live as players join/leave the room before
  Start (same dynamic-bound pattern Menifot uses for `canStart`). Non-host players see the
  currently-selected count, read-only.
- **Host clicks "Start Match"** once `BF_MIN_PLAYERS` ≤ connected count ≤ `BF_MAX_PLAYERS` and
  a starting count has been chosen (defaults to the wheel's max, `floor(52/N)`, if the host
  never touches it).
- Starting Match:
  1. Freezes `room.bfPlayers` = every currently-connected name, in a fixed order (this order
     is also the round-table seat order — see "Round table layout" below).
  2. Sets `room.bfCounts[name] = <chosen count>` for every frozen player.
  3. Resets `room.bfRoundNumber = 0`, `room.bfEliminationOrder = []`.
  4. Immediately deals round 1 (see "Dealing a round" below) — there is no separate
     user-facing "Start New Round" click for round 1; it's folded into Start Match.

## Dealing a round

Dealt whenever a match starts (round 1) and automatically again after every loser pick (see
"Round progression" below) — the same function both times.

1. Build a fresh standard 52-card deck and shuffle it (`buildDeck()` + `shuffle()`).
2. For every player with `bfCounts[name] > 0` (eliminated players are skipped entirely —
   they get no cards), deal exactly `bfCounts[name]` cards off the top of the shuffled deck.
3. **Cards are never dealt evenly across players after round 1** — each player's hand size is
   simply whatever their current persisted count is. The *only* place an even split happens
   is choosing the single starting count at Start Match.
4. Any cards left in the deck once every active player has their hand are simply unused —
   "ignore leftover cards," per the original ask. (Round 1's leftover is `52 - N × startCount`;
   later rounds have even more leftover, since the sum of counts only shrinks over time via
   losses.)
5. `room.bfRoundNumber` increments by 1.
6. Each player's dealt hand is sent to them **privately** — the personalized state broadcast
   includes `myHand` only for the viewer's own cards; no other player's hand ever appears in
   any payload, including the host's.
7. `room.bfLastResult` is cleared (see "Round progression") — this is a fresh round with no
   pending result to show.

## Round table layout (UI)

- Players are arranged in a **circle**, one seat per frozen roster slot, in the fixed order
  captured at Start Match — seat positions are computed once and never reflow for the rest of
  the match (an elimination does not shrink or re-space the circle).
- The table is a tall stadium-shaped felt (fills a portrait phone better than a circle),
  seats spaced around it on an oval, seat 0 at the bottom; the felt's center shows the total
  cards still in play (sum of `bfCounts`).
- Each seat shows:
  - The player's **lobby icon**: their sticker, or the same name-hashed emoji fallback the
    lobby uses. Signed-in players keep the lobby's pulsing **gold ring** — cosmetic only:
    unlike the lobby, tapping it never opens the player card here.
  - A pill under the icon with their current card count (`bfCounts[name]`) and name.
  - A dim "offline" indicator if that player is currently disconnected — cosmetic only; see
    "Disconnects" below for why it never blocks anything.
- **Eliminated players** (`bfCounts[name] === 0`) stay in their seat, visually grayed out,
  labeled eliminated. They are never removed from the circle.
- Below (or alongside) the table, every player — including the host — sees their **own
  private hand**, face-up, as a simple row of cards. This is read-only display; there is no
  drag/drop, no allocation, nothing to interact with on a hand.
- The **host's screen additionally overlays the control panel**: tapping any active (non-
  eliminated) player's icon — signed in or not — opens a brief confirm ("Mark `<name>` as this round's loser?") before
  committing — guards against mis-taps, since this is the single most consequential action in
  the game.

## Round progression (host-controlled)

1. While a round's hands are dealt and no result is pending, the host may tap any **active**
   seat and confirm to mark that player as this round's loser. This is the only player-facing
   decision point in the entire game — there is no call/fold/bluff mechanic simulated here,
   per the original ask; the real bluffing happens verbally among the players and the host is
   simply recording its real-world outcome.
2. On confirmation:
   - `room.bfCounts[name] -= 1`.
   - If the new count is `0`, append `name` to `room.bfEliminationOrder` (eliminated, in
     order — this list is what the final scoreboard ranking is built from).
   - `room.bfLastResult = { loserName, newCount, eliminated }` is broadcast immediately — every
     client highlights that seat for `BF_LOSER_HIGHLIGHT_MS`.
3. **Win check**: if exactly one player now has `bfCounts[name] > 0`, the match ends — see
   "Ending the match" below. No further dealing happens.
4. Otherwise, after the highlight the next round deals **automatically** — no host click
   needed — following a `BF_DEAL_ANIMATION_MS` shuffle/deal animation. The host's only two
   actions in the entire match are **Start Match** (once) and **tap-a-seat-to-pick-the-loser**
   (every round); there is no separate "Start New Round" button after round 1, since picking a
   loser always auto-advances into the next round (or into game-over) on its own.
5. While the highlight/animation window is running, seat-tapping is disabled (there's no
   active round to act on until the next deal lands).

## Elimination / spectating

- The moment a player's count hits `0` (via a normal loss or an edit-counts drop to zero),
  they become a **spectator** for the rest of the match: instead of their own (nonexistent)
  hand, their client shows **every active player's hand**, face-up, each labeled with that
  player's name. There's no bluffing information left for them to exploit once they're out,
  so there's no reason to keep hiding the table from them.
- This is purely a per-viewer rendering choice: `bluffStatePayload` computes it from
  `bfCounts[viewerName] === 0` on each broadcast, so it flips automatically the instant a
  player is eliminated and flips back off if an "Edit card counts" revive brings them back
  above `0` (see "Editing card counts mid-match"). Nothing is persisted for it.
- If a host's edit revives a currently-spectating player with cards, their next state update
  shows their own dealt hand again, like any other active player's.
- The winner at match end is also momentarily the only non-spectator; the gameover screen
  replaces the table view entirely at that point, so this doesn't come up in practice.

## Checking the called cards (host-controlled)

When someone calls a bluff in real life, the host can ask the app whether the cards that were
called are actually there among **every active player's cards pooled together**.

- Available to the host only, while a round is live (hands dealt, no loser picked yet) and no
  other check is counting down. Host taps "Check the called cards" and taps a card value
  (2..A) once per card called, e.g. 7, 7, K. **Suits are ignored** — only values count.
  Repeats count: 7, 7, K needs at least two 7s and one K on the table. At most 4 of a value
  and 20 cards in total.
- On submit, every player sees the called values plus a **3-second countdown**
  (`BF_CHECK_COUNTDOWN_MS`), then the verdict: "It's there!" or "Not there!". The server
  computes the answer only when the countdown ends, and the payload carries `present: null`
  until then, so nobody can peek early.
- The verdict is informational only — the host still taps the round's loser as before
  (seat-tapping is disabled while a countdown runs). The host may check other cards after
  a verdict (e.g. a mis-entry). The check clears when the next round is dealt.
- `room.bfCheck` (`{ id, ranks, label, revealAt, present }`) is **not persisted**, like
  `bfHands`: after a restart the round is re-dealt, so any check is moot.

## Editing card counts mid-match (host-controlled)

A correction tool for when the app's tracked counts drift from reality (a miscounted
hand, a card dropped on the floor, etc.) - not a gameplay mechanic.

- Host taps **"Edit card counts"**, available whenever a round is live (hands dealt,
  no pending loser-pick result, no hand check counting down) - same availability rule
  as picking a round's loser. Unavailable during a check or the highlight/deal-
  animation window.
- This opens a **draft** of every seat's count, starting from their current counts.
  Every connected client sees the draft list live (read-only for everyone but the
  host) with a banner that the host is adjusting counts.
- The host taps **−/+ next to any seat** (including eliminated ones, to revive them)
  to adjust that seat's draft count by one. Bounded at 0, and the draft counts across
  every seat can never together exceed 52 (the deck size).
- **Cancel** discards the draft and returns to the normal round-table view, nothing
  changes.
- **Ready** applies the draft as the new `bfCounts` and immediately deals the next
  round off them (a fresh `dealBluffRound`, round number increments as normal) - unless
  the edit leaves exactly one player with cards, in which case the match ends the same
  way a normal loss would (that lone player wins). At least one player must end up
  with cards, or Ready is rejected.
  - A player the edit brought back above 0 (revived) is removed from the elimination
    order. A player the edit brought down to exactly 0 (manually eliminated) is added
    to the end of it, in seat order - keeping the final ranking consistent with
    whatever the host just set.
- While editing is open, the normal round actions (picking a loser, checking called
  cards) are blocked for the host until Cancel or Ready.

## Ending the match & scoreboard integration

- The lone player with cards remaining is the **winner**.
- Ranking for `room.scoreboard` purposes: winner is rank 1; everyone else is ranked by
  **reverse elimination order** — whoever was eliminated *later* ranks higher than whoever was
  eliminated *earlier*. Because exactly one player is eliminated at a time, this ranking has
  **no ties** — every player gets a distinct rank.
- Standard points: `N` = frozen roster size. Winner gets `N` points, the most-recently
  eliminated player gets `N-1`, and so on down to `1` point for whoever was eliminated first.
  Added to `room.scoreboard[name]` the same way every other game here does.
- The game-over screen shows the full ranking (name, points) plus the usual scoreboard
  totals.

## Reset Game

- Host-only button, available at any point during `'playing'` or `'gameover'`.
- Clears `bfCounts`, `bfRoundNumber`, `bfEliminationOrder`, `bfHands`, `bfLastResult`, and
  returns to `room.phase = 'seating'` — **keeping the same frozen `bfPlayers` roster** — so
  the host can immediately pick a new starting count and start a fresh match with the same
  group without detouring through the shared lobby.

## Disconnects

- Since the only player-facing action in this entire game is the host's seat-tap, a
  disconnect never blocks anything — a disconnected player's seat just shows an "offline"
  dim indicator; they remain fully eligible to be picked as a round's loser (the host is
  adjudicating based on real life, where that player may well still be physically present
  even if their phone dropped).
- If the host disconnects, this app's existing generic host-handoff (already run by
  `lobby.js` before any per-game `onDisconnect`) reassigns host status to another connected
  player — no special handling needed in this game's module.

## Server state additions (`room.bf*`)

- `room.bfPlayers`: frozen roster array, fixed order = round-table seat order.
- `room.bfCounts`: name → current card count (persisted, decremented on loss).
- `room.bfRoundNumber`: current round number (persisted, display-only).
- `room.bfEliminationOrder`: array of names in the order they hit 0 cards (persisted) — used
  to build the final ranking.
- `room.bfHands`: name → array of dealt card objects for the **current** round — **not
  persisted**; purely a live display, regenerated by the next deal.
- `room.bfLastResult`: `{ loserName, newCount, eliminated }` for the brief highlight/animation
  window between a loser pick and the next deal — **not persisted**, cleared the moment the
  next round deals.
- `room.bfEditing`: whether the host currently has the "Edit card counts" draft open —
  **not persisted**; a server restart mid-edit just drops back to normal play.
- `room.bfEditCounts`: name → draft count while `bfEditing` — **not persisted**.

`ROOM_SAVED_FIELDS` includes `bfPlayers`, `bfCounts`, `bfRoundNumber`, `bfEliminationOrder` —
enough to resume a match cleanly after a restart. `bfHands`/`bfLastResult` are deliberately
excluded, matching All-In or Fold's "in-flight hand isn't persisted" simplification — see
"Restart resilience" below for what happens instead.

## Restart resilience

- A server restart drops `bfHands`/`bfLastResult` (not persisted). Nothing meaningful is
  lost: no player ever has a pending decision riding on the current round's dealt cards —
  only the host's next seat-tap matters, and that's still available once the room reloads.
- On load, if `room.game === 'bluff'` and `room.phase === 'playing'`, the room **immediately
  re-deals the current round fresh** (same `bfCounts`, new shuffle) rather than waiting for
  any click — there is no "waiting for players" gate to show, since the roster is frozen and
  doesn't depend on who's currently connected.

## Explicitly out of scope (v1)

- No bluffing/calling-out mechanic of any kind is simulated — that's entirely verbal, among
  the real players, exactly as the original ask requires ("Do NOT implement poker rules or
  gameplay logic," "Do NOT simulate gameplay decisions or turns").
- No per-player actions besides the host's seat-tap — no other player ever submits anything
  to the server during a match.
- No mid-match joining/leaving of the roster (unlike All-In or Fold) — the roster is frozen
  at Start Match and stays fixed for the whole match, including through a Reset Game.
- No seat re-layout on elimination — the circle's shape never changes once a match starts.
- No per-side-pot-style complexity of any kind — there's exactly one shared pool of outcomes
  per round (one loser, decremented by exactly one card).
