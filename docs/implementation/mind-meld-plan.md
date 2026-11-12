# Mind Meld: Implementation Plan

Turns `../specs/mind-meld-specs.md` into code. That spec is the source of truth for *rules*
(what the game does); this doc is the source of truth for *how it gets built* — concrete file
names, function names, event names, and a step order that keeps every step browser-testable per
this repo's testing convention (`CLAUDE.md` — no automated suite, verify by playing the affected
flow in a browser after every change).

Read `../specs/mind-meld-specs.md` in full before starting Step 1 — this doc assumes its content
and doesn't repeat rule details (scoring math, the content-safety guardrail, disconnect
philosophy, etc.), only where in the code they land.

## Target files

**New:**
- `server/games/mindMeld.js` — the game module (contract shape per `refactor_plan.md` §4).
- `public/js/games/mindMeld.js` — the client module (`init`/`applyState`/`applyJoin`/`stop`
  shape, matching every other game module, e.g. `public/js/games/tenseconds.js`).

**Touched:**
- `server/roomStore.js` — add `mm*` fields to `createRoomState()`, plus a Mind Meld phase-enum
  comment line alongside the existing per-game ones.
- `server/gameRegistry.js` — `require('./games/mindMeld')` and add `mindmeld` to the `GAMES` map.
- `public/index.html` — new `#mm-screen` section + a "Mind Meld" tile on the choose-game screen.
- `public/js/main.js` — import the new client module, add it to the `GAMES` map, wire the
  choose-game button/handler (`socket.emit('chooseGame', 'mindmeld', ...)`, mirrors the other
  five), add `MM_MIN_PLAYERS` to `renderLobby`'s tile-enable/underfilled logic.
- `public/style.css` — `mm-*` classes, styled consistently with the app's current look.
- `public/js/shared/format.js` — optional: a `formatMmNumber` display helper (comma-grouped,
  e.g. `1,200`) if not just reusing `toLocaleString()` inline.

## Event & function naming reference

Follow the existing per-game prefix convention exactly (`mf*`/`ts*`/`mt*` → `mm*` here).

**Socket events (server → client):**
- `mmState` — full personalized state broadcast (mirrors `tensSecondsState`/`menifotState`),
  built by `mmStatePayload(ctx, room, viewerName)`, one function, called from every mutating
  handler and from `reconnectPayload`.
- `generating` — **reused as-is**, the app-wide event already listened for in `main.js`
  (`socket.on('generating', ({ game }) => showGenerating(game))`); confirm `shared/dom.js`'s
  `showGenerating` handles an arbitrary game id generically, or add a Mind Meld branch/label
  ("Thinking of a question for `<subject>`...").
- `startFailed` — **reused as-is** for the OpenAI-failure retry path, same event Imposter/Music
  Timeline already use.

**Socket events (client → server), all with `(data, callback)` ack shape like every other game:**
- `startMindMeld` — host-only, `ready` phase only. Validates `MM_MIN_PLAYERS`–`MM_MAX_PLAYERS`
  and full connectivity, shuffles `room.mmRotationOrder`, resets `mmRotationIndex`/`mmScores`/
  `mmRotationsCompleted`/`mmRoundNumber`, then starts round 1 (`pickingSubject` → `generating`).
- `submitMmAnswer` — `{ raw }`, any player whose input is still open (the Subject always; a
  non-Subject player only before their deadline and before they've already submitted),
  `answering` phase only. Parses/validates server-side (see Step 4), stores into
  `room.mmAnswers`, then calls `maybeResolveMmRound`.
- `mmNextRound` — host-only, `revealed` phase only. Advances the rotation pointer; if that
  completes the `MM_ROTATIONS_PER_MATCH`-th wrap, ends the match (`awardMmScoreboard` +
  `gameover`); otherwise starts the next round (`pickingSubject` → `generating`) directly —
  per the spec's phase diagram, subsequent rounds do **not** pass back through a visible `ready`
  screen, only the very first round does.
- `playAgainMindMeld` — host-only, `gameover` phase. Re-snapshots the connected roster, fresh
  shuffle, resets scores, back to `ready`.
- Back to Lobby reuses the app's existing shared `backToLobby` handler (no per-game event needed
  — `gameRegistry.clearAllGameState` calls `mindMeld.clearState`).

