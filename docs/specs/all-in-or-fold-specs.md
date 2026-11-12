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
| `AIOF_STARTING_STACK` | 150 | Default buy-in amount pre-selected on the slider; also the fixed amount used for mid-match open-seating joins, which skip the slider entirely |
| `AIOF_MIN_BUYIN` | 150 | Minimum selectable buy-in/rebuy amount |
| `AIOF_MAX_BUYIN` | 2000 | Maximum selectable buy-in/rebuy amount |
| `AIOF_BUYIN_STEP` | 50 | Increment of the buy-in/rebuy slider |
| `AIOF_SMALL_BLIND` | 5 | |
| `AIOF_BIG_BLIND` | 10 | |
| `AIOF_REVEAL_STAGE_DELAY_MS` | 1500 | Pause between each reveal stage (hole cards → flop → turn → river → showdown) |
| `AIOF_EQUITY_SAMPLE_SIZE` | 20 | Monte Carlo trial count for the pre-flop and flop win-probability estimates (see below — benchmarked against the actual hand-evaluator cost, not a round guess) |

## Table & seating

- Choosing this game takes every room member to a poker-table screen with **6 fixed
  seats** arranged around a standard oval, numbered clockwise.
- Before the host starts the match, any player can sit in any open seat, or move between
  open seats, freely.
- Sitting in a seat during this pre-Start phase opens a **buy-in slider**
  (`AIOF_MIN_BUYIN`–`AIOF_MAX_BUYIN`, steps of `AIOF_BUYIN_STEP`, defaulting to
  `AIOF_STARTING_STACK`). A seated player can reopen and change it as many times as they
  like until the host clicks Start, at which point each player's last-set value locks in as
  their starting stack for the match.
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
- A player sitting down **after** Start has already been clicked always buys in at the
  fixed `AIOF_STARTING_STACK` amount — no slider, no wait — preserving the "dealt into the
  very next hand" guarantee above. The selectable buy-in slider only applies pre-Start (see
  "Table & seating") and at rebuy time (see "Busting & rebuy" below).
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
  case skip straight to payout with no reveal at all), reveal proceeds in **stages**,
  auto-advancing with no decision in between (`AIOF_REVEAL_STAGE_DELAY_MS` between each):
  1. **Hole cards** — every live (non-folded) player's full 6 hole cards flip face-up
     simultaneously, visible to everyone at the table. (Previously hole cards were only
     shown at final showdown, and only the 2-of-6 actually used in the winning hand — this
     stage exposes each live player's whole hand, up front, before any board card shows.)
  2. Flop (3 board cards)
  3. Turn (1 card)
  4. River (1 card)
  5. Winner(s) per pot layer are computed and shown; the 2-of-6 hole cards each player
     actually used are highlighted against the already-visible full hand.
- **Folded players' hole cards are never revealed** (mucked), consistent with real poker.
  Folded (but not sitting-out) players still watch the staged reveal along with everyone
  else.
- Each pot layer's winner uses the shared Omaha rule: best 5-card hand from **exactly 2**
  of the player's hole cards + **exactly 3** of the board's 5 community cards. Ties split
  the layer's full pot among all tied winners (no proportional division, no suit/seat
  tiebreak) — same rule Menifot already uses.

## Win-probability (equity) display

- Once hole cards are revealed (see above), every live player's approximate chance of
  winning (or splitting) the showdown is computed and shown next to their seat,
  recalculated at each subsequent stage:
  1. **Pre-flop** (right after the hole-card reveal, no board yet) and **post-flop** —
     both estimated via Monte Carlo: `AIOF_EQUITY_SAMPLE_SIZE` random board completions
     (5 cards pre-flop, 2 post-flop) are sampled from the undealt deck; each live player's
     win/tie share across those samples gives their percentage. Benchmarking the actual
     hand evaluator showed the true completion count is too large to enumerate exactly at
     *any* table size without risking a multi-second server-wide stall — sampling is used
     at both stages, not just pre-flop.
  2. **Post-turn** — recomputed exactly over the remaining possible river cards. This
     stays cheap regardless of table size (at most ~37 possibilities, comfortably under
     `AIOF_EQUITY_SAMPLE_SIZE`'s exact-vs-sample threshold), so turn equity is always
     exact.
  3. **River** — deterministic: the hand is now fully known, so winner(s) show 100% (split
     evenly among tied winners) and everyone else shows 0%.
- The same `AIOF_EQUITY_SAMPLE_SIZE` random-completion machinery decides exact-vs-sampled
  generically: if the true number of possible completions is ≤ `AIOF_EQUITY_SAMPLE_SIZE`,
  every one of them is enumerated (exact); otherwise that many are randomly sampled
  instead. This is why turn/river always land on exact and pre-flop/flop always land on
  sampled, without stage-specific logic.
- Equity is a **single number per live player** — their overall probability of winning or
  splitting the showdown against the other live hands — deliberately ignoring side-pot
  eligibility differences. A player only eligible for a side pot still gets one overall
  percentage, not a separate one per pot layer.
- Folded and sitting-out players show no percentage.
- Purely informational/spectator flavor — it never affects dealing, decisions, or payouts,
  which remain governed entirely by actual cards once the river is dealt. Computed once per
  stage transition and cached on the hand (not recomputed per viewer), since the number is
  identical for everyone watching.

## Chip stack visuals

- Each seat shows a small stylized chip stack next to the player's name, alongside the
  exact numeric stack value as text. The stack is **not** an exact chip-denomination
  breakdown — it's a simplified tiered visual: both its color and its height (number of
  chip discs drawn) change at fixed value thresholds, so a bigger stack visibly looks
  bigger and a different color without representing literal chip counts.
