# All-In or Fold — Specs

A same-room cash-game-style poker variant, seventh game in this app. Players sit at a
6-seat virtual poker table and play hand after hand of a stripped-down Omaha: no betting
rounds, no calling or raising — on your turn you either shove your entire stack (**ALL-IN**)
or **FOLD**. Real chip stakes with free rebuys, real side pots, staged flop/turn/river
reveal. The host ends the session whenever they like; final standings (stack and net
profit/loss per player) convert to `room.scoreboard` points the same way every other game
here does.

## Relationship to existing games / shared app changes

- New option on the "Choose a game" screen: `room.game = 'allinorfold'`.
- Reuses the shared lobby, host concept (first joiner, reassigned on disconnect —
  including the voluntary "Leave Lobby" case, see below), room-code model, and the shared
  per-room `room.scoreboard` (`scoreboard-specs.md`).
- **Deviates from every other game's mid-game-join rule.** Imposter/Codenames/10
  Seconds/Menifot all block new joiners once the room leaves the shared lobby phase. AIOF
  does not: a player who joins the room (or returns from having left) while a match is
  already running can sit down in any open seat and is dealt into the very next hand. This
  is intentional — a poker table has open seating, not a frozen roster.
- Hand evaluation reuses the same "exactly 2 hole cards + exactly 3 board cards" Omaha rule
  Menifot already implements. The reusable pieces of `server/games/menifot-eval.js`
  (`buildDeck`, `combinations`, `bestOmahaHand`, `rankBoard`) are extracted into a new
  shared module, `server/games/pokerEval.js`, required by both `menifot.js` and the new
  `allInOrFold.js`. No behavior change to Menifot; this is a pure extraction.

## Configurable constants

| Constant | Value | Meaning |
|---|---|---|
| `AIOF_MIN_PLAYERS` | 2 | Seats occupied needed to deal a hand |
| `AIOF_MAX_SEATS` | 6 | Fixed number of seats at the table |
| `AIOF_STARTING_STACK` | 150 | Chips granted on initial buy-in and every rebuy |
| `AIOF_SMALL_BLIND` | 5 | |
| `AIOF_BIG_BLIND` | 10 | |
| `AIOF_REVEAL_STAGE_DELAY_MS` | 1500 | Pause between flop → turn → river → showdown |

## Table & seating

- Choosing this game takes every room member to a poker-table screen with **6 fixed
  seats** arranged around a standard oval, numbered clockwise.
- Before the host starts the match, any player can sit in any open seat, or move between
  open seats, freely.
- **Host clicks "Start"** once ≥ `AIOF_MIN_PLAYERS` seats are occupied. This begins the
  match and fixes nothing permanently — unlike Menifot, seating is never frozen; it stays
  fluid for the whole match (see "Open seating during a match" below).
- **The host's seat is the first dealer button position.** Blinds and action order for the
  very first hand are computed from there (see "Dealer & blind rounds" below).

### Open seating during a match

- A player who joins the room after Start, or who returns after clicking "Leave Lobby,"
  can sit in **any currently-open seat** at any time.
- They are dealt into the **very next hand** — no "wait for the big blind" rule. If their
  seat happens to be the dealer/SB/BB for that next hand, they take that role like anyone
  else.
- If fewer than `AIOF_MIN_PLAYERS` seats are occupied between hands, the table shows a
  **"Waiting for players"** state — no hand deals until a second seat fills. The host's
  "End Game" button (see below) remains available in this state.

## Dealer & blind rotation

- Seats are numbered clockwise. The dealer button starts at the host's seat for hand 1,
  then **moves to the next occupied seat clockwise every hand** — standard poker rule,
  matching the original spec's "blinds rotate clockwise."
- Small blind and big blind are the two occupied seats immediately clockwise of the
  dealer. **Heads-up (exactly 2 occupied seats): the dealer posts the small blind**, the
  other seat posts the big blind (standard poker heads-up exception).
- A seat that's empty, or occupied by a **sitting-out** player (busted, declined rebuy —
  see below), is skipped entirely for dealer/blind/action purposes, as if it weren't
  there.

## Dealing

- Standard 52-card deck, freshly shuffled every hand.
- Each occupied (non-sitting-out) seat is dealt **6 private hole cards**.
- **5 community board cards** are dealt face-down, revealed in stages at showdown (flop 3
  / turn 1 / river 1).
- No burn-card math is needed (unlike Menifot): even at the max of 6 players, 6×6 + 5 = 41
  cards are used out of 52.

## The decision phase

1. Blinds are posted first (see short-stack exception below), then the hand moves into
   the decision phase.
2. Starting from the seat immediately clockwise of the big blind, and proceeding clockwise
   around all occupied non-folded seats, **each player gets exactly one decision**:
   **ALL-IN** (shove their entire remaining stack, stay in) or **FOLD** (forfeit anything
   already posted, exit the hand). No call, raise, or check exists.