**Server-side functions in `server/games/mindMeld.js`** (names below are the plan's suggestion,
not a hard requirement — keep them consistent with this list so the module reads like its
siblings):
- `generateMindMeldQuestion(room, subjectName)` — the ChatGPT call, mirrors
  `generateWordAndHint(room, level)` in `imposter.js`: builds the avoid-list from
  `room.mmUsedQuestions.slice(-MM_USED_QUESTIONS_AVOID_WINDOW)`, calls `chatCompletionJson(prompt)`
  from `server/lib/openai.js`, returns `{ question }`. The prompt encodes the content-safety
  guardrail from the spec (allowed topics vs. explicitly forbidden ones) directly in its
  instructions.
- `questionPassesContentCheck(question)` — pure function, a basic keyword/topic denylist check
  (weight/body, money/income, relationships/dating, health, family conflict, insult-adjacent
  phrasing) run against the model's output before accepting it. Write this standalone (no
  `room`/`ctx` argument) so it's trivially unit-testable, matching this repo's own precedent
  (`refactor_plan.md` §8) for pure validation functions. `generateMindMeldQuestion` retries (small
  fixed cap, e.g. 3 attempts) on failure, then throws to let the caller's try/catch trigger
  `failMmRound`.
- `parseMmNumber(raw)` — pure function implementing the spec's "Answer input & number parsing"
  section: strips commas, matches `k`/`m`/`b` suffixes and spelled-out `thousand`/`million`/
  `billion` (case-insensitive), rejects negatives and non-numeric junk, rejects anything above the
  hard ceiling (`MM_MAX_ANSWER_VALUE = 1e15`), returns a canonical non-negative integer or `null`
  on failure. Pure and dependency-free — the other function worth unit-testing later.
- `computeMmRanking(target, answers)` — pure function: `answers` is `{ name: number }` (already
  excludes the Subject), `target` is the Subject's number. Returns an array of
  `{ name, guess, pctDiff, rank, points, bullseye }`, implementing the spec's percentage-diff
  sort, the `target === 0` fallback to absolute difference, standard-competition tie/rank-skip,
  and the bullseye bonus. Pure, no `room`/`ctx` — the highest-value function to keep
  test-friendly, mirrors `imposterPointsFor`/`mfAllocationValid`'s role in their games.
- `mmStatePayload(ctx, room, viewerName)` — personalized state: current question (visible to
  everyone once generated, per spec — no per-viewer hiding), whether `viewerName` is the Subject,
  own submitted answer if any, deadline, and (only in `revealed`) the full breakdown from
  `computeMmRanking` plus running match scores; (only in `gameover`) final standings +
  `ctx.scoreboardEntries(room)`.
- `broadcastMm(ctx, roomCode, room)` — iterates `room.players`, emits personalized `mmState` per
  connected socket, mirrors `broadcastTensSeconds`/`broadcastMenifot`.
- `failMmRound(ctx, roomCode, room, error)` — mirrors `failImposterRound`/Music Timeline's
  equivalent: on a `generateMindMeldQuestion` failure, revert `phase` to `ready` (first round) —
  see Step 3 for the "which phase to revert to" nuance on later rounds — and emit `startFailed`.
- `startMmRound(ctx, roomCode, room)` — the `pickingSubject` → `generating` step: reads the
  current Subject off `room.mmRotationOrder[room.mmRotationIndex]`, sets `phase = 'generating'`,
  broadcasts `generating`, calls `generateMindMeldQuestion`, on success sets
  `mmCurrentQuestion`/`mmAnswerDeadline`/clears `mmAnswers`, `phase = 'answering'`, schedules the
  deadline timer (see below), broadcasts; on failure calls `failMmRound`.
- `scheduleMmDeadlineHandle(ctx, roomCode, room)` / `clearMmDeadlineHandle(roomCode)` — a
  module-local `Map<roomCode, Timeout>` (mirrors `tsForceStopHandles` in `tenseconds.js`). At
  `room.mmAnswerDeadline`, non-Subject submissions stop being accepted (checked in
  `submitMmAnswer` itself, not just the timer); the timer's only job is to call
  `maybeResolveMmRound` in case the Subject already answered but the round is still waiting on
  the clock rather than on stragglers.
- `submitMmAnswer(ctx, roomCode, room, name, raw)` — validates phase/identity, applies
  `parseMmNumber`, rejects late non-Subject submissions (`Date.now() >= mmAnswerDeadline`) and
  duplicate submissions, stores into `room.mmAnswers`, broadcasts, calls `maybeResolveMmRound`.