- The pot (center of table) gets the identical tiered chip-stack treatment, sized/colored
  by the current pot total, and updates live as each player's decision adds to it — the
  same moment the existing pot-total text updates, not just at showdown.

## Live net profit/loss display

- Every occupied seat shows a small colored badge — green `+N` if currently ahead, red
  `-N` if currently behind — for what that player's net would be if the match ended and the
  scoreboard were finalized right now. It uses the exact same formula as the final ranking
  (current stack − total bought in this match, see "Ending the match" below), so it updates
  immediately after every hand, and mid-hand too, since a shoved stack is deducted from
  `aiofStacks` immediately on the ALL-IN decision.
- Visible for every player at the table, not just the viewer's own — consistent with hole
  cards already being fully visible during a hand (see above).
- During an active hand's reveal stages (hole cards → flop → turn → river), this badge is
  temporarily replaced at that seat by the win-probability percentage (see above) so the
  seat doesn't show two numbers at once; it reappears between hands.

## Busting & rebuy

- A stack is checked for 0 **immediately after that hand's payouts settle** — no player
  ever starts a hand already at exactly 0.
- On hitting 0, that player sees a **"Buy-in" button** that opens the same buy-in slider
  used at initial sit-down (`AIOF_MIN_BUYIN`–`AIOF_MAX_BUYIN`, steps of `AIOF_BUYIN_STEP`,
  defaulting to `AIOF_STARTING_STACK`). Their seat stays occupied and reserved for them the
  whole time they're deciding / sitting out — no one else can take it.
  - **Accept** → confirming the slider resets their stack to the chosen amount, they resume
    play in their same seat starting the next hand, blind rotation includes them again.
    This rebuy amount is added to their total buy-in for net-profit purposes (see
    scoreboard section) — each rebuy can be a different amount.
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
- Their **stack and total bought in are preserved**, keyed to their player name,
  independent of seat. If they later choose this game again from the shared lobby **while
  the same match is still running**, they pick any open seat and resume with the exact
  stack and total bought in they had when they left, and are dealt into the next hand
  immediately (same as any other open-seating join).
- If they return **after** the host has already ended that match and started a new one,
  they join the *new* match fresh, picking a buy-in amount the same way any other initial
  sit-down does (defaulting to `AIOF_STARTING_STACK`), counted toward their total buy-in
  for that new match — their old match's numbers were already finalized into the
  ranking/scoreboard when that match ended.
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
  - **Total bought in** = sum of every buy-in amount this player ever chose this match (the
    initial sit-down amount, plus each rebuy amount — each can differ now that amounts are
    selectable).
  - **Net profit/loss** = final stack − total bought in. E.g., a player who buys in for
    150, busts, rebuys for 500, and ends with 200 shows **−450** (put in 650 total, has
    200); a player who buys in for 300 and never busts, ending with 300, shows **0**.
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
- `room.aiofBuyIns`: name → total chips bought in this match (sum of the initial buy-in
  amount and every rebuy amount chosen; each can be a different value between
  `AIOF_MIN_BUYIN` and `AIOF_MAX_BUYIN`).
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
for game-state purposes — auto-fold if mid-decision, stack/total-bought-in preserved by
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
- No *exact* pre-flop or flop win-probability — both are Monte Carlo estimates
  (`AIOF_EQUITY_SAMPLE_SIZE` samples), not full enumeration, to keep the single-process
  server from a multi-second stall on a multi-way all-in (see "Win-probability (equity)
  display"). Even sampled, this is a real, repeating cost (paid on every contested hand,
  not a rare corner case) — `AIOF_EQUITY_SAMPLE_SIZE` was set low (20) specifically to keep
  the worst case (6 live players) to a sub-half-second one-time stall.
- No per-side-pot win-probability breakdown — equity is always one overall number per
  player, even when side pots would make the true per-pot odds diverge.