3. **The small blind and big blind also get this same decision**, acting last in the
   order (SB then BB) — posting the blind is a forced ante paid before decisions start,
   not a substitute for their own turn. Folding after posting a blind forfeits only the
   blind amount already posted.
4. **Untimed.** There is no decision clock; the game waits as long as it takes for the
   current player to act. (Matches Menifot's untimed allocation phase.)
5. **Short-stacked blind exception:** if a player's stack is smaller than the blind they
   owe, they post all of it as an under-funded blind. This automatically **is** their one
   decision for the hand (an implicit ALL-IN for that reduced amount) — they are not
   separately prompted afterward. A stack can never be exactly 0 going into blind-posting
   (see rebuy rule below), so the shortfall is always a positive amount smaller than the
   blind.
6. **Uncontested fold-out:** the instant only one non-folded player remains — even if it's
   not yet their turn to act — the hand ends immediately. That player is awarded the full
   pot (main pot plus any side pots, all of which collapse to them) with no reveal of
   anyone's hole cards, and is never prompted for a decision.

## Side pots

No simplification here — full side-pot math, since stacks diverge over many hands via
wins/losses/rebuys:

1. Every **folded** player's contribution (their posted blind, if any — folders never
   contribute anything beyond a blind) becomes **dead money**: added to the pot, but the
   folder is never eligible to win any of it back.
2. Take the distinct all-in amounts among still-live (non-folded) players and sort them
   ascending. Build pot layers between thresholds:
   - **Main pot** = every live player's contribution up to the *smallest* all-in amount,
     × the number of contributors at that level, **plus all dead money**. Eligible:
     every ALL-IN player, including the shortest stack.
   - **Side pot 1** = the next slice, from the smallest all-in amount up to the
     second-smallest, contributed only by players who put in at least that much.
     Eligible: only players who reached that tier.
   - Repeat for each further distinct all-in level (up to 5 layers with 6 players).
3. Each layer is awarded **independently** via its own best-hand-wins-with-splits
   showdown among only the players eligible for that layer.
4. Worked example: A shoves 100, B and C shove 150 (no folds). Main pot = 300 (100×3),
   eligible A/B/C. Side pot = 100 ((150−100)×2), eligible B/C only. If A wins the
   showdown outright, A takes the 300 main pot only; B and C resolve the 100 side pot
   between themselves regardless of A's hand.

## Showdown & reveal

- Once every live player has acted (or the hand ended by uncontested fold-out, in which
  case skip straight to payout), reveal proceeds in **stages**, auto-advancing with no
  decision in between (`AIOF_REVEAL_STAGE_DELAY_MS` between each):
  1. Flop (3 board cards)
  2. Turn (1 card)
  3. River (1 card)
  4. All ALL-IN players' hole cards are revealed simultaneously; winner(s) per pot layer
     are computed and shown.
- **Folded players' hole cards are never revealed** (mucked), consistent with real poker.
  Folded (but not sitting-out) players still watch the staged reveal along with everyone
  else.
- Each pot layer's winner uses the shared Omaha rule: best 5-card hand from **exactly 2**
  of the player's hole cards + **exactly 3** of the board's 5 community cards. Ties split
  the layer's full pot among all tied winners (no proportional division, no suit/seat
  tiebreak) — same rule Menifot already uses.

## Busting & rebuy

- A stack is checked for 0 **immediately after that hand's payouts settle** — no player
  ever starts a hand already at exactly 0.
