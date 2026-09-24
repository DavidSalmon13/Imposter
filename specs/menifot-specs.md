# Menifot — Specs

A same-room card game, fourth game in this app alongside Imposter, Codenames, and 10 Seconds. One 52-card deck is split across 2 or 3 shared community "boards" (each a mini flop/turn/river). Every player secretly splits their own hand across the boards, then everyone's best Omaha-style hand is evaluated per board. Board wins score points; players race across multiple rounds to be first to reach a target score.

## Relationship to Imposter / Codenames / 10 Seconds / shared app changes

- Fourth option on the "Choose a game" screen, using the same `chooseGame` socket event pattern: `room.game = 'menifot'`.
- Reuses the shared lobby, host concept (first joiner, reassigned on disconnect), room-code model, and the shared per-room `room.scoreboard` (see `scoreboard-specs.md`).
- Mid-game joins are blocked the same way as the other three games: once the room leaves the shared lobby phase, new joiners get "Game in progress, wait for the next round."
- "Back to Lobby" returns everyone to the shared lobby / choose-a-game screen, keeping the roster/names intact, clearing only Menifot-specific state — same pattern as the other three games.
- No ChatGPT / external API calls needed — this is deck/card logic only, like 10 Seconds is timer/state logic only.

## Configurable constants

Kept as named constants (matching `MIN_PLAYERS` / `CN_MIN_PLAYERS` / `TS_MIN_PLAYERS` in `server.js`) so the rules can be tuned later without touching game logic:

| Constant | Value | Meaning |
|---|---|---|
| `MF_MIN_PLAYERS` | 2 | Floor to start a match |
| `MF_MAX_PLAYERS` | 8 | Ceiling — see "why 8" below |
| `MF_THREE_BOARD_MAX_PLAYERS` | 3 | Players ≤ this → 3 boards; above it → 2 boards |
| `MF_TARGET_SCORE` | 10 | First to reach this cumulative round-score wins the match |

**Why the 8-player cap is load-bearing, not just a nicety:** hand evaluation requires *exactly* 2 of the player's own cards per board (see "Hand evaluation" below). At 8 players in 2-board mode, the worst case is 2 cards/board/player — the minimum the rule can work with. Raising `MF_MAX_PLAYERS` above 8 without also revisiting board math could produce a player with fewer than 2 cards on some board, which breaks hand evaluation. Don't raise this constant in isolation.

## Board setup

Each board always has:
- 3 face-up flop cards (visible to everyone from the start of each round)
- 1 hidden turn card
- 1 hidden river card

Board count is **determined once per match**, not per round: `boardCount = playerCount <= MF_THREE_BOARD_MAX_PLAYERS ? 3 : 2`, computed from the roster present when the host presses Start, and then frozen for the entire match (see "Match-level state is frozen at Start" below).

## Card dealing & the burn rule

The naive math doesn't divide evenly for realistic table sizes — 3-board mode leaves 37 cards (52 − 15), which is *prime*, so only 1 or 37 players divide it evenly; 2-board mode leaves 42 cards (52 − 10), whose only divisors in a normal range are 6, 7, 14, 21. Rather than block most player counts, unevenness is resolved by **burning cards**, each round:

1. Shuffle the full 52-card deck.
2. Deal the board cards (flop/turn/river for each board — 15 cards for 3 boards, 10 for 2 boards).
3. Compute `remaining = 52 - boardCards`, then `burnCount = remaining % playerCount`.
4. Burn `burnCount` cards off the top of the remaining deck — set aside, unseen, not dealt to anyone, not part of any board.
5. Deal the rest evenly: `(remaining - burnCount) / playerCount` cards to each player.

Burned cards are **revealed at that round's reveal phase**, alongside the turn/river reveal (not held back to match end) — it's already the "everything hidden becomes visible" moment, so folding burn cards into it keeps the reveal coherent instead of stacking up a pile of unexplained cards across many rounds.

## Per-player board allocation

Each player must assign every one of their dealt cards to a board, with the count per board **differing by at most 1 card** across that player's boards (e.g., 13 cards / 3 boards → 4/4/5, never 3/4/6). Given the burn rule above, every player always has the *same* total card count each round, so this remainder pattern is identical for everyone in a given round.

**The player chooses which board(s) get the extra card** — the server only enforces `max(perBoardCounts) - min(perBoardCounts) <= 1` for that player; it doesn't dictate which specific board is "the big one." This is one more strategic lever (e.g. stack the extra card on the board with your strongest flop fit).

Which *specific* cards go to which board is, of course, always the player's free choice (that's the whole strategic point, per your original section 5) — the even-split rule only constrains *counts* per board, never which cards.

### Allocation UI

Tap-to-select, tap-to-assign — matches this app's existing tap-based interaction (used in Codenames), not drag-and-drop: tap a card in your hand to select it, then tap a board to move it there (tap again / tap "unassign" to pull it back). The UI should proactively disallow taps that would violate the ±1 rule (e.g. a board already at its max allowed count for that player just doesn't accept another card) rather than allowing an invalid state and only catching it at Lock time.

