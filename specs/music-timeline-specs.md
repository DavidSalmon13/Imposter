# Music Timeline — Specs

A same-room party music game inspired by HITSTER, sixth game in this app alongside Imposter,
Codenames, 10 Seconds, Menifot, and Kart Race. Teams (or solo players) each build their own
chronological timeline of songs, starting from nothing. Each turn is push-your-luck: the server
asks ChatGPT for one song (title + artist + release year, kept secret from everyone except the
DJ team for that turn - the next team up in turn order); a DJ team member plays it out loud from
a YouTube search link on their own device, and the active team places it into their timeline by
era, not exact year. A correct placement doesn't bank immediately - the
team chooses whether to draw another song (risking everything collected so far) or stop and keep
what they've collected. A single wrong placement anywhere in the turn loses everything collected
that turn. First team to a target card count wins.

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
| `MT_STARTING_TOKENS` | 2 | Tokens each team starts a match with - fixed, never earned back |
| `MT_CHALLENGE_COST` | 1 (only deducted if the challenge is wrong) | Tokens spent to challenge another team's locked placement |
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
asked to pick** — placement correctness is always position-only, never affected by difficulty:

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
- **The app never plays audio itself.** The generated song (plus a `youtube.com/results?search_
  query=` link built from title + artist, no API key required) is sent only to the **DJ team**
  for the turn — see "DJ team & song visibility" below — whose members search/play it themselves
  on their own device and play it out loud for the room. The guessing (active) team never sees
  the title, artist, or link before the reveal.
- No `spotifyTrackId`/`audioReference` field, and no exact video resolution — ChatGPT can't
  reliably produce a real, resolvable track ID, and the app doesn't call the YouTube Data API, so
  the DJ team gets a search-results link and picks the right video themselves. This is a
  deliberate simplification versus the original HITSTER-inspired spec.

## DJ team & song visibility

