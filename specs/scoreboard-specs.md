# Global Scoreboard — Specs

A running points leaderboard shown on the shared lobby screen, fed by all games in the
room (Imposter, Codenames, 10 Seconds, Menifot, Kart Race). Scoped **per room**, not global
across the server — "global" means "shared across every game type within this room," not
cross-room identity.

## Relationship to existing games / shared app changes

- New room-level state, independent of `room.players` and independent of any single game's phase machine.
- Displayed on the shared lobby / "choose a game" screen, visible any time players are back at that screen between games.
- Persisted to disk the same way room state already is (`ROOM_SAVED_FIELDS` / `saveRoomsToDisk()` / `loadRoomsFromDisk()` in `server.js`) — scores survive a server restart along with the rest of the room.
- No cross-room or cross-session identity: scores are keyed by player name string within this room only, consistent with the rest of the app's no-accounts model.

## Server state additions

- `room.scoreboard`: map of name → integer point total. Not nested inside `room.players`, so a score survives a player disconnecting from the lobby (which deletes their roster entry — see `socket.on('disconnect', ...)` in `server.js`) and later rejoining under the same name.
- New players joining a room start with no entry (treated as 0) until they earn/lose their first points.
- Add `'scoreboard'` to `ROOM_SAVED_FIELDS` so it round-trips through `saveRoomsToDisk()` / `loadRoomsFromDisk()`.

## Display

- Lobby screen shows: **name + total points only**, sorted descending by total. No games-played count, no per-game-type breakdown.
- Ties in total score: stable sort, no special tiebreak needed for display.
- A host-only **"Reset Scoreboard"** button (with a confirmation, since it's destructive) clears `room.scoreboard` back to empty. This is the only way scores go back to zero short of the room itself being abandoned/deleted.

## Point values by game

| Game | Outcome | Points |
|---|---|---|
| Imposter | Imposter, not eliminated | **+3** |
| Imposter | Crew, not eliminated | **+1** |
| Imposter | Imposter, eliminated | **0** |
| Imposter | Crew, eliminated | **-1** |
| Codenames | Player on winning team | **+2** |
| Codenames | Player on losing team | **0** |
| 10 Seconds | Champion (1st place) | **+2** |
| 10 Seconds | Second place (most recently eliminated before champion) | **+1** |
| 10 Seconds | Everyone else (middle placements) | **0** |
| 10 Seconds | Last place (first eliminated) | **-1** |
| Kart Race | 1st place | **+3** |
| Kart Race | 2nd place | **+2** |
| Kart Race | 3rd place | **+1** |
| Kart Race | Everyone else (4th and below, including non-finishers) | **0** |

Points are added to `room.scoreboard[name]` once per resolved game/round, per the flows below.

## Imposter scoring flow (new — Imposter currently has no server-tracked winner)

Today, Imposter's `'playing'` phase just shows each player their role/word/hint; the actual deduction happens out loud, and the only button is "Back to Lobby" (an immediate full reset, no outcome ever recorded). This is changed as follows:

- **`room.game === 'imposter' && room.phase === 'playing'`** now shows two host-only buttons side by side:
  - **"Back to Lobby"** — unchanged, immediate reset, no scoring. For rounds nobody cares to record.
  - **"End Round"** (new) — starts the scoring flow described below.
- Clicking **"End Round"** moves the room to a new phase, e.g. `room.phase = 'reporting'`, and broadcasts it to everyone.
- **`reporting` phase**: every player (active, regardless of role) is shown a **"Were you eliminated?"** Yes/No prompt and submits their answer once.
  - Player's role (`p.role`, already known server-side: `'imposter'` or `'crew'`) combined with their self-reported eliminated/not-eliminated answer determines their tier from the table above.
  - Each imposter is scored independently — with 2 imposters (5+ players), one can survive while the other is eliminated, each gets their own tier.
  - **Disconnect before answering**: defaults that player to "eliminated" (consistent with 10 Seconds' DNF-as-worst-result philosophy) so the round doesn't hang waiting for someone who dropped.
  - Once every active player has an answer (submitted or defaulted), the server computes each player's points, adds them to `room.scoreboard`, and moves to a results phase.
- **Results phase** (e.g. `room.phase = 'roundResults'` reusing the naming convention from 10 Seconds, or a new `'imposterResults'`): shows every player their name, role, self-reported outcome, and points earned this round, plus the updated scoreboard. Host-only **"Back to Lobby"** button continues from here back to the shared lobby.
- No mid-round-join concerns beyond what already exists — this flow only ever starts from the existing `'playing'` phase with the existing active roster.

## Codenames scoring flow

- Codenames already resolves to a real winner server-side: `checkTeamWin(room)` sets `room.cnWinner` and increments `room.cnScores[winner]`, moving to `room.phase = 'gameover'`.
- At that same moment (when `room.phase` is set to `'gameover'`), award **+2** to every player whose `p.team === room.cnWinner`, **0** to everyone on the other team, added to `room.scoreboard`. No leader bonus.
- No new phase needed — this piggybacks on the existing gameover transition. The existing gameover screen additionally shows the updated scoreboard.
- Players who disconnected mid-game but still have a `team` assignment are scored the same as connected players (team membership is what matters, not connection state at gameover).

## 10 Seconds scoring flow

- 10 Seconds already resolves to a full standings order at gameover: champion, then `room.tsEliminatedOrder` reversed.
- At the moment `room.phase` is set to `'gameover'` (exactly one player remains in `room.tsActivePlayers`):
  - The champion (the one remaining active player) gets **+2**.
  - The **last name** in `room.tsEliminatedOrder` (i.e. most recently eliminated, the round just before the champion was decided) gets **+1** — this is "second place."
    - If that elimination was a tied/simultaneous group (multiple names eliminated together in the same round — see the DNF-group exception in `10-seconds-specs.md`), **every name in that tied group** gets +1, not just one.
  - The **first name(s)** in `room.tsEliminatedOrder` (i.e. earliest eliminated) get **-1** — this is "last place." Same tie handling: if the first elimination was a simultaneous group, all of them get -1.
  - Everyone else in `room.tsEliminatedOrder` (middle placements) gets **0**.
  - **2-player special case**: with only 2 players there's no middle ground — the sole non-champion is scored as last place (**-1**), not second place.
- No new phase needed — this piggybacks on the existing gameover transition (`continueTsAfterResults`). The existing gameover screen additionally shows the updated scoreboard.

## Explicitly out of scope (v1)

- No true cross-room / cross-session global identity (no accounts, no auth) — scores are per-room, keyed by name string only.
- No games-played count, win/loss record, or per-game-type breakdown on the scoreboard display — total points only.
- No placement gradient beyond the 4 tiers in 10 Seconds (no separate point value for e.g. 3rd vs 4th place in a large game) — just champion / second / last / everyone-else.
- No anti-cheat on Imposter's self-reported "were you eliminated?" answer — trust-based, consistent with how this app already trusts client-reported data (10 Seconds' elapsed time, etc.).
