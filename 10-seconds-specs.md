# 10 Seconds — Specs

A same-room party game, third game in this app alongside Imposter and Codenames. Every remaining player races an individual, visible stopwatch and tries to stop it as close as possible to exactly 10.000 seconds. After each round the player furthest from the target is eliminated; last player standing wins.

## Relationship to Imposter / Codenames / shared app changes

- Added as a third option on the existing "Choose a game" screen (Imposter / Codenames / 10 Seconds), using the same `chooseGame` socket event pattern (`room.game = 'tenseconds'`).
- Reuses the shared lobby, host concept (first joiner, reassigned on disconnect), room-code model, and the "Back to Lobby" reset pattern (clears only 10-Seconds-specific state, keeps the player roster/names intact).
- Mid-game joins are blocked the same way as the other two games: once the room leaves the shared lobby phase, new joiners get "Game in progress, wait for the next round."
- No ChatGPT / external API calls are needed for this game — everything is timer and state logic.

## Phases (10-Seconds-specific, after "choose game")

```
lobby (shared) → ready → countdown → running → roundResults → (countdown again | gameover)
```

- **ready**: shows the full remaining-player list and a "Start" / "Next Round" button, host-only. Button is disabled with a "waiting for `<name>` to reconnect" message if any remaining (non-eliminated) player is currently disconnected.
- **countdown**: fixed 3-second synchronized "3… 2… 1… GO" shown to everyone (active and spectating), driven by a single server-broadcast `roundStartAt` epoch timestamp (`Date.now() + 3000`).
- **running**: each active player's own stopwatch runs live from 0.000s, visibly ticking milliseconds, computed locally as `Date.now() - roundStartAt`. Stop button is enabled only once local time reaches `roundStartAt`.
- **roundResults**: table of every active player this round (name, stopped time, distance from 10.000s), eliminated player highlighted, shown to active and spectating players alike.
- **gameover**: full final standings shown (winner at #1, then eliminated players in reverse elimination order). "Play Again" (host-only) or "Back to Lobby" (host-only).

## Minimum players

- **2 minimum** to press Start. With exactly 2 players, the game is a single round — closest to 10.000s wins outright.

## Timing model — client-computed, trusted

- Server is the synchronization authority for *when* a round starts, not for measuring elapsed time.
- On Start / Next Round, server immediately sets `room.tsRoundStartAt = Date.now() + 3000` and broadcasts it. All clients derive the 3-2-1-GO countdown and the subsequent live counter from this single timestamp.
- When a player presses Stop, the client computes `elapsed = Date.now() - tsRoundStartAt` locally and sends that number to the server as its official result for the round (trust-based — consistent with how this app already trusts clients in Imposter and Codenames; no anti-cheat).
- Distance from target = `Math.abs(elapsed - 10000)` (all times in ms internally, displayed to 3 decimal places, e.g. `10.025`).
- Stopping before or after 10 seconds is fully allowed; there's no penalty structure beyond raw distance.

## Round resolution

1. Server waits for a Stop submission (or a resolved DNF, see below) from every currently-active player.
2. Once all are in, compute each active player's distance from target.
3. Sort ascending by distance. The player(s) with the **largest** distance are candidates for elimination.
4. **No tie** for worst: that single player is eliminated.
5. **Tie for worst (2+ players exactly equal distance)**: those tied players immediately play a **sudden-death round** among just themselves (same countdown/running mechanics, no third parties involved). Whoever is worst among *that* subgroup is eliminated. If the sudden-death round itself produces another tie among a subset, repeat sudden death among that smaller subset — cascades until exactly one worst player is isolated. Only one player is ever eliminated per normal round's resolution (multiple sudden-death replays are all part of resolving that same round).
6. All non-eliminated players advance to the **ready** phase for the next round.
7. When exactly one player remains, the game moves to **gameover** and that player is the 10-Second Champion.

## Disconnect handling

- **Mid-round disconnect** (round already running, player hasn't pressed Stop): that player is auto-assigned a "did not finish" (DNF) result — treated as the worst possible distance for that round, without waiting for them. If they reconnect before the round resolves, a live client stop submission is still accepted normally.
- **Multiple simultaneous DNFs in the same round**: if 2+ players DNF in the same round, all of them are eliminated together — this is the one exception to "one elimination per round," since a sudden-death replay isn't possible with disconnected players. (Non-DNF players' actual times still determine ranking among themselves for the results table, but they're safe regardless of how they placed, since the round's elimination decision is fully absorbed by the DNF group.)
- **All remaining players DNF in the same round** (e.g. a server restart): treated as a void — nobody is eliminated, the same set of players simply retries the round from **ready**. This is a defensive fallback for a degenerate case, not expected in normal play.
- **Connected but never presses Stop**: server force-stops that player's timer at **30.000s** (3x the target) if they haven't pressed Stop by then, so a distracted player doesn't hang the round. This is a real (non-DNF) result and factors into ranking normally.
- **Ready-phase connectivity gate**: Start / Next Round is disabled while any remaining player is disconnected, so every synchronized-start round always has full participation from everyone still in the game.

## What eliminated players see

- Once eliminated, a player keeps their connection and sees a "You're eliminated — spectating" badge.
- During subsequent rounds they see the same countdown / running-indicator / roundResults screens as active players (minus their own Stop button and live counter, since they're not playing), including the full per-round results table.
- They see the final gameover standings exactly like everyone else.

## Play Again / Back to Lobby

- **Play Again** (host-only, from gameover): brings back every originally-connected player (nobody stays eliminated), clears round history and elimination order, and starts a brand new bracket from round 1. No persistent cross-session champion tally — matches Imposter's full-reset model.
- **Back to Lobby** (host-only, available any time): returns everyone to the shared lobby / choose-a-game screen, roster intact. Clears all 10-Seconds state (round number, elimination order, room.tsRoundStartAt, per-round results).

## Server state additions

- `room.tsActivePlayers`: ordered list of names still in the game.
- `room.tsEliminatedOrder`: names in the order they were eliminated (reversed for final standings).
- `room.tsRoundStartAt`: epoch ms for the current round's synchronized start, or `null` between rounds.
- `room.tsRoundResults`: map of name → `{ elapsedMs, distanceMs, dnf }` for the round currently resolving/just resolved.
- `room.tsRoundNumber`: integer, increments each normal round (sudden-death replays don't increment it — they're sub-steps of resolving the same round number).

## Explicitly out of scope (v1)

- No anti-cheat / server-side verification of client-reported elapsed time.
- No persistent leaderboard or champion tally across Play Again sessions.
- No spectator mode beyond the built-in "eliminated but still connected" view.
- No sound effects / haptics for the countdown (visual only, v1).
- No configurable target time or round count — always exactly 10.000s, always full elimination to one winner.