## Locking

Same as your original spec: once a player locks, their allocation is stored server-side and immutable — no more moves, even if they change their mind, even if they briefly disconnect and reconnect before reveal (see disconnect handling below, locks are never reversible once set, manual or automatic). The round's reveal only begins once **every player in the match roster has a locked allocation** (manual or auto-locked, see below).

The reveal is **automatic** — nobody taps cards. As soon as the last lock lands, the server flips every board's turn together, then every board's river, then shows the round results, pausing `MF_REVEAL_STAGE_DELAY_MS` (2s) between steps — the same timed-reveal pacing All In or Fold uses for its showdown.

## Hand evaluation — Omaha-style, not "best 5 of everything"

This is the one place this spec **overrides** the literal wording of your original section 7 ("best possible 5-card hand from all available cards"). The actual rule, confirmed during design: for every board, a player's hand is always built from **exactly 2 of their own cards allocated to that board + exactly 3 of that board's 5 community cards** — never more, never fewer from either side, regardless of how many cards the player has on that board (could be as few as 2, as many as ~6 depending on player/board count).

Algorithm per player per board:
1. Enumerate every 2-card combination from the player's cards on that board (`C(k, 2)` where `k` = their card count on that board).
2. Enumerate every 3-card combination from the board's 5 community cards (`C(5, 3) = 10`, fixed regardless of anything else).
3. For each of the `C(k,2) × 10` combined 5-card hands, score it with a standard poker hand evaluator.
4. The player's best hand for that board is the max-scoring combination.

Worst-case combo count across the whole approved player range (2–8 players) is small (e.g. `C(6,2) × 10 = 150` at most) — brute-forcing every combination is trivial, no optimization needed.

**Use an established npm library** (e.g. `pokersolver`) for the core "rank + compare a single 5-card hand" logic — hand ranking, kickers, and tie edge cases (wheel straights, straight-flush vs. quads, etc.) are easy to get subtly wrong by hand, and this project already depends on several npm packages server-side. Write a thin custom adapter around it for: (a) generating the 2-from-hand × 3-from-board combinations described above, and (b) comparing/ranking players within a board using the library's per-hand scores.

## Determining board winners (with splits)

For each board: evaluate every player's best hand (per above), then rank them with the library's comparator. If two or more players have a **literal tie** (same category, same ranks, same kickers — not just "close"), the board **splits**: every tied player is credited with winning that board, full stop. No suit-based or seat-based tiebreak is applied — poker convention treats a true tie as a genuine split.

## Round scoring: 1 point per board, first-to-10 match structure

This is a **multi-round match**, not a single-shot game:

