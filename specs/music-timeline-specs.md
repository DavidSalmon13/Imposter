# Music Timeline — Specs

A same-room party music game inspired by HITSTER, sixth game in this app alongside Imposter,
Codenames, 10 Seconds, Menifot, and Kart Race. Teams (or solo players) each build their own
chronological timeline of songs. Each turn, the server asks ChatGPT for one song (title +
artist + release year, kept secret from everyone but the host); the host plays it out loud
from their own Spotify/YouTube, and the active team places it into their timeline by era, not
exact year. Correct placements grow the team's timeline; incorrect ones discard the card. First
team to a target card count wins.

## Relationship to Imposter / Codenames / 10 Seconds / Menifot / Kart Race / shared app changes

- Sixth option on the "Choose a game" screen, same `chooseGame` socket event pattern:
  `room.game = 'musictimeline'`.
- Reuses the shared lobby, host concept (first joiner, reassigned on disconnect), room-code
  model, and the shared per-room `room.scoreboard` (see `scoreboard-specs.md`).
- Mid-game joins are blocked the same way as every other game: once the room leaves the shared
  lobby phase, new joiners get "Game in progress, wait for the next round."
- "Back to Lobby" returns everyone to the shared lobby / choose-a-game screen, keeping the
  roster/names intact, clearing only `room.mt*` state — same pattern as every other game.
- **One ChatGPT call per turn**, reusing the existing `chatCompletionJson()` helper
  (`server/lib/openai.js`) and mirroring Imposter's rolling-avoid-list pattern
  (`room.usedWords`) — here, `room.mtUsedSongs`. No local song database, no Spotify/YouTube API
  integration, no audio playback in-app (see "Song source & playback" below).
- Team formation reuses Codenames' pattern: `player.team` field, a team-select-style setup
  screen, first-click-wins claim semantics — extended here to up to 4 teams instead of a fixed
  Red/Blue, plus a Solo toggle (see "Team formation" below).

## Configurable constants

Kept as named constants inside `server/games/musicTimeline.js` (matching `MF_MIN_PLAYERS` /
`CN_MIN_PLAYERS` / `TS_MIN_PLAYERS` / `KR_MIN_PLAYERS` precedent), so rules can be tuned later
without touching game logic:

| Constant | Value | Meaning |
|---|---|---|
| `MT_MIN_PLAYERS` | 2 | Floor to start a match |
| `MT_MAX_PLAYERS` | 10 | Ceiling on total connected players |
| `MT_MIN_TEAMS` | 2 | Floor on number of teams in Team mode |
| `MT_MAX_TEAMS` | 4 | Ceiling on number of teams in Team mode |
| `MT_TARGET_CARDS` | 10 | First team to reach this many timeline cards wins the match |
| `MT_STARTING_TOKENS` | 2 | Tokens each team starts a match with |
| `MT_MAX_TOKENS` | 5 | Token cap per team |
| `MT_SKIP_COST` | 1 | Tokens spent to discard the current song and get a new one |
| `MT_CHALLENGE_COST` | 1 (only deducted if the challenge is wrong) | Tokens spent to challenge another team's locked placement |
| `MT_AUTO_CARD_COST` | 3 | Tokens spent to auto-receive the current song without placing |
| `MT_USED_SONGS_AVOID_WINDOW` | 40 | How many recent songs are sent to ChatGPT as a "don't repeat these" list (mirrors Imposter's `usedWords.slice(-40)`) |

Not exposed as per-room host settings in v1 — code constants only, same as `MF_TARGET_SCORE`.

## Team formation

- At setup (before Start), the host picks **Team mode** or **Solo mode** for the match.
- **Team mode**: players self-assign via "Join Team A / Join Team B / Join Team C / Join Team
  D" buttons (`MT_MIN_TEAMS`–`MT_MAX_TEAMS` teams shown based on host's chosen team count),
  exactly like Codenames' team-select screen. `player.team` stores the assignment. Minimum 1
  connected player per team to start; no leader/captain role — **any member of a team can
  act on that team's turn** (see "Turn actions" below).
- **Solo mode**: no team-select screen. Every connected player at Start is automatically their
  own team-of-one (`player.team = player.name`), so the rest of the game logic (which always
  operates in terms of "teams") runs unmodified — solo is not a separate code path, just teams
  where `teamSize === 1`.
- Team roster is frozen at Start, same as Menifot's frozen-roster precedent — players who join
  mid-match are blocked by the existing mid-game-join rule, and disconnected team members stay
  part of their team indefinitely (see "Disconnect handling").

## Difficulty modes

Host picks **Easy / Pro / Expert** at setup, alongside team mode. Unlike the original HITSTER
spec's per-difficulty verification rules, this app's difficulty **only changes what ChatGPT is
asked to pick** — placement correctness is always position-only, and artist/title
identification is always a separate, difficulty-independent way to earn a token (see "Earning
tokens" below):

| Mode | Prompt guidance to ChatGPT |
|---|---|
| Easy | "Pick a very famous, widely recognizable song most people would know instantly." |
| Pro | "Pick a moderately well-known song — not obscure, but not a top-40 giant either." |
| Expert | "Pick a song that can be a deeper cut — well-regarded but less mainstream is fine." |

The exact prompt wording is an implementation detail; the difficulty tier is passed through to
`generateMusicTimelineSong()` and included in the prompt text, same call shape as
`generateWordAndHint(room, level)` in `imposter.js`.

## Song source & playback (no database, no in-app audio)

- Every turn, the server makes **one live ChatGPT call** via `chatCompletionJson()`, asking for
  a single song appropriate to the match's difficulty, excluding the last
  `MT_USED_SONGS_AVOID_WINDOW` songs already used this match (`room.mtUsedSongs`, sent in the
  prompt as an avoid-list — same shape as Imposter's `avoid` array). Expected JSON response
  shape: `{ title, artist, releaseYear }`.
- **The app never plays audio itself.** The generated song is sent to the **host's socket
  only** (per-viewer payload, same pattern as Codenames' leader-only board colors); the host
  searches for it themselves on their own Spotify/YouTube/speaker and plays it out loud for the
  room. The host taps "Ready" once the room has heard enough to guess.
- No `spotifyTrackId`/`audioReference` field — ChatGPT can't reliably produce a real, resolvable
  track ID, so the host relies on title + artist to search manually. This is a deliberate
  simplification versus the original HITSTER-inspired spec.
- **Starting card per team**: at match start, one ChatGPT call per team (same avoid-list,
  results added to `room.mtUsedSongs` as they're generated so teams can't get duplicate starting
  cards) produces each team's first, face-up timeline card — title, artist, and year all shown
  immediately, matching the "establishes the team's first known point" framing.

## Phases

```
lobby (shared) → teamSelect (Team mode only) → ready → generating → placing → locked → revealed → (generating again | gameover)
```

- **teamSelect** (Team mode only; skipped entirely in Solo mode): players claim teams; host
  presses Start once every chosen team has ≥1 connected player.
- **ready**: starting cards have been dealt to every team; host presses "Start Match" /
  "Next Turn" to begin the first turn.
- **generating**: server is asking ChatGPT for the active team's song. Mirrors Imposter's
  `generating` phase and `failImposterRound` pattern exactly — on failure, revert to `ready`,
  emit an error, let the host retry. No song is revealed to anyone during this phase.
- **placing**: the song has been sent to the host only; the active team sees their timeline and
  the BEFORE/BETWEEN/AFTER placement buttons. Non-active teams (with a Challenge token
  available) see a "Challenge" option once a placement is locked, not before.
- **locked**: active team has tapped a placement slot. Placement is stored server-side,
  immutable. Non-active teams with a Challenge token available may challenge here (see
  "Challenge token" below); the host sees a "Reveal" button.
- **revealed**: host has tapped Reveal. True title/artist/year shown to everyone, correctness
  computed, card kept or discarded, host checks the artist/title honor-system box if earned,
  scores/token changes applied. Host presses "Next Turn" to go back to `generating`, or the
  match ends here if a team just hit `MT_TARGET_CARDS`.
- **gameover**: final standings shown (teams ranked by card count), scoreboard updated. Host
  can press Play Again (→ fresh `ready`, same roster/teams) or Back to Lobby.

## Turn order

- Turn order cycles through teams in the order they were formed (Team A → B → C → D → A → ...),
  repeating indefinitely regardless of correct/incorrect outcomes — matches real HITSTER, where
  every team gets a turn each cycle whether or not their last placement succeeded.
- `room.mtActiveTeamIndex` tracks whose turn it is; advances by one (wrapping) every time a turn
  resolves (`revealed` → next `generating`), including turns discarded via team-dropout
  auto-skip (see "Disconnect handling").

## Turn actions

- **Any connected member of the active team** may tap a placement slot — first tap locks it in
  for the whole team, no captain/leader role, no confirmation step from other members. Mirrors
  the party-game reality of a team huddled around one phone.
- The server authorizes by checking `socket.data.name`'s `player.team === room.mtActiveTeam`,
  same inline per-handler check pattern used everywhere else in this app (no shared middleware).

## Placement & correctness

Same algorithm as the original spec, computed server-side, never trusting the client:

```
newSong.year < firstTimelineSong.year
  OR newSong.year > lastTimelineSong.year
  OR timeline[i].year <= newSong.year <= timeline[i+1].year
```

- The team is shown their existing timeline as a sequence of years and chooses one of
  `timeline.length + 1` slots (BEFORE first, BETWEEN each adjacent pair, AFTER last) — never
  told the exact year needed, only their own timeline's known years.
- Songs with the **same year** as an existing timeline card may be placed on either side of it;
  both are treated as correct.
- **Correct**: song is inserted into `room.mtTeams[team].timeline` at the true chronological
  position (not necessarily the slot boundary the team tapped, if a same-year tie made either
  side valid), card count increments.
- **Incorrect**: song is discarded, not added to the timeline, card count unchanged.
- Placement correctness is **always position-only**, at every difficulty — difficulty affects
  song obscurity (see above), never the correctness check.

## Token system

Every team (including solo "teams") starts a match with `MT_STARTING_TOKENS`, capped at
`MT_MAX_TOKENS`.

### Skip token

- Available to the active team only, during `placing`, **before** they lock a placement.
- Spending `MT_SKIP_COST` discards the current song (added to `room.mtUsedSongs` so it's never
  re-offered) and immediately triggers a new `generating` call for a replacement — same team,
  same turn. Repeatable as long as the team has tokens; no per-turn skip limit beyond token
  balance.
- Discarded songs never count toward score, correct or not — the team never gets to guess on
  them.

### Challenge token

- Available to **any non-active team** with a token balance ≥ `MT_CHALLENGE_COST`, only during
  the `locked` phase (placement locked, not yet revealed by the host).
- **First team to tap "Challenge" claims it** — other teams' Challenge buttons disable
  immediately once one team has claimed the slot for this placement. No host adjudication, no
  simultaneous multi-team challenges.
- The challenging team then picks their own placement slot (same BEFORE/BETWEEN/AFTER UI,
  applied to *their own* timeline, not the active team's).
- On reveal: the server checks both the original active team's placement AND the challenger's
  placement for correctness (each against their own respective timeline).
  - **Challenger correct**: the challenger claims the card into their own timeline (card count
    +1 for them), no token cost — the original active team does not get the card even if their
    own placement also happened to be correct (challenge success takes the card).
  - **Challenger incorrect**: `MT_CHALLENGE_COST` is deducted from the challenger's tokens; the
    original active team's placement is scored normally (correct/incorrect against their own
    timeline, independent of the failed challenge).

### Automatic Card token

- Available to the active team only, during `placing`, before locking a placement (spending it
  replaces the normal placement step entirely for that turn).
- Costs `MT_AUTO_CARD_COST` tokens. On use, no placement UI is shown for that turn — the server
  reveals the song and **auto-inserts it at the mathematically correct chronological position**
  in that team's timeline (server already knows the true year), card count +1, guaranteed
  success.
- Cannot be combined with a Skip or a placement attempt on the same song — it's an alternative
  to placing, not a modifier of it.

### Earning tokens

- At `revealed`, the host sees an honor-system checkbox: **"Team correctly named the artist and
  title (said out loud)"**. Checking it awards the active team (or the challenger, if this was a
  challenged turn and the challenger is who's being credited — host judgment) +1 token, capped
  at `MT_MAX_TOKENS`.
- This is independent of whether the placement itself was correct, and independent of
  difficulty mode — no fuzzy text matching, no free-text input, purely host-confirmed.

## Reveal flow

- After a placement is locked (`locked` phase), the host taps a **"Reveal"** button — not
  automatic. This is the same window in which non-active teams can challenge (see above), so the
  host controls the pacing of both the suspense and the challenge opportunity.
- On Reveal: true title/artist/year broadcast to everyone, correctness computed for the active
  team (and the challenger, if any), timelines updated, host's artist/title checkbox becomes
  available, and the updated timeline + card count is shown to the whole room.

## Winning

- The moment any team's card count reaches `MT_TARGET_CARDS`, the match ends immediately (even
  mid-cycle — a team doesn't need to "finish the round," reaching the target ends it the instant
  it happens, matching Menifot's immediate-end-on-target philosophy).
- If a challenge and the resulting card gain would push **two teams** to the target
  simultaneously (challenger claims a card that pushes them to target in the same reveal where,
  hypothetically, another team was already sitting at target-minus-one — not actually possible
  in a single reveal since only one card changes hands per turn, but if a future rule ever makes
  this possible, co-champions stand, mirroring Menifot's simultaneous-target philosophy).
- No sudden-death tiebreaker.

## Match end & scoreboard integration

When the match ends:

1. Rank every **team** by final timeline card count, descending.
2. Award scoreboard points via standard competition ranking: 1st-place team's players each get
   `N` points (`N` = number of teams in the match), 2nd-place team's players each get `N - 1`,
   and so on. Teams tied on final card count share the same rank and same points; the next
   distinct rank skips accordingly (e.g. two teams tied for 2nd both get `N - 1`, and the next
   team is ranked 4th, not 3rd) — same tie-handling convention as Menifot.
3. In Solo mode, every "team" is one player, so this reduces to a plain per-player ranking.
4. Points are added to `room.scoreboard[name]` for every player on each team (all members of a
   team get their team's points, mirroring Codenames' "every player on the winning team scores"
   pattern), same mechanism every other game already uses.

## Disconnect handling

- **A single team member disconnects, teammates still connected**: no special handling needed —
  any remaining connected teammate can still act on the team's turn. Team roster (`player.team`)
  is not cleared on disconnect, matching Codenames' precedent.
- **The entire active team disconnects mid-turn** (0 connected players on the team currently up,
  song already generated and sitting with the host): the server auto-skips — discards the
  pending song (added to `room.mtUsedSongs` so it's never re-offered), advances
  `room.mtActiveTeamIndex` to the next team with ≥1 connected player, and immediately starts a
  new `generating` call for that team. No host intervention needed, mirrors this app's existing
  "disconnected players never block the room" philosophy (Menifot's auto-lock, 10 Seconds'
  auto-DNF).
- **The host disconnects mid-turn** (song already generated, sitting with the old host's socket
  only): host handoff already reassigns `room.hostName` via the existing shared lobby mechanism.
  Because the current song is stored in room state (`room.mtCurrentSong`, not only pushed
  client-side to one socket), the next per-viewer state broadcast simply includes it for
  whoever the new host is — no re-fetch, no lost turn.
- **A permanently-gone team** (all members disconnected for the rest of the match): stays in
  turn order; every time it's their turn, the team-dropout auto-skip above fires again. This
  matches Menifot's "ghost roster member" precedent of not reshuffling match structure around a
  dropped connection.

## Server restart recovery (`repairOnLoad`)

Unlike Menifot (whose mid-round hidden per-player hands are unsafe to reconstruct), Music
Timeline's "hidden" state is small enough to persist safely — the pending song is a secret only
because of *who it's broadcast to*, not because it can't be stored:

- `room.mtCurrentSong` is a normal, persisted room-state field (included in `savedFields`), so
  the per-viewer payload builder can keep deciding "only include this in the host's payload" on
  every broadcast, restart or not.
- On restart, if the room was mid-turn (`placing` or `locked`), the phase is preserved as-is —
  the reloaded room resumes exactly where it left off, no wasted ChatGPT call, no discarded
  progress. This only requires `repairOnLoad` to be a no-op for Music Timeline (no rollback
  needed), unlike Menifot's forced rollback to `ready`.
- If the room was mid-`generating` (an in-flight ChatGPT call was never resolved, e.g. process
  died before the response came back), `repairOnLoad` rolls back that one case to `ready` — an
  in-flight HTTP call genuinely cannot be resumed, but this is the only phase requiring rollback.

## Play Again / Back to Lobby

- **Back to Lobby** (host-only): returns everyone to the shared lobby / choose-a-game screen,
  roster intact. Clears all Music Timeline state (`room.mt*` fields).
- **Play Again** (host-only, from the gameover screen): re-snapshots whoever is currently
  connected as the new match roster, keeps existing team assignments where still valid (any
  team that's now empty is dropped, matching the team-select minimum), resets every team's
  timeline/card count/tokens to a fresh `MT_STARTING_TOKENS`, clears `room.mtUsedSongs`, deals
  fresh starting cards, and returns to `ready`. No cross-match score carryover on the internal
  0–`MT_TARGET_CARDS` race (the cross-game `room.scoreboard` is untouched by a Play Again, same
  as every other game).

## Server state additions (`room.mt*`, prefixed like `mf*`/`cn*`/`ts*`/`kr*`)

- `room.mtMode`: `'team' | 'solo'`, chosen at setup.
- `room.mtDifficulty`: `'easy' | 'pro' | 'expert'`, chosen at setup.
- `room.mtTeams`: map of team id → `{ name, timeline: [{ title, artist, releaseYear }, ...] (sorted ascending), tokens: int }`.
- `room.mtActiveTeamIndex`: index into turn order (see "Turn order").
- `room.mtCurrentSong`: `{ title, artist, releaseYear } | null` — the pending song for the
  active team's current turn; persisted (not per-socket-only) so restarts and host handoff both
  resolve correctly (see above).
- `room.mtCurrentChallenge`: `{ team, placement } | null` — set once a team claims the Challenge
  slot for the current locked placement, cleared on reveal or when a new turn starts.
- `room.mtUsedSongs`: rolling list of `{ title, artist }` already used this match, sent to
  ChatGPT as the avoid-list (capped/windowed per `MT_USED_SONGS_AVOID_WINDOW`).
- `room.mtRoundNumber`: increments each resolved turn, for display/debugging.
- `room.mtMatchWinners`: array of team id(s), populated once the match ends (supports
  co-champions, see "Winning").

`savedFields` for this module: at minimum `mtMode`, `mtDifficulty`, `mtTeams`,
`mtActiveTeamIndex`, `mtCurrentSong`, `mtUsedSongs`, `mtRoundNumber` — everything needed to
resume a match exactly, per the restart-recovery design above.

## Explicitly out of scope (v1)

- No in-app audio playback of any kind — the host always plays music through their own
  separate app/device. No Spotify/YouTube API integration, no OAuth, no `<audio>` element.
- No local/static song database — every song is a live ChatGPT call; no fallback source if
  `OPENAI_API_KEY` is missing or the API is down beyond the existing retry-on-failure UX.
- No free-text artist/title guessing or fuzzy string matching — artist/title identification is
  always host-confirmed honor system.
- No exact-year guessing at any difficulty — placement is always by era (BEFORE/BETWEEN/AFTER),
  never a numeric year input.
- No per-room-configurable target card count, token costs, or team/player caps — code constants
  only, same as Menifot's `MF_TARGET_SCORE`.
- No captain/leader role for teams — any connected team member can act on their team's turn.
- No timer on placement, challenge, or reveal — every step is untimed and host/team-paced.
- No spectator mode beyond the standard "disconnected but still on the roster" handling already
  described.
- No anti-cheat beyond what this app already trusts elsewhere (host's honor-system checkbox,
  players verbally agreeing on what they heard) — consistent with the rest of the app's
  trust-based model.