- On hitting 0, that player sees a **"Buy-in" button** (a "Rebuy for `AIOF_STARTING_STACK`
  chips?" prompt). Their seat stays occupied and reserved for them the whole time they're
  deciding / sitting out — no one else can take it.
  - **Accept** → stack resets to `AIOF_STARTING_STACK`, they resume play in their same
    seat starting the next hand, blind rotation includes them again. This buy-in counts
    toward their total buy-in count for net-profit purposes (see scoreboard section).
  - **Decline** → they **sit out**: still occupying their seat (visibly theirs, shown as
    sitting out), but skipped entirely for dealing/blinds/action until they either click
    "Buy-in" later (any time) or click "Leave Lobby" (which frees the seat — see below).

## Leave Lobby / rejoining

- **Every player, including the host, has a "Leave Lobby" button available at any time**
  during an active match (not just at game-end).
- Clicking it is a **per-player** action — it sends only that player back to the shared
  room lobby screen. It does not affect anyone else's game.
- If it's clicked while a hand is in progress and that player hasn't acted yet (or it's
  currently their decision), they are **auto-folded** for that hand, exactly as a
  disconnect mid-decision would require.
- **Their seat immediately becomes open** for anyone (a different player, or the same
  player later) to sit in — unlike sitting-out-after-busting, "Leave Lobby" does **not**
  reserve the seat.
- Their **stack and buy-in count are preserved**, keyed to their player name, independent
  of seat. If they later choose this game again from the shared lobby **while the same
  match is still running**, they pick any open seat and resume with the exact stack and
  buy-in count they had when they left, and are dealt into the next hand immediately
  (same as any other open-seating join).
- If they return **after** the host has already ended that match and started a new one,
  they join the *new* match fresh at `AIOF_STARTING_STACK`, counted as one buy-in — their
  old match's numbers were already finalized into the ranking/scoreboard when that match
  ended.
- **Host leaving via "Leave Lobby" triggers the same host-handoff this app already does on
  a real disconnect** — host status passes to another connected/seated player. This is
  treated as the voluntary equivalent of a disconnect throughout, not a separate system.

## Hand pacing

- **Auto-advancing, no host gate between hands** — unlike Menifot's host-gated rounds.
  As soon as a hand resolves (pot(s) awarded, results briefly shown) and ≥
  `AIOF_MIN_PLAYERS` seats are occupied (by non-sitting-out players), the next hand deals
  automatically after a short pause.
- If occupied count drops below `AIOF_MIN_PLAYERS`, the table shows "Waiting for players"
  instead of dealing, until enough seats fill again.

## Ending the match & scoreboard integration

- **Host-only "End Game" button**, available **only between hands** (never mid-hand: not
  while blinds are posted, decisions are pending, or a showdown/reveal is unresolved).
- There is no fixed win condition (no race-to-N like Menifot) — this runs as an indefinite
  cash game until the host ends it.
- Clicking "End Game" produces a **ranking table** covering **every player who was ever
  seated at any point during this match**, including anyone who left via "Leave Lobby"
  and never returned — each row shows:
  - **Final stack** (last-known stack: current stack if still seated/sitting-out, or the
    stack they had when they left, for anyone gone).
  - **Net profit/loss** = final stack − (`AIOF_STARTING_STACK` × their total buy-in
    count for this match, including the initial buy-in). E.g., a player who busted and
    rebought twice then ends with 150 shows **−300** (put in 450 total, has 150); a
    player who never busted and still has 150 shows **0**.
- **Scoreboard points**: standard competition ranking by net profit/loss, descending.
  `N` = total distinct players who were ever seated this match. 1st gets `N` points, 2nd
  gets `N-1`, etc. Ties (identical net profit) share rank and points; the next distinct
  rank skips accordingly (matches Menifot's tie rule). Points are added to
  `room.scoreboard[name]`.
- The ranking screen replaces the table view for everyone still present. **Every
  player, including the host, has a "Leave Lobby" button here** — clicking it sends just
  that player back to the shared lobby; the screen keeps showing for whoever else is
  still on it.

## Server state additions (`room.aiof*`)

- `room.aiofSeats`: array of length `AIOF_MAX_SEATS`, each slot `null` or a player name.
- `room.aiofStacks`: name → current chip stack.
- `room.aiofBuyIns`: name → total buy-in count this match (starts at 1 on first sit-down,
  +1 each rebuy).
- `room.aiofSittingOut`: set/map of names currently sitting out (busted, declined rebuy).
- `room.aiofDealerSeat`: current dealer seat index, advanced each hand.
- `room.aiofEverSeated`: set of every name that has ever occupied a seat this match — used
  to build the final ranking table even for players no longer present.
- `room.aiofHand`: current in-progress hand state (board cards, hole cards, pot layers,
  action order/position, decisions so far) — **not persisted** across a server restart;
  on reload, any in-flight hand is discarded and the table resumes at "waiting for next
  hand" using the persisted stacks/seats/dealer position.
- `room.aiofResults` (optional): last hand's outcome, for a brief between-hands summary
  before the next hand auto-deals.

`ROOM_SAVED_FIELDS` includes `aiofSeats`, `aiofStacks`, `aiofBuyIns`, `aiofSittingOut`,
`aiofDealerSeat`, `aiofEverSeated` — enough to resume a match cleanly after a restart.
`aiofHand` is deliberately excluded (same simplification Menifot uses for in-flight
allocation state).

## Disconnect handling

A real (involuntary) disconnect is handled identically to a voluntary "Leave Lobby" click
for game-state purposes — auto-fold if mid-decision, stack/buy-in-count preserved by
name, seat freed immediately for anyone else to take, host handoff if the host
disconnects. The only difference is that a disconnect doesn't navigate the player
anywhere (there's nothing to navigate); reconnecting under the same name and choosing this
game again is equivalent to clicking through from "Leave Lobby."

## Explicitly out of scope (v1)

- No decision timer — the ALL-IN/FOLD prompt is untimed.
- No "wait for the big blind" protection for players who sit down mid-match — they're
  dealt in immediately.
- No reserved seats for players who explicitly "Leave Lobby" (only busted/sitting-out
  players keep their seat reserved).
- No sudden-death or fixed win condition — the host alone decides when the match ends.
- No anti-cheat beyond what this app already trusts elsewhere — server owns the shuffle,
  deal, blind posting, and hand evaluation.