- `maybeResolveMmRound(ctx, roomCode, room)` — resolves once the Subject has answered **and**
  either every currently-connected non-Subject active player has also answered (early resolve,
  mirrors `maybeResolveTsRound`'s "all contenders in" early-finish) **or** the deadline has
  passed. Otherwise no-op.
- `resolveMmRound(ctx, roomCode, room)` — clears the deadline handle, runs `computeMmRanking`,
  applies points via `ctx.addScore`-equivalent into `room.mmScores` (not the shared scoreboard —
  that only happens at match end, see below), stores the breakdown for the `revealed` payload,
  `phase = 'revealed'`, `room.mmRoundNumber += 1`, broadcasts.
- `advanceMmRotation(room)` — `room.mmRotationIndex = (room.mmRotationIndex + 1) % room.mmRotationOrder.length`;
  if it wrapped to 0, `room.mmRotationsCompleted += 1`. Returns whether the match is now complete
  (`mmRotationsCompleted >= MM_ROTATIONS_PER_MATCH`).
- `voidMmRound(ctx, roomCode, room)` — the Subject-disconnect path: clears `mmAnswers`/
  `mmCurrentQuestion`/`mmAnswerDeadline` and the deadline handle **without** calling
  `resolveMmRound` (so nobody scores), then runs the same rotation-advance + continue-or-end logic
  `mmNextRound` uses (see Step 7 for whether a voided round can itself complete the match — call
  this out explicitly, the spec doesn't state it outright but the rotation is what defines match
  length, so treat a wrap during a voided round as ending the match too).
- `awardMmScoreboard(ctx, room)` — ranks `room.mmScores` descending, standard competition
  ranking/ties (mirrors `awardMenifotScoreboard`), fans points into `room.scoreboard[name]` via
  `ctx.addScore`.

## Server state additions

Full field list and purposes are already specified in `../specs/mind-meld-specs.md` under "Server
state additions" — add exactly those fields (`mmRotationOrder`, `mmRotationIndex`,
`mmRoundNumber`, `mmCurrentQuestion`, `mmAnswerDeadline`, `mmAnswers`, `mmUsedQuestions`,
`mmScores`, `mmRotationsCompleted`) to `createRoomState()` in `roomStore.js`, grouped under a
`// Mind Meld` comment block like the existing `// Menifot` block, plus a phase-enum comment line:

```js
// Mind Meld phases: 'ready' | 'pickingSubject' | 'generating' | 'answering' | 'revealed' | 'gameover'
```

(`pickingSubject` is instantaneous and server-only per the spec — it may never actually be
observable as a broadcast `phase` value if `startMmRound` folds straight through to `generating`
in the same tick; keep the enum comment for documentation even if no client branch ever renders
it.)

## Implementation order

Work through this as a stack of small, independently browser-verifiable steps — not one big PR.
Each item is a checkbox.

**Convention (same as `refactor_plan.md` §7 / `music-timeline-plan.md`): find the first `- [ ]`
item, implement only that one, verify it in a real browser per its Verify note, then flip it to
`- [x]`. Don't start the next box in the same pass.** After every step, also spot-check that the
other five games still work (choose game → play → back to lobby), since `roomStore.js`/
`gameRegistry.js`/`main.js` are shared files.

- [x] **Step 1 — Server scaffolding + empty screen.** Add the `mm*` fields to
  `createRoomState()`. Create `server/games/mindMeld.js` with the full contract shape
  (`id: 'mindmeld'`, `minPlayers: MM_MIN_PLAYERS`, `maxPlayers: MM_MAX_PLAYERS`, `savedFields`, a
  minimal `onChoose` that just sets `phase = 'ready'` and broadcasts, a no-op
  `registerHandlers`/`reconnectPayload`/`onDisconnect`/`clearState`). Add it to
  `gameRegistry.js`'s `GAMES` map. Add `#mm-screen` to `index.html` (bare-bones: a "Mind Meld
  (under construction)" heading + the standard `mm-back-btn` "Back to Lobby" button). Create
  `public/js/games/mindMeld.js` exporting `{ init, applyJoin, applyState, stop }` (`applyState`
  can just call `showScreen('mindMeld')` for now). Wire into `main.js`: import, add to `GAMES`,
  add a "Mind Meld" choose-game tile + handler, add `MM_MIN_PLAYERS` to `renderLobby`'s
  tile-enable logic. **Verify:** from the lobby, tapping "Mind Meld" navigates to the stub screen;
  "Back to Lobby" returns cleanly; all five other games still work.