- Winning a board = **1 point**. A split board gives the **full 1 point to every tied winner** (not divided) — consistent with treating a split as "both genuinely won it."
- A round awards each player between 0 and `boardCount` points (2 or 3, depending on the match's fixed board count).
- Points accumulate in `room.mfScores[name]` across rounds within a match. Once a round's results push one or more players to **≥ `MF_TARGET_SCORE`**, the match ends immediately.
- If a round's results put **multiple players at ≥10 simultaneously** (including via a split board), they're **co-champions** — the match ends right there, no sudden-death decider round. This is consistent with the split-win philosophy used at the board level.
- Each new round is a **fresh shuffle and fresh flops** — round N+1 reuses the frozen board count and roster (see below) but re-deals everything from scratch (including recomputing that round's burn count, which is always the same value every round since roster/board-count are fixed, but is recomputed structurally rather than cached, to keep the logic uniform).

### Round pacing — host-gated, not auto-advancing

After a round's reveal (turn/river/burn cards shown, board winners computed, points awarded, updated match score displayed), the game **waits for the host to press "Next Round"** — matching the `ready` → `countdown` gate 10 Seconds already uses between rounds. It does not auto-advance after a timer. This gives the table a moment to actually look at results and talk about it before the next hand starts.

## Match-level state is frozen at Start

Both the **board count** and the **player roster** (who's dealt cards each round, and thus the per-round deal/burn math) are computed once when the host presses Start and then **never recalculated for the rest of the match**, even as players disconnect and reconnect:

- Board count: locked in from the roster present at Start. Avoids the game's core strategic shape shifting between rounds.
- Roster: every player present at Start stays part of every subsequent round's deal, indefinitely, even if they disconnect and never come back. A permanently-gone player simply keeps getting dealt a "ghost" hand every round (see disconnect handling — it auto-locks for them). This keeps the deal math (`cardsPerPlayer`, `burnCount`) a pure function of the frozen roster size, computed once and reused unchanged every round — no mid-match recomputation, no edge cases from a shrinking table.

This matches this app's existing precedent of not reshuffling game structure around a dropped connection (e.g. Codenames never auto-promotes a new leader on disconnect).

## Disconnect handling

- **During `allocating`, before that player has locked:** on disconnect, immediately auto-lock a **deterministic even split** for them — their dealt cards, in a fixed order (e.g. the order they were dealt), distributed round-robin across boards in board-index order (Board 1 gets the extra card(s) first, since the player isn't present to choose). This mirrors Imposter's "disconnect before answering defaults to eliminated" and 10 Seconds' "DNF defaults to worst" pattern: the round keeps moving instead of hanging on a dropped connection. After auto-locking, run the same "has everyone locked?" check used after a manual lock (mirrors `maybeFinishImposterReporting`'s pattern) to see if reveal can proceed.
- **Reconnecting before auto-lock has been applied** (i.e., they come back before the rest of the table has finished locking): they simply resume their own allocation screen with whatever they'd already set — server-held per-player state, same reconnect pattern as the rest of this app.
- **Reconnecting after auto-lock (or after their own manual lock):** no change — locks are permanent for the round regardless of how they were set, manual or automatic. They see their (auto-)locked allocation reflected back to them, read-only, same as a player who locked manually and then refreshed the page.
- **Permanently gone for the rest of the match:** covered above — they keep getting dealt a hand and auto-locked every round, using the frozen original roster size for all deal math.

## Match end & scoreboard integration

When the match ends (someone/several reach `MF_TARGET_SCORE`):

1. Rank every player in the match by their **final cumulative `room.mfScores` total**, descending.
2. Award scoreboard points via **standard competition ranking**: 1st place gets `N` points (`N` = number of players in the match), 2nd gets `N - 1`, and so on down to `1` for last. Players tied on final score get the **same rank and the same points**; the next distinct rank **skips accordingly** (e.g. two tied for 2nd both get `N - 1` points, and the next player is ranked 4th, not 3rd) — consistent with every other tie rule in this spec.
3. Match co-champions (multiple players who hit ≥10 in the same round) are both ranked 1st and both get the full `N` points.
4. These points are added to `room.scoreboard[name]`, same mechanism the other three games already use (see `scoreboard-specs.md`) — Menifot's internal 0–10 race and the room's cross-game leaderboard are two separate, non-conflicting systems.

## Play Again / Back to Lobby

- **Back to Lobby** (host-only): returns everyone to the shared lobby / choose-a-game screen, roster intact. Clears all Menifot state (`room.mf*` fields).
- **Play Again** (host-only, from the match-end screen): re-snapshots whoever is currently connected in the room as the **new match roster** (may differ from the previous match's roster — anyone who joined/left the room mid-match couldn't have participated anyway), resets `room.mfScores` to empty, and immediately starts round 1 of a brand-new match (fresh board-count computation, fresh shuffle). No cross-match score carryover, matching this app's general "full reset" pattern for replays.

## Server state additions (`room.mf*`, prefixed like `cn*`/`ts*`)

- `room.mfPlayers`: frozen array of player names in the match roster, set once at Start.
- `room.mfBoardCount`: 2 or 3, frozen at Start.
- `room.mfBoards`: per-round array of `{ flop: [3 cards], turn: card, river: card, revealed: bool }`.
- `room.mfHands`: per-round map, name → `{ cards: [...], allocation: { [boardIndex]: [cards] }, locked: bool }`.
- `room.mfBurned`: per-round array of burned cards, hidden until that round's reveal.
- `room.mfScores`: name → cumulative round-points total for the current match (the 0–`MF_TARGET_SCORE` race).
- `room.mfRoundNumber`: increments each round within a match.
- `room.mfRoundResults`: per-board winners (array, supports splits), points awarded this round, revealed cards — populated at reveal, read by the round-results screen.
- `room.mfMatchWinners`: array of name(s), populated once the match ends (supports co-champions).

Add `'scoreboard'` is already in `ROOM_SAVED_FIELDS`; add the `mf*` fields needed to survive a mid-match server restart (at minimum `mfPlayers`, `mfBoardCount`, `mfScores`, `mfRoundNumber` — enough to resume a match in the `ready`-for-next-round state; in-flight `allocating` state, like Codenames' in-flight turn timer, may be simplest to just fail back to the last completed round on restart rather than trying to persist a mid-allocation snapshot).

## Explicitly out of scope (v1)

- No anti-cheat beyond what this app already trusts elsewhere (server does own the deck shuffle, deal, and hand evaluation server-side per your original requirements — the "trust-based" parts are limited to reconnect/UI state, same as the rest of this app).
- No configurable point values per board win, no configurable target score beyond the `MF_TARGET_SCORE` constant (not exposed as a per-room setting in v1, just a code constant).
- No spectator mode beyond the standard "disconnected but still in the roster" handling already described.
- No sudden-death tiebreaker round for simultaneous match-end — co-champions stand as designed.
- No timer on the allocation phase (unlike Codenames' optional turn timer) — allocation is untimed in v1.