- The team that sees the pending song each turn is **the next team after the active one in turn
  order** (`mtDjTeamId()`; wraps around, e.g. with teams A/B/C: A's turn → B is DJ, B's turn → C
  is DJ, C's turn → A is DJ). This naturally rotates DJ duty across every non-active team over the
  course of a match without any separate scheduling. It is never the active team itself.
- If that team has zero connected members (skipped over just like `advanceTurn`'s connected-member
  requirement), the search continues around the cycle to the next team that does have one. If
  *no* other team has any connected member at all (last-resort edge case), the host sees the song
  instead so the round isn't stuck with nobody able to play it.
- **Any connected member of the DJ team** may view the song and link, same "any teammate can act"
  authorization pattern as placing a card — no separate DJ/leader role to set up.
- Once a placement is revealed (`revealed` phase), the true title/artist/year is shown to
  **everyone**, DJ team or not, same as before.
- **The DJ team cannot challenge on a turn they're DJing** (`mtChallenge` rejects it): they
  already know the real answer, which would make a challenge a sure thing rather than a guess.
  This is a deliberate fairness carve-out from this app's usual honor-system/trust-based model. In
  a 2-team match this makes Challenge effectively unusable — the DJ team is always the only other
  team — which is an accepted trade-off, not a bug: with more than 2 teams, challenge remains
  available to every team except whoever's DJing that turn.
- **No starting cards.** Every team (including solo "teams") begins a match with an empty
  timeline (`room.mtTeams[id].timeline = []`). Placing into an empty timeline always succeeds
  (there's nothing yet to be out of order with), so a team's very first card of the match is
  effectively free — it's the second and later cards, placed relative to what's already on the
  board, where correctness starts to matter.

## Phases

```
lobby (shared) → teamSelect (Team mode only) → ready → generating → placing → locked → revealed → (generating again | ready | gameover)
```

- **teamSelect** (Team mode only; skipped entirely in Solo mode): players claim teams; host
  presses Start once every chosen team has ≥1 connected player.
- **ready**: no turn is in progress; host presses "Start Match" / "Next Turn" to begin a turn for
  whoever's up.
- **generating**: server is asking ChatGPT for a song for the active team's turn — either their
  first song of the turn, or another one after they chose to keep drawing (see "Turn loop"
  below). Mirrors Imposter's `generating` phase and `failImposterRound` pattern exactly — on
  failure, revert to `ready`, emit an error, let the host retry. No song is revealed to anyone
  during this phase.
- **placing**: the song (and a YouTube search link) has been sent to the DJ team only (see "DJ
  team & song visibility" below); the active team sees their timeline (plus anything they've
  already collected but not yet banked this turn, see "Turn loop") and the BEFORE/BETWEEN/AFTER
  placement buttons, with no visibility into the song itself. Non-DJ, non-active teams (with a
  Challenge token available) see a "Challenge" option once a placement is locked, not before.
- **locked**: active team has tapped a placement slot. Placement is stored server-side,
  immutable. Non-active teams with a Challenge token available may challenge here (see
  "Challenge token" below); the host sees a "Reveal" button.
- **revealed**: host has tapped Reveal. True title/artist/year shown to everyone, correctness
  computed. What happens next depends on the outcome (see "Turn loop"): a wrong placement ends
  the turn immediately (discarding
  everything collected this turn) and shows "Next Turn"; a correct placement instead shows the
  active team a choice between drawing another song or stopping to bank what they've collected,
  and "Next Turn" only appears once that choice has been made. The match can end here if banking
  pushes a team to `MT_TARGET_CARDS`.
- **gameover**: final standings shown (teams ranked by card count), scoreboard updated. Host
  can press Play Again (→ fresh `ready`, same roster/teams) or Back to Lobby.

## Turn order

- Turn order cycles through teams in the order they were formed (Team A → B → C → D → A → ...),
  repeating indefinitely regardless of a turn's outcome — matches real HITSTER, where every team
  gets a turn each cycle whether or not their last turn went well.
- `room.mtActiveTeamIndex` tracks whose turn it is; advances by one (wrapping) only once a turn is
  actually **over** — i.e. the team got a placement wrong, or chose to stop and bank (see "Turn
  loop") — not after every individual correct placement, since a team can keep drawing within the
  same turn. Also advances past turns discarded via team-dropout auto-skip (see "Disconnect
  handling").

## Turn loop (push-your-luck)

A team's turn is not "one song, then done" — it keeps going, song after song, until the team
themselves decides to stop or they place one wrong:

- On a **correct** placement, the song is added to `room.mtTurnCollected`, a pending pile for the
  team's *current turn only* — not yet part of their real `timeline`, and not yet counted toward
  `MT_TARGET_CARDS`. The active team (any connected member, same authorization as placing) is
  then offered two choices:
  - **Draw Another Song** (`mtContinueTurn`): immediately triggers a new `generating` call for
    the same team, same turn. All previously-collected-but-unbanked cards for this turn stay in
    `mtTurnCollected` and are shown alongside the team's real timeline (marked as not yet banked)
    for the purposes of placing the next song, so slot choices stay consistent with what they've
    "seen" so far this turn.
  - **Stop & Keep Cards** (`mtStopTurn`): merges everything in `mtTurnCollected` into the team's
    real `timeline` (chronologically, same insertion logic as before), clears the pile, and ends
    the turn. This is the only way collected-but-unbanked cards become permanent.
- On an **incorrect** placement, the turn ends immediately: `mtTurnCollected` is discarded in
  full (including anything collected earlier in the same turn), the team's real `timeline` is
  untouched, and only "Next Turn" is available — there's no draw/stop choice on a miss.
- `room.mtTurnOver` (boolean) tracks whether the turn has reached one of its end states (wrong
  guess, or an explicit Stop) — the host's "Next Turn" button is only shown once it's `true`;
  while a correct-but-undecided turn is pending, only the active team's Draw/Stop choice is shown
  instead.
- If the active team fully disconnects while a draw/stop decision is pending (nobody left able to
  make the call), the server auto-stops on their behalf — banking whatever they'd collected so
  far rather than stalling the room (mirrors the existing team-dropout handling below).

## Turn actions

- **Any connected member of the active team** may tap a placement slot, and later, tap
  Draw-Another-Song or Stop-and-Keep — first tap wins for the whole team, no captain/leader role,
  no confirmation step from other members. Mirrors the party-game reality of a team huddled
  around one phone.
- The server authorizes by checking `socket.data.name`'s `player.team === room.mtActiveTeam`,
  same inline per-handler check pattern used everywhere else in this app (no shared middleware).

## Placement & correctness

Same algorithm as the original spec, computed server-side, never trusting the client — but
checked against the team's **effective timeline**: their real, banked `timeline` merged with
whatever's still sitting unbanked in `mtTurnCollected` for the current turn (see "Turn loop"), not
just the banked timeline alone:

```
newSong.year < firstTimelineSong.year
  OR newSong.year > lastTimelineSong.year
  OR timeline[i].year <= newSong.year <= timeline[i+1].year
```

- The team is shown their effective timeline as a sequence of years and chooses one of
  `effectiveTimeline.length + 1` slots (BEFORE first, BETWEEN each adjacent pair, AFTER last) —
  never told the exact year needed, only their own timeline's known years.
- Songs with the **same year** as an existing timeline card may be placed on either side of it;
  both are treated as correct.
- **Correct**: song is added to the turn's pending pile (`mtTurnCollected`), at the true
  chronological position within the effective timeline (not necessarily the slot boundary the
  team tapped, if a same-year tie made either side valid). It only reaches the team's real
  `timeline`, and only then counts toward `MT_TARGET_CARDS`, once the team stops (see "Turn
  loop").
- **Incorrect**: the song is discarded, and so is everything else the team collected this turn —
  none of it reaches the real timeline.
- Placement correctness is **always position-only**, at every difficulty — difficulty affects
  song obscurity (see above), never the correctness check.

## Token system

Every team (including solo "teams") starts a match with `MT_STARTING_TOKENS`, spent only on
Challenge (see below). There is no way to earn tokens back — no Skip, no Auto Card, no
artist/title bonus — so each team has a fixed, non-renewable budget of challenges for the whole
match. This is a deliberate simplification from an earlier version of this spec, which also had
a Skip token, an Auto Card token, and an honor-system artist/title bonus; all three were cut as
unnecessary complexity.

### Challenge token

- Available to **any non-active, non-DJ team** with a token balance ≥ `MT_CHALLENGE_COST`, only
  during the `locked` phase (placement locked, not yet revealed by the host) — the DJ team is
  excluded because they already know the real song (see "DJ team & song visibility" above).
  In a 2-team match this means Challenge is never available (the only non-active team is always
  the DJ team that turn).
- **First team to tap "Challenge" claims it** — other teams' Challenge buttons disable
  immediately once one team has claimed the slot for this placement. No host adjudication, no
  simultaneous multi-team challenges.
- The challenging team then picks their own placement slot (same BEFORE/BETWEEN/AFTER UI,
  applied to *their own* timeline, not the active team's).
- On reveal: the server checks both the original active team's placement AND the challenger's
  placement for correctness (each against their own respective timeline — the challenger's own
  *banked* timeline, not the active team's in-progress pile).
  - **Challenger correct**: the challenger claims the card straight into their own real timeline
    (card count +1 for them immediately, not added to any pending pile), no token cost — the
    original active team does not get the card even if their own placement also happened to be
    correct (challenge success takes the card). The active team's own turn otherwise proceeds
    normally off their own correctness — a successful challenge costs them this specific card,
    not their standing in the draw/stop decision.
  - **Challenger incorrect**: `MT_CHALLENGE_COST` is deducted from the challenger's tokens; the
    original active team's placement is scored normally (correct/incorrect against their own
    effective timeline, independent of the failed challenge) and, if correct, still goes to their
    pending pile as usual.

## Reveal flow

- After a placement is locked (`locked` phase), the host taps a **"Reveal"** button — not
  automatic. This is the same window in which non-active teams can challenge (see above), so the
  host controls the pacing of both the suspense and the challenge opportunity. The host doesn't
  need to know the song themselves to do this (they usually won't, unless their team happens to be
  DJing that turn) — they're trusted to reveal once the room verbally signals it's heard enough,
  same trust-based pacing model the rest of the app already uses.
- On Reveal: true title/artist/year broadcast to everyone, correctness computed for the active
  team (and the challenger, if any). A correct placement adds the card to the active team's
  pending pile and hands them the draw/stop decision; an incorrect one discards the pending pile
  outright. Either way the room sees the updated pending pile / real timeline reflected
  immediately.

## Winning

- The moment any team's **real, banked** card count reaches `MT_TARGET_CARDS`, the match ends
  immediately. Because cards from the current turn only become real when a team stops (see "Turn
  loop"), this check happens at the point of banking — an explicit Stop or a forced auto-stop from
  disconnection — not at every individual correct placement. A team sitting on an unbanked pile
  that would put them over the target if kept doesn't end the match until they actually choose to
  stop (or until they lose it all on a wrong guess first).
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
  pending song (added to `room.mtUsedSongs` so it's never re-offered) *and* discards
  `mtTurnCollected` (anything they'd collected but not yet banked this turn is lost along with
  it), advances `room.mtActiveTeamIndex` to the next team with ≥1 connected player, and
  immediately starts a new `generating` call for that team. No host intervention needed, mirrors
  this app's existing "disconnected players never block the room" philosophy (Menifot's
  auto-lock, 10 Seconds' auto-DNF).
- **The entire active team disconnects while their draw/stop decision is pending** (a correct
  placement was just revealed and nobody's left to choose): the server auto-stops on their
  behalf — banking `mtTurnCollected` into their real timeline exactly as if they'd tapped "Stop &
  Keep Cards" themselves — so the host's "Next Turn" button becomes available instead of the room
  stalling on a decision nobody can make.
- **The host disconnects mid-turn**: host handoff already reassigns `room.hostName` via the
  existing shared lobby mechanism. The pending song is unaffected either way, since visibility is
  computed per-viewer from `room.mtCurrentSong` and the current DJ team, not tied to whichever
  socket happens to be the host at the time.
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
  died before the response came back), `repairOnLoad` rolls back that one case to `ready` and
  clears `mtCurrentSong`/`mtPendingPlacement`/`mtCurrentChallenge` — an in-flight HTTP call
  genuinely cannot be resumed, but this is the only phase requiring rollback. `mtTurnCollected`
  is deliberately left untouched by this rollback: if the in-flight call was a mid-turn "draw
  another song" (the team had already banked nothing, chosen to continue), rolling back to
  `ready` without touching turn index or `mtTurnCollected` means the next "Next Turn" press
  resumes the *same* team's turn with their pending pile intact, rather than skipping to the next
  team or losing progress.

## Play Again / Back to Lobby

- **Back to Lobby** (host-only): returns everyone to the shared lobby / choose-a-game screen,
  roster intact. Clears all Music Timeline state (`room.mt*` fields).
- **Play Again** (host-only, from the gameover screen): re-snapshots whoever is currently
  connected as the new match roster, keeps existing team assignments where still valid (any
  team that's now empty is dropped, matching the team-select minimum), resets every team's
  timeline/card count/tokens to a fresh `MT_STARTING_TOKENS` and an empty timeline, clears
  `room.mtUsedSongs`, and returns to `ready`. No cross-match score carryover on the internal
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
- `room.mtTurnCollected`: array of `{ title, artist, releaseYear }` — the active team's
  push-your-luck pile for the *current turn only* (see "Turn loop"); merged into the team's real
  `timeline` on Stop, discarded on a wrong guess or team dropout, always reset to `[]` when a
  new team's turn begins.
- `room.mtTurnOver`: boolean — whether the current turn has reached an end state (wrong guess, or
  an explicit/forced Stop) and is just waiting on the host's "Next Turn". `false` while a
  draw/stop decision is pending after a correct placement.

`savedFields` for this module: at minimum `mtMode`, `mtDifficulty`, `mtTeams`,
`mtActiveTeamIndex`, `mtCurrentSong`, `mtUsedSongs`, `mtRoundNumber`, `mtTurnCollected`,
`mtTurnOver` — everything needed to resume a match exactly, per the restart-recovery design
above.

## Explicitly out of scope (v1)

- No in-app audio playback of any kind — the DJ team always plays music through their own
  separate device, following a plain YouTube search-results link. No YouTube Data API
  integration (no exact-video resolution), no Spotify integration, no OAuth, no `<audio>`
  element, no embedded player.
- No local/static song database — every song is a live ChatGPT call; no fallback source if
  `OPENAI_API_KEY` is missing or the API is down beyond the existing retry-on-failure UX.
- No free-text artist/title guessing, fuzzy string matching, or bonus for naming the song
  correctly — the only way to gain a card is a correct BEFORE/BETWEEN/AFTER placement.
- No exact-year guessing at any difficulty — placement is always by era (BEFORE/BETWEEN/AFTER),
  never a numeric year input.
- No per-room-configurable target card count, token costs, or team/player caps — code constants
  only, same as Menifot's `MF_TARGET_SCORE`.
- No captain/leader role for teams — any connected team member can act on their team's turn.
- No timer on placement, challenge, or reveal — every step is untimed and host/team-paced.
- No spectator mode beyond the standard "disconnected but still on the roster" handling already
  described.
- No anti-cheat beyond what this app already trusts elsewhere (players verbally agreeing on what
  they heard, the DJ team not saying the answer out loud) — consistent with the rest of the app's
  trust-based model.