- [x] **Step 2 — Match start + fair rotation.** Implement `startMindMeld`'s handler: host-only,
  `ready`-only, roster-size validation, shuffles the connected roster into `room.mmRotationOrder`
  (reuse `shuffle` from `server/lib/shuffle.js`), zeroes `mmRotationIndex`/`mmScores`/
  `mmRotationsCompleted`/`mmRoundNumber`. For this step, stub `startMmRound` to just set
  `phase = 'answering'` with a placeholder question string (real LLM call comes in Step 3) so the
  rotation logic is verifiable in isolation. Client: `ready` screen listing the roster and a
  host-only "Start" button; a bare-bones `answering` screen that just shows the current Subject's
  name and the placeholder question text to everyone. **Verify:** with 3+ tabs, confirm Start
  shuffles a stable order (log/inspect if needed), confirm the correct name is shown as Subject.

- [x] **Step 3 — Question generation plumbing.** Implement `generateMindMeldQuestion` using
  `chatCompletionJson` from `server/lib/openai.js`, with the avoid-list built from
  `room.mmUsedQuestions` and the content-safety instructions from the spec baked into the prompt.
  Implement `questionPassesContentCheck` and wire the reject-and-retry loop. Replace the Step 2
  placeholder in `startMmRound` with the real call: `generating` phase + broadcast while awaiting
  OpenAI, `answering` + real question on success, `failMmRound` on failure (mirrors
  `finishVoting`'s try/catch in `imposter.js`). Push the accepted question onto
  `room.mmUsedQuestions`, windowed at `MM_USED_QUESTIONS_AVOID_WINDOW`. Decide and implement where
  a failure reverts to: first-round failures revert to `ready`; a failure on `mmNextRound` (later
  rounds) should revert to `revealed` (the last-good state) rather than a `ready` screen that
  doesn't otherwise exist mid-match — make `failMmRound` phase-aware or pass the fallback phase
  in. **Verify:** start a match, confirm a real personalized question appears naming the correct
  Subject and reads as an estimate question; temporarily unset `OPENAI_API_KEY` to confirm the
  failure path reverts cleanly with a retryable error instead of hanging.

- [x] **Step 4 — Answering UI + number parsing + submission.** Implement `parseMmNumber` (pure,
  covers plain digits/commas, `k`/`m`/`b` suffixes, spelled-out magnitudes, negative rejection,
  ceiling rejection). Client: numeric text input shown to everyone in `answering`; the Subject's
  input has no visible countdown and never disables; non-Subject players see a live countdown
  derived from `mmAnswerDeadline` (same client pattern as 10 Seconds' `roundStartAt` countdown)
  and their input disables locally at zero. Server: `submitMmAnswer` handler — phase check,
  identity check, late-submission rejection for non-Subject players past the deadline, duplicate
  rejection, `parseMmNumber` validation with an inline error passed back through the ack callback,
  store into `room.mmAnswers`, broadcast. Implement `scheduleMmDeadlineHandle` and wire it into
  `startMmRound`. Leave `maybeResolveMmRound`/`resolveMmRound` as no-ops or console-log stubs for
  now — scoring lands in Step 5. **Verify:** as the Subject, confirm the input stays live well
  past 60 seconds; as a non-Subject player, confirm the countdown ticks and the input disables at
  zero and a late submit attempt is rejected; try `5k`, `2.5m`, `1,200`, `-5`, `abc`, and a number
  above the ceiling — confirm exactly the valid ones submit.

- [x] **Step 5 — Round resolution & scoring.** Implement `computeMmRanking` (pure) covering the
  percentage-diff sort, the `target === 0` absolute-difference fallback, tie/rank-skip, and the
  bullseye bonus. Wire `maybeResolveMmRound`/`resolveMmRound` for real: resolve once the Subject
  has answered and (all currently-connected non-Subject active players have answered, or the
  deadline has passed). Client: `revealed` screen — table of every guess with rank/%-diff/points,
  bullseye indicator, running match score (`room.mmScores`), host-only "Next Round" button (stub
  it to just log for now; wired for real in Step 6). **Verify:** run a full round end-to-end with
  3+ players including at least one who lets the timer expire (confirm they're excluded from
  ranking, not penalized), one who guesses the exact target (confirm the bullseye bonus applies),
  and — if convenient to test — a round where the Subject's answer is `0` (confirm the
  absolute-difference fallback kicks in instead of a divide-by-zero/`Infinity` result).

- [x] **Step 6 — Rotation continuation, match end, scoreboard, Play Again.** Implement
  `advanceMmRotation` and the `mmNextRound` handler: host-only, `revealed`-only, advances the
  pointer, and either starts the next round (`startMmRound`) or — once
  `mmRotationsCompleted >= MM_ROTATIONS_PER_MATCH` — calls `awardMmScoreboard` and moves to
  `gameover`. Implement `awardMmScoreboard` (rank `room.mmScores` descending, standard competition
  ranking/ties, fan into `room.scoreboard[name]`). Client: `gameover` screen (final standings,
  updated scoreboard via the shared `renderScoreboard` helper), `playAgainMindMeld` handler
  (re-snapshot connected roster, fresh shuffle, reset scores/`mmUsedQuestions`, back to `ready`).
  Add `clearState` to fully wipe `mm*` fields for Back to Lobby. **Verify:** play a full match to
  completion (every player Subject exactly `MM_ROTATIONS_PER_MATCH` times — count rounds),
  confirm the match ends exactly on the final wrap (not one round early/late), confirm scoreboard
  points match the ranking/tie rules, confirm Play Again produces a clean fresh match, confirm
  Back to Lobby fully clears state (rejoin and choose Mind Meld again from scratch to double
  check).

- [x] **Step 7 — Disconnect handling.** Implement `onDisconnect`: if the disconnecting player is
  the Subject during `answering`, call `voidMmRound` (clears round state without scoring, advances
  rotation, either starts the next round or ends the match on a completing wrap — see the note on
  this in the function list above); if a non-Subject player disconnects during `answering`, no
  special action needed beyond the existing "excluded if they never submit" path (their
  disconnection is already indistinguishable from "never got around to answering" for scoring
  purposes) — just re-broadcast so `waitingOn`-style UI (if any) updates. Implement
  `onReconnectBroadcast` to just re-send `mmState`. Confirm host handoff (already generic, handled
  by `lobby.js`) needs no special-casing. `repairOnLoad`: for `phase === 'generating'`, roll back
  to whatever `failMmRound`'s Step-3 fallback phase would be (an in-flight OpenAI call can't be
  resumed); `answering`/`revealed` resume as normal persisted state. **Verify:** disconnect the
  current Subject mid-`answering` and confirm the round voids with no points awarded and the next
  Subject's question generates automatically; disconnect a non-Subject player mid-`answering` and
  confirm the round still resolves normally once the Subject answers; restart the dev server
  (`Ctrl+C`/`npm start`) mid-`generating` and confirm the room resumes cleanly on reload.

