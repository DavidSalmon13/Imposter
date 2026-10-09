# Codenames — Specs

A same-room party word game, second game in this app alongside Imposter. Two teams (Red/Blue) race to find all of their own words on a shared 5×5 grid based on one-word clues their team leader gives out loud (not through the app). Touch the wrong word and your turn ends; touch the assassin and your team loses instantly.

## Relationship to Imposter / shared app changes

This app now hosts two games, still **one at a time, no concurrent games, no room codes** (unchanged from Imposter's model). A few cross-cutting changes are needed to support that:

- **Game selection screen**: after the shared lobby (unchanged join flow — name entry, live player list), the host now sees a "Choose a game" screen (Imposter / Codenames) instead of going straight to Imposter's Start button.
- **"Back to Lobby" / "New Game" no longer wipes the roster**: both games' end-of-session reset now returns everyone to the shared lobby / choose-a-game screen, keeping connected players' names intact (no re-typing). Only game-specific state clears (Imposter: role/word/hint/vote; Codenames: teams/leader/board/score). This replaces Imposter's current `players.clear()` behavior in the `newGame` handler.
- **Mid-game joins stay blocked**: once either game leaves the shared lobby phase, new joiners get "Game in progress, wait for the next round" — same rule Imposter already enforces, just extended to Codenames' additional phases (team-select, playing).
- The lobby host (first joiner, reassigned on disconnect — unchanged concept) remains the sole control-plane authority for **Start** and **Back to Lobby** in both games.

## Phases (Codenames-specific, after "choose game")

```
lobby (shared) → team-select → generating → playing → gameover
```

- **team-select**: players self-assign to Red/Blue and claim leader; host presses Start once both teams are valid.
- **generating**: server is asking ChatGPT for the 25-word board.
- **playing**: active turns, red/blue alternating.
- **gameover**: win/loss screen shown; either team leader can press Play Again (→ back to `generating` with same teams), or host presses Back to Lobby (→ shared `lobby`).

## Team formation

- Players self-select Red or Blue from a live-updating team-select screen (same live-list pattern as the existing lobby).
- Each team needs **at least 2 connected players** (1 leader + ≥1 guesser) before Start is enabled. Uneven teams are allowed (e.g. 3v2) — no balance requirement beyond the 2-per-team floor.
- The host can press **Random Teams** to shuffle every connected player onto a team: sizes differ by at most one (with an odd count, a random team gets the extra player). Leader claims are cleared, so each team claims a leader again afterwards. Players can still switch teams manually after randomizing.
- Each team has a **"Become Leader" claim button**, hidden/disabled once that team already has a leader. First click wins. Leader gets a badge in the team list, same visual pattern as the existing "(host)" tag.
- Global minimum player count is therefore implied by team minimums: 2 + 2 = 4.

## Board generation & card distribution

- One ChatGPT call (server-side) generates **25 unique, common, family-friendly, single-word nouns** — no proper nouns, no phrases (single words only, unlike Imposter's 1-2 word allowance, since these need to lay out cleanly in a 5×5 grid).
- Codenames keeps its **own rolling "recently used" word list**, separate from Imposter's — different pool, no cross-contamination.
- Word source lives behind a single function boundary (e.g. `generateWordGrid()`) so it can later be swapped for a custom word list or picture pack without touching the rest of the game logic. Not building that now — just keeping the seam.
- Server randomly assigns the 25 words across the grid: **8 to the starting team, 7 to the other team, 1 assassin, 9 neutral**.
- **Starting team**: random on the very first round of a session. On every subsequent "Play Again," the starting team **alternates** (not re-randomized) so it's fair across a session.

## Room name bank

- The team-select screen has a **room-scoped name bank**: any connected player can add a word (up to 30 characters, deduped case-insensitively, max 200 entries) — meant for inside jokes, friends' names, etc.
- The bank belongs to the room, not a single game session: it survives Play Again *and* Back to Lobby, and persists to disk like the scoreboard.
- Each time a board is generated, **2 random entries are pulled from the bank** (fewer if the bank has fewer than 2) and mixed in alongside the ChatGPT-generated words to fill the 25-word grid. They're placed like any other word — same random color assignment, same shuffled position — so they carry no special treatment once the board is built.

## What each player sees

- **Non-leader players**: plain 5×5 grid of words, no color hints, until a card is actually revealed through play.
- **Leaders**: full 4-way color coding of the entire board —
  - their own team's words (their team color)
  - the opponent's words (opponent color)
  - neutral words (distinct grey/beige)
  - the assassin (distinct color **and** icon, e.g. a skull) — made visually unmistakable so a misread can't cause an accidental loss.
- Both leaders see the same information (their own team + the opponent's + neutral + assassin) — full board knowledge, differing only in which color is "mine."

## Turn flow

- Header shows whose turn it is ("Red's turn" / "Blue's turn"), plus how many unrevealed cards each team still has to find ("Red: 5 left · Blue: 3 left") — visible to everyone, since the counts are computed server-side. Only the active team's **non-leader** players can touch the grid; the leader never touches the board (gives their clue out loud, outside the app).
- Clicking a card:
  - **Own team's word** → revealed to everyone in that team's color; turn continues, same team keeps guessing.
  - **Opponent's word** → revealed to everyone in the opponent's color (a small free gift to them); turn ends immediately.
  - **Neutral word** → revealed to everyone as neutral; turn ends immediately.
  - **Assassin** → revealed to everyone; game ends immediately, guessing team loses.
- **End Turn** button is available to any non-leader player on the active team (not just one designated person) — team collectively decides when to stop guessing, matching how real Codenames guessing works. Leader never sees this button.
- No clue-count enforcement in-app (the leader's number, e.g. "fruit, 3," is spoken aloud only) — teams can keep guessing correctly as long as they want, until End Turn or a wrong guess.

## Win / loss detection

- App detects game end automatically (unlike Imposter, which leaves win detection to the table) — the server already has full board state:
  - A team's last word gets revealed → that team wins.
  - The assassin gets touched → the guessing team loses, other team wins.
- On game end: full board is revealed to everyone, a "Red Wins!" / "Blue Wins!" screen is shown.

## Scoring

- Server tracks a simple **per-team win counter** for the current session (two integers).
- Shown on the win/loss screen (and optionally as a small persistent header during play).
- Resets only on a full **Back to Lobby**, not on **Play Again**.

## Play Again (between rounds)

- Either team's leader (not just the host) can press Play Again from the game-over screen.
- Keeps the same teams and leaders, deals a fresh 25-word board, alternates the starting team, resets to `generating` → `playing`.
- Score persists across Play Again rounds.

## Back to Lobby (ending the session)

- Host-only action (from team-select or game-over).
- Returns everyone to the shared lobby / choose-a-game screen — player roster/names stay intact.
- Clears Codenames-specific state: teams, leader claims, board, score.

## Reconnect handling

- Same-name reconnect (existing `localStorage` name pattern) silently restores a leader's full colored view — critical since a leader can't verbally ask teammates "what does the board look like" without breaking the game.
- If a leader disconnects and doesn't come back, the board state persists server-side (nothing lost); the team is blocked from receiving clues until either that same name reconnects, or a teammate claims leader via the same "Become Leader" button used during team-select.
- No auto-promotion of a new leader on disconnect — avoids yanking the role from someone on a flaky connection mid-turn.

## Failure handling

- If the ChatGPT call for the 25-word grid fails, or a team drops below the 2-player minimum while generating: abort back to **team-select** (not all the way to the shared lobby), preserving the already-chosen teams and leaders. Host sees a retryable error and can press Start again. Mirrors Imposter's existing `failRound` pattern.

## Mid-game joins

- Once Codenames has left the shared lobby phase (team-select, generating, playing, gameover), new joiners are rejected with the same "Game in progress, wait for the next round" error Imposter already uses. No spectating, no mid-round team-joining.

## Explicitly out of scope (v1)

- No clue-count enforcement, no in-app clue text input — clues are always spoken aloud.
- No timer / turn clock.
- No spectator mode.
- No custom word lists or picture packs yet (seam left for later, not built now).
- No room codes / multiple concurrent games (unchanged app-wide constraint).
