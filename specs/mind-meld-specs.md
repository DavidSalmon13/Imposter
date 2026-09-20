# Mind Meld — Specs

A same-room party game, guessing what's actually in a specific friend's head — not an objective
truth (unlike Kangaroo Court's trivia) and not a secret role (unlike Imposter). A rotating
Subject each round gets an absurd personalized estimation question, and everyone else tries to
model that one person's brain closely enough to out-guess the rest of the table.

## Relationship to existing games / shared app changes

- New option on the "Choose a game" screen: `room.game = 'mindmeld'`.
- Reuses the shared lobby, host concept (first joiner, reassigned on disconnect), room-code
  model, and the shared per-room `room.scoreboard` (see `scoreboard-specs.md`).
- Mid-game joins are blocked the same way as every other game: once the room leaves the shared
  lobby phase, new joiners get "Game in progress, wait for the next round."
- "Back to Lobby" returns everyone to the shared lobby / choose-a-game screen, keeping the
  roster/names intact, clearing only `room.mm*` state — same pattern as every other game.
- One LLM call per round (question generation only — unlike Imposter/Music Timeline, the LLM
  never supplies "the answer"; the Subject's own live submission is the answer), reusing the
  existing `chatCompletionJson()` helper and the rolling avoid-list pattern (`room.usedWords`,
  `room.mtUsedSongs`) as `room.mmUsedQuestions`.

## Configurable constants

Kept as named constants (matching `MF_MIN_PLAYERS` / `CN_MIN_PLAYERS` / `TS_MIN_PLAYERS` in
`server.js`) so the rules can be tuned later without touching game logic. Not exposed as
per-room host settings in v1 — code constants only, same precedent as every other game's
constants table.

| Constant | Value | Meaning |
|---|---|---|
| `MM_MIN_PLAYERS` | 3 | Floor to start a match — need at least 2 players besides the Subject for "closest" to mean anything |
| `MM_MAX_PLAYERS` | 10 | Ceiling on total connected players |
| `MM_ANSWER_TIME_MS` | 60000 | Countdown for non-Subject players to submit a guess |
| `MM_ROTATIONS_PER_MATCH` | 2 | Every player is Subject exactly this many times before the match ends |
| `MM_BULLSEYE_BONUS` | 2 | Extra points on top of rank points for an exact numeric match to the Subject's answer |
| `MM_USED_QUESTIONS_AVOID_WINDOW` | 30 | Recent questions sent to the LLM as a "don't repeat these" list |

## Phases

```
lobby (shared) → ready → pickingSubject → generating → answering → revealed → (pickingSubject again | gameover)
```

- **ready**: host presses "Start" / "Next Round". Host-only, same control-plane pattern as
  every other game.
- **pickingSubject**: instantaneous, server-only — advances the fair-rotation pointer (see
  "Subject selection" below) and moves straight to `generating`. No player-visible screen.
- **generating**: server is asking the LLM for this round's question. Mirrors Imposter's
  `generating` phase and `failImposterRound` pattern — on failure, revert to `ready`, emit a
  retryable error.
- **answering**: the question is shown to everyone, including the Subject. Every player sees a
  numeric input and a live countdown. Non-Subject players lose their input once their 60 seconds
  run out (or once they submit, whichever first); the Subject's input never disables itself, no
  matter how long they take (see "Timing" below).
- **revealed**: the Subject's number, everyone's guesses, computed percentage-differences, rank,
  and points-awarded-this-round are all shown together, plus the running match score. Host sees
  "Next Round".
- **gameover**: once `MM_ROTATIONS_PER_MATCH` full rotations have completed, final standings are
  shown and the scoreboard is updated. Host can press Play Again or Back to Lobby.

## Subject selection — fair rotation

- At match start (first "Start" press from lobby), the server shuffles the connected player
  roster once into `room.mmRotationOrder`. This order is frozen for the whole match, matching
  Menifot's "roster frozen at Start" precedent — players who join mid-match are blocked by the
  existing mid-game-join rule anyway.
- `room.mmRotationIndex` starts at 0 and advances by one (wrapping) after every round that
  actually resolves (see "Aborted rounds" under "Disconnect handling" for the one case where it
  does not advance).
- A full rotation = `room.mmRotationIndex` wrapping back to 0. The match ends once this has
  happened `MM_ROTATIONS_PER_MATCH` times.
- The Subject for a round is simply `room.mmRotationOrder[room.mmRotationIndex]`.

## Timing — asymmetric by design

- **Non-Subject players**: a single synchronized deadline, same mechanism as 10 Seconds
  (`room.mmAnswerDeadline = Date.now() + MM_ANSWER_TIME_MS`, broadcast once, every client derives
  its own countdown locally). Once a player's local clock passes the deadline without a
  submission, their input disables and they're simply excluded from that round's ranking — no
  penalty, matching 10 Seconds' "DNF" philosophy of never letting a slow player block the room.
- **The Subject**: no deadline. The round cannot resolve without the Subject's number (there is
  nothing to rank anyone against otherwise), so their input stays open indefinitely — same
  "correctness over pace" precedent as All-In-or-Fold's untimed decision phase. Other players'
  guesses that already came in during the 60-second window are simply held until the Subject
  submits, however long that takes.
- **Subject disconnects before submitting** (the one case an indefinite wait would actually
  break the room): the round is voided — nobody scores, `room.mmRotationIndex` still advances to
  the next Subject (the disconnected player doesn't get a free do-over of their turn later; they
  simply lose that turn's chance to be Subject), and the game moves straight to the next round's
  `generating` phase. This is the one case where a round resolves with zero points awarded to
  anyone.

## Question generation

- One LLM call per round: `generateMindMeldQuestion(room, subjectName) → { question: string }`.
  The question must be phrased as a request for a numeric estimate framed as that player's own
  opinion/estimate, not an objective fact — e.g. "How many apples does {name} think there are in
  the whole world?", "How many hours has {name} spent waiting in traffic in their life?", "How
  many push-ups does {name} think they could do right now?"
- **Content-safety guardrail specific to this game**: because every question names a real person
  in the room, the prompt must explicitly restrict topics to light, silly, harmless quantities —
  food, everyday objects, mundane life activities, playful physical feats, goofy hypotheticals.
  It must explicitly forbid anything touching weight/body image, money/income,
  relationships/dating history, health, family conflict, or anything that could read as an
  insult even framed as a joke. This is a stricter bar than Imposter/Codenames' general
  "family-friendly" constraint, because those games generate content about nobody in
  particular — this one is about a specific person sitting in the room. Reject-and-retry if the
  model's output fails a basic keyword/topic check.
- The question is sent to everyone at once (unlike Music Timeline's DJ-only visibility) —
  there's no secret to protect here, the only "hidden" thing is what number the Subject will
  actually pick, and that's inherent to the mechanic, not something the app needs to conceal.
- `room.mmUsedQuestions` rolling list (last `MM_USED_QUESTIONS_AVOID_WINDOW` question texts) sent
  to the LLM as an avoid-list, same shape as Imposter's `usedWords` / Music Timeline's
  `mtUsedSongs`.

## Answer input & number parsing

- A single numeric text field, not a slider — Fermi-estimate answers can range from single
  digits to the billions, and a slider can't span that range usefully.
- Accepted input formats, normalized server-side into a canonical non-negative integer before
  any comparison:
  - Plain digits, with or without comma separators (`1000000`, `1,000,000`)
  - Decimal shorthand with a magnitude suffix: `5k`, `2.5m`, `1.2b` (case-insensitive k/m/b)
  - Spelled-out magnitude words: `5 thousand`, `2.5 million`, `1.2 billion`
- Negative numbers are rejected (every question is framed as a countable quantity ≥ 0).
- A hard ceiling (e.g. `10^15`) rejects obvious troll input ("a billion billion billion") with a
  friendly inline error, rather than letting it silently break the percentage-difference math.
- Non-numeric junk shows an inline "please enter a number" error and does not submit.

## Scoring — ranked by percentage closeness

1. Once the Subject's number is in and every non-Subject player has either submitted or timed
   out, compute each remaining player's percentage difference from the Subject's number:
   `pctDiff = |guess − target| / |target| × 100`.
   - Edge case, target = 0: percentage difference is undefined when the Subject's answer is
     literally zero. For that one round only, fall back to ranking by plain absolute difference
     instead (`|guess − target|`) rather than percentage.
2. Sort ascending by `pctDiff` (or absolute difference in the target-zero case) — smallest is
   closest, ranked 1st.
3. Points descend by rank: with N total players (so N − 1 ranked, non-Subject players), 1st gets
   N − 1 points, 2nd gets N − 2, … last gets 1.
4. Ties (identical `pctDiff`, e.g. two players guess numbers exactly equidistant in percentage
   terms) share the same rank and the same points; the next distinct rank skips accordingly —
   same tie convention every other game in this app already uses (e.g., two players tied for 2nd
   both get N − 2 points, and the next player is ranked 4th, not 3rd).
5. **Bullseye bonus**: any player whose guess exactly equals the Subject's number (after
   normalization — `5m` and `5000000` count as the same value) gets `MM_BULLSEYE_BONUS` added on
   top of their rank points. Multiple simultaneous bullseyes are each awarded the bonus
   independently — the bonus is per-player, not a single claimable prize.
6. The Subject scores 0 that round, always — they supplied the benchmark, they weren't ranked
   against it.

### Worked example round

Table: Yossi, Maya, Tom, Noa, Ariel (5 players, so N = 5, N − 1 = 4 ranked players).

Subject this round: Tom (his turn in the rotation order).

Generated question (shown to everyone, including Tom):

> "How many hours does Tom think he's spent scrolling on his phone this year?"

Answering phase — 60-second countdown starts for everyone except Tom:

| Player | Submitted | Notes |
|---|---|---|
| Tom (Subject) | 900 | No timer — this becomes the target |
| Noa | 950 | |
| Yossi | 1,200 | |
| Maya | 500 | |
| Ariel | 10,000 | typed "10k" |

Scoring — percentage difference from Tom's 900:

| Player | Guess | \|diff\| | % diff | Rank |
|---|---|---|---|---|
| Noa | 950 | 50 | 5.6% | 1st |
| Yossi | 1,200 | 300 | 33.3% | 2nd |
| Maya | 500 | 400 | 44.4% | 3rd |
| Ariel | 10,000 | 9,100 | 1,011.1% | 4th |

Points awarded (1st = N − 1 = 4, descending):

| Player | Rank points | Bullseye? | Total this round |
|---|---|---|---|
| Noa | 4 | No | 4 |
| Yossi | 3 | No | 3 |
| Maya | 2 | No | 2 |
| Ariel | 1 | No | 1 |
| Tom (Subject) | — | — | 0 |

Rotation advances to the next player in `mmRotationOrder`. Match score is now Noa 4, Yossi 3,
Maya 2, Ariel 1, Tom 0, carried forward into the next round.

### Supplementary mini-examples (edge cases)

- **Tie**: if Yossi had also guessed 950 (tied with Noa at 5.6%), both share 1st place and both
  get 4 points; Maya moves to 3rd (2 points) and Ariel to 4th (1 point) — the rank that would
  have been "2nd" is skipped entirely, nobody gets 3 points that round.
- **Bullseye**: if Noa had guessed exactly 900 (not 950), she'd still rank 1st for 4 points, plus
  the `MM_BULLSEYE_BONUS` of 2 — 6 points total for that round.
- **Target = 0**: if the question were "How many times has Tom been late to work this month?"
  and Tom answers 0, percentage difference is undefined for every guess — that round falls back
  to ranking by plain absolute difference instead (closest raw guess to 0 wins).
- **Voided round**: if Tom disconnects mid-answering before submitting anything, the round ends
  with no scores awarded to anyone, and rotation moves straight to the next Subject.

## Match end & scoreboard integration

- The match ends the moment `room.mmRotationIndex` completes its `MM_ROTATIONS_PER_MATCH`-th
  full wrap (i.e., every player has been Subject exactly twice).
- Rank every player by cumulative round points across the whole match, descending. Standard
  competition ranking, same as every other game: 1st gets N scoreboard points (N = number of
  players in the match), 2nd gets N − 1, and so on; ties share rank and points, next rank skips
  accordingly.
- Points are added to `room.scoreboard[name]`, same mechanism every other game uses (see
  `scoreboard-specs.md`).

## Disconnect handling

- **Non-Subject player disconnects during `answering`**: treated exactly like a timeout — simply
  excluded from that round's ranking, no penalty, round proceeds normally once the Subject
  submits.
- **Subject disconnects during `answering`**: round voided, no scoring, rotation advances to the
  next Subject (see "Timing" above) — this is the one deliberate exception to "the Subject holds
  up the round indefinitely."
- **A player disconnects and never returns for the rest of the match**: their spot in
  `room.mmRotationOrder` is not removed — when their turn comes up again (2nd rotation), the same
  disconnect-voids-the-round handling above fires again. Matches this app's established "don't
  reshuffle match structure around a dropped connection" precedent (Menifot's frozen roster,
  Music Timeline's permanently-gone team).
- **Host disconnects**: standard host handoff via the existing shared lobby mechanism —
  unaffected by whatever phase Mind Meld is currently in.

## Play Again / Back to Lobby

- **Back to Lobby** (host-only, any time): returns everyone to the shared lobby / choose-a-game
  screen, roster intact. Clears all `room.mm*` state.
- **Play Again** (host-only, from `gameover`): re-snapshots whoever is currently connected as the
  new match roster, reshuffles a fresh `room.mmRotationOrder`, resets all round scores to zero,
  clears `room.mmUsedQuestions`, returns to `ready`. No cross-match score carryover, matching
  every other game's full-reset-on-replay pattern.

## Server state additions (`room.mm*`)

- `room.mmRotationOrder`: frozen shuffled array of player names, set once at match start.
- `room.mmRotationIndex`: pointer into the rotation order; current Subject is
  `mmRotationOrder[mmRotationIndex]`.
- `room.mmRoundNumber`: increments each round that actually resolves (voided rounds still
  advance rotation but are worth noting separately if a round-history view is ever added).
- `room.mmCurrentQuestion`: the current round's question text, or `null` between rounds.
- `room.mmAnswerDeadline`: epoch ms deadline for non-Subject players, or `null`.
- `room.mmAnswers`: map of name → submitted number for the current round (includes the
  Subject's).
- `room.mmUsedQuestions`: rolling list of recent question texts, windowed at
  `MM_USED_QUESTIONS_AVOID_WINDOW`.
- `room.mmScores`: name → cumulative points across the current match.
- `room.mmRotationsCompleted`: integer, increments each time `mmRotationIndex` wraps to 0.

`savedFields` for this module: `mmRotationOrder`, `mmRotationIndex`, `mmRoundNumber`,
`mmUsedQuestions`, `mmScores`, `mmRotationsCompleted` — enough to resume a match between rounds
after a restart. `mmCurrentQuestion` / `mmAnswerDeadline` / `mmAnswers` are in-flight round
state, safe to discard and roll back to `ready` on restart, same simplification Menifot and
Music Timeline's `generating` rollback already use.

## Explicitly out of scope (v1)

- No free-text or multiple-choice answers — always a single numeric estimate.
- No per-room-configurable rotation count, timer length, or bonus values — code constants only,
  same precedent as every other game's constants table.
- No spectator mode beyond "disconnected but still on the roster."
- No anti-cheat on the answering phase (nothing stops players from discussing guesses out loud
  before submitting) — same trust-based model as the rest of the app.
- No sudden-death tiebreaker at match end — ties share rank and points, standard convention.
- No question categories/topic voting (unlike Kangaroo Court) — the LLM picks the topic per
  round; the personalization to a named player is what keeps it varied, not a category system.