- [x] **Step 8 — Visual polish + full regression.** Style `mm-*` elements in `style.css` to match
  the app's current look (ready/answering/revealed/gameover panels, the numeric input, the
  ranking table, bullseye badge). Confirm the existing global click-sound/haptics listener in
  `main.js` covers all new buttons (it's a generic `document.addEventListener('click', ...)` on
  any `<button>`, so this should be automatic — just verify no dead zones). Final full regression:
  play all seven games back-to-back in one sitting per `CLAUDE.md`'s testing convention, plus one
  disconnect/reconnect per game.

## Testing notes

No automated suite exists (per `CLAUDE.md`); this plan leans on the same manual-QA convention
every other game in this repo uses. Three pure functions are worth keeping test-friendly even
without a runner yet, per `refactor_plan.md` §8's own reasoning ("cheapest to unit test, highest
value since they're the easiest to silently break"):

- `parseMmNumber(raw)` — no `room`/`ctx`/socket dependency, clear edge cases (commas, k/m/b,
  spelled-out magnitudes, negatives, the ceiling, junk input).
- `computeMmRanking(target, answers)` — pure ranking/scoring math, including the `target === 0`
  fallback, ties, and bullseye — the single highest-value function to get right since it's the
  entire scoring model.
- `questionPassesContentCheck(question)` — pure keyword/topic guardrail, worth a few explicit
  positive/negative test cases given it's the one safety-relevant piece of this game.

## Out of scope

Everything already listed in `../specs/mind-meld-specs.md`'s own "Explicitly out of scope (v1)"
section applies here unchanged — this plan doesn't add scope beyond that spec, only sequences
building it.
