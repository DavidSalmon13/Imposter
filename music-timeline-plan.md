# Music Timeline: Implementation Plan

Turns `specs/music-timeline-specs.md` into code. That spec is the source of truth for *rules*
(what the game does); this doc is the source of truth for *how it gets built* — concrete file
names, function names, event names, and a step order that keeps every step browser-testable per
this repo's testing convention (`CLAUDE.md` — no automated suite, verify by playing the affected
flow in a browser after every change).

Read `specs/music-timeline-specs.md` in full before starting Step 1 — this doc assumes its
content and doesn't repeat rule details (correctness algorithm, token costs, disconnect
philosophy, etc.), only where in the code they land.

## Target files

**New:**
- `server/games/musicTimeline.js` — the game module (contract shape per `refactor_plan.md` §4).
- `public/js/games/musicTimeline.js` — the client module (`init`/`applyState`/`applyJoin`/`stop`
  shape, matching every other game module).

**Touched:**
- `server/roomStore.js` — add `mt*` fields to `createRoomState()`.
- `server/gameRegistry.js` — add `musictimeline` to the `GAMES` map.
- `public/index.html` — new `#mt-screen` section + a "Music Timeline" button on the choose-game
  screen.
- `public/js/main.js` — import the new client module, add it to the `GAMES` map, wire the
  choose-game button, add `MT_MIN_PLAYERS` to the lobby button-enable logic.
- `public/style.css` — `mt-*` classes, styled consistently with the existing poker-table
  restyle (see `9800b93 Restyle Menifot boards and cards as a poker table`).

## Event & function naming reference

Follow the existing per-game prefix convention exactly (`mf*`/`cn*`/`ts*`/`kr*` → `mt*` here).

**Socket events (server → client):**
- `mtState` — full personalized state broadcast (mirrors `menifotState`/`tensSecondsState`),
  built by `mtStatePayload(ctx, room, viewerName)`, one function, called from every mutating
  handler and from `reconnectPayload`.
- `mtTeamSelectUpdate` — separate event during `teamSelect` phase only, mirrors Codenames'
  `teamSelectUpdate` (`{ teams: [{ id, name, members: [...] }], mode, difficulty }`).
- `generating` — **reused as-is**, the app-wide event already listened for in `main.js`
  (`socket.on('generating', ({ game }) => showGenerating(game))`); Music Timeline just needs a
  `showGenerating` case that works for it (check `shared/dom.js`'s `showGenerating` — confirm it
  either already handles arbitrary game ids generically or add a Music Timeline branch).
- `startFailed` — **reused as-is** for the OpenAI-failure retry path, same event Imposter already
  uses.

**Socket events (client → server), all with `(data, callback)` ack shape like every other game:**
- `setMtMode` — `'team' | 'solo'`, host-only, `teamSelect`/pre-start only.
- `setMtDifficulty` — `'easy' | 'pro' | 'expert'`, host-only, pre-start only.
- `setMtTeamCount` — 2–4, host-only, Team mode + pre-start only.
- `joinMtTeam` — `{ teamId }`, any player, `teamSelect` phase, Team mode only.
- `startMusicTimeline` — host-only, validates roster/team minimums, deals starting cards, moves
  to `ready`.
- `mtNextTurn` — host-only, `ready` or post-`revealed` → triggers `generating` for the active
  team.
- `mtPlaceSong` — `{ slotIndex }`, active-team-member-only, `placing` phase → locks into `locked`.
- `mtSkipSong` — active-team-member-only, `placing` phase, before lock → discards + re-triggers
  `generating`.
- `mtAutoCard` — active-team-member-only, `placing` phase, before lock → auto-resolves the turn.
- `mtChallenge` — non-active-team-member-only, `locked` phase → claims the challenge slot.
- `mtChallengePlace` — `{ slotIndex }`, the claiming challenger only, after `mtChallenge` →
  locks the challenger's own guess.
- `mtReveal` — host-only, `locked` phase → the reveal itself.
- `mtConfirmId` — host-only, at/after `revealed` → checkbox toggle, awards the ID token.
- `playAgainMusicTimeline` — host-only, `gameover` phase.
- Back to Lobby reuses the app's existing shared `backToLobby` handler (no per-game event needed
  — `gameRegistry.clearAllGameState` calls `musicTimeline.clearState`).

**Server-side functions in `server/games/musicTimeline.js`** (names below are the plan's
suggestion, not a hard requirement — keep them consistent with this list so the module reads
like its siblings):
- `generateMusicTimelineSong(room, difficulty)` — the ChatGPT call, mirrors
  `generateWordAndHint(room, level)` in `imposter.js`: builds the avoid-list from
  `room.mtUsedSongs.slice(-MT_USED_SONGS_AVOID_WINDOW)`, calls `chatCompletionJson(prompt)`,
  returns `{ title, artist, releaseYear }`.
- `dealStartingCards(ctx, room)` — one `generateMusicTimelineSong` call per team at Start.
- `checkPlacement(timeline, releaseYear)` — pure function implementing the spec's correctness
  algorithm; **write this as a standalone exported pure function** (no `room`/`ctx` argument) so
  it's trivially unit-testable later, matching the repo's own guidance in `refactor_plan.md` §8
  about `mfAllocationValid`/`imposterPointsFor` being "cheapest to unit test... easiest to
  silently break."
- `insertIntoTimeline(timeline, song)` — inserts at the true sorted position.
- `advanceTurn(room)` — wraps `mtActiveTeamIndex` to the next team with ≥1 connected member;
  used both by normal turn progression and by the team-dropout auto-skip path.
- `broadcastMt(ctx, roomCode, room)` — iterates `room.players`, emits personalized `mtState` per
  connected socket, mirrors `broadcastMenifot`.
- `failMtRound(ctx, roomCode, room, error)` — mirrors `failImposterRound`: reverts phase to
  `ready`, emits `startFailed`.
- `resolveTurn(ctx, room, { activeCorrect, challenge })` — the reveal-time scoring logic shared
  by the plain-reveal and challenged-reveal cases (see Step 5 and Step 7).
- `checkMtWin(room)` — returns the winning team id(s) once any team's timeline length hits
  `MT_TARGET_CARDS`.
- `awardMtScoreboard(ctx, room)` — mirrors `awardMenifotScoreboard`'s ranking/tie logic, applied
  per-team then fanned out to every member's `room.scoreboard[name]`.

## Server state additions

Full field list and purposes are already specified in `specs/music-timeline-specs.md` under
"Server state additions" — add exactly those fields (`mtMode`, `mtDifficulty`, `mtTeams`,
`mtActiveTeamIndex`, `mtCurrentSong`, `mtCurrentChallenge`, `mtUsedSongs`, `mtRoundNumber`,
`mtMatchWinners`) to `createRoomState()` in `roomStore.js`, grouped under a `// Music Timeline`
comment block like the existing `// Menifot` block, plus a phase-enum comment line:

```js
// Music Timeline phases: 'teamSelect' | 'ready' | 'generating' | 'placing' | 'locked' | 'revealed' | 'gameover'
```

## Implementation order

Work through this as a stack of small, independently browser-verifiable steps — not one big
PR. Each item is a checkbox.

**Convention (same as `refactor_plan.md` §7): find the first `- [ ]` item, implement only that
one, verify it in a real browser per its Verify note, then flip it to `- [x]`. Don't start the
next box in the same pass.** After every step, also spot-check that the other five games still
work (choose game → play → back to lobby), since registry/roomStore/main.js are shared files.

- [x] **Step 1 — Server scaffolding + empty screen.** Add the `mt*` fields to
  `createRoomState()`. Create `server/games/musicTimeline.js` with the full contract shape
  (`id: 'musictimeline'`, `minPlayers: MT_MIN_PLAYERS`, `maxPlayers: MT_MAX_PLAYERS`,
  `savedFields`, a minimal `onChoose` that just sets `phase = 'teamSelect'` and broadcasts, a
  no-op `registerHandlers`/`reconnectPayload`/`onDisconnect`/`clearState`). Add it to
  `gameRegistry.js`'s `GAMES` map. Add `#mt-screen` to `index.html` (bare-bones: just a "Music
  Timeline (under construction)" heading + the standard `mt-back-btn` "Back to Lobby" button).
  Create `public/js/games/musicTimeline.js` exporting `{ init, applyJoin, applyState, stop }`
  (applyState can just call `showScreen('mt')` for now). Wire into `main.js`: import, add to
  `GAMES`, add a "Music Timeline" choose-game button + handler, add `MT_MIN_PLAYERS` to
  `renderLobby`'s button-enable logic. **Verify:** from the lobby, tapping "Music Timeline"
  navigates to the stub screen; "Back to Lobby" returns cleanly; all five other games still work.

- [x] **Step 2 — Setup / team formation screen.** Build the real `teamSelect` UI: Team/Solo mode
  toggle, team-count picker (2–4, Team mode only), per-team "Join Team A/B/C/D" buttons
  (mirrors `public/js/games/codenames.js`'s team-select rendering), difficulty picker
  (Easy/Pro/Expert). Server: `setMtMode`, `setMtDifficulty`, `setMtTeamCount`, `joinMtTeam`
  handlers (host-only for the first three, any player for the last), broadcasting
  `mtTeamSelectUpdate`. `startMusicTimeline` handler validates `MT_MIN_TEAMS`–`MT_MAX_TEAMS` and
  ≥1 connected player per team (Team mode) or `MT_MIN_PLAYERS` (Solo mode), enabling Start.
  **Verify:** with 2+ browser tabs/devices, form 2–4 teams, confirm Start stays disabled until
  every team has a member, confirm Solo mode skips team-select entirely and needs no team
  buttons, confirm difficulty selection is visible to the host before pressing Start.

- [x] **Step 3 — Song generation plumbing + starting cards.** Implement
  `generateMusicTimelineSong(room, difficulty)` using `chatCompletionJson` from
  `server/lib/openai.js`, with the avoid-list built from `room.mtUsedSongs`. Implement
  `dealStartingCards` and call it from `startMusicTimeline`, so every team's `timeline` starts
  with one real card. Implement `mtNextTurn`: sets `phase = 'generating'`, broadcasts, calls
  `generateMusicTimelineSong`, sets `room.mtCurrentSong` and `phase = 'placing'` on success, or
  calls `failMtRound` on failure (mirrors `finishVoting`'s try/catch in `imposter.js`). Wire the
  `mtStatePayload` builder to include `mtCurrentSong` **only when `viewerName`'s team is the
  active team AND that player is the host** — actually per spec, the song goes to **the host
  only**, regardless of team; confirm and implement that exact visibility rule. **Verify:** start
  a match, confirm every team's starting card shows a real title/artist/year; as host, press
  "Next Turn" and confirm only the host's device shows the generated song (other devices show a
  neutral "waiting" state); temporarily unset `OPENAI_API_KEY` to confirm the failure path
  reverts to `ready` with a retryable error instead of hanging.

- [x] **Step 4 — Placement UI + locking.** Client: render the active team's timeline as an
  ordered year sequence with `timeline.length + 1` slot buttons (BEFORE / BETWEEN×N / AFTER),
  shown to everyone (not just the active team) so spectating teams can follow along; only active
  team members' buttons are enabled. Server: `mtPlaceSong` handler — auth-check
  `player.team === room.mtTeams[room.mtActiveTeamIndex]` (or equivalent), reject if already
  locked or wrong phase, store the chosen slot in `room.mtCurrentSong` (or a sibling field) and
  set `phase = 'locked'`, broadcast. **Verify:** with 2+ teams, confirm any member of the active
  team (not other teams) can lock a slot, confirm a second tap after locking is rejected, confirm
  all devices show "Locked — waiting for reveal" once it happens.

- [x] **Step 5 — Reveal + core scoring loop.** Server: `mtReveal` handler (host-only, `locked`
  phase) — runs `checkPlacement`, calls `insertIntoTimeline` on success or discards on failure,
  updates the team's card count, sets `phase = 'revealed'`, broadcasts true title/artist/year to
  everyone. `mtConfirmId` handler (host-only) toggles the honor-system checkbox and awards
  `+1` token (capped at `MT_MAX_TOKENS`) to the credited team. `mtNextTurn` (already built in
  Step 3) now also needs to call `advanceTurn` before starting the next `generating` call. Client:
  reveal screen (song details, correct/incorrect banner, updated timeline, checkbox for the
  host). **Verify:** play a full multi-turn match end-to-end with 2–3 teams and **no tokens
  spent** — confirm timelines grow on correct guesses, stay put on incorrect ones, turn order
  cycles through every team in formation order, and the ID checkbox visibly adds a token.

- [x] **Step 6 — Skip & Automatic Card tokens.** Client: token count display per team, "Skip"
  and "Auto Card" buttons on the active team's placement screen (disabled below their token
  cost). Server: `mtSkipSong` (deduct `MT_SKIP_COST`, push old song into `mtUsedSongs`, re-run
  the `generating` step for the same team/turn); `mtAutoCard` (deduct `MT_AUTO_CARD_COST`,
  skip the placement UI entirely, call `insertIntoTimeline` directly with the true position,
  `+1` card, no placement/reveal round-trip needed — go straight to a reveal-equivalent state).
  **Verify:** spend a team down from `MT_STARTING_TOKENS`, confirm Skip actually gets a
  different song and the old one never reappears, confirm Auto Card guarantees a card without
  any placement tap, confirm both buttons disable once the team can't afford them, confirm the
  `MT_MAX_TOKENS` cap holds after several ID-token awards.

- [x] **Step 7 — Challenge token.** Client: once `phase === 'locked'`, non-active teams with
  ≥`MT_CHALLENGE_COST` tokens see a "Challenge" button; after claiming it, the challenger sees
  their own timeline + slot buttons. Server: `mtChallenge` (first caller wins — check
  `room.mtCurrentChallenge` is still null before claiming, set it, broadcast so other teams'
  buttons disable), `mtChallengePlace` (only the claiming team, stores their guess). `mtReveal`
  now branches: if `room.mtCurrentChallenge` is set, evaluate **both** placements via
  `checkPlacement`, apply the spec's resolution (challenger-correct wins the card outright,
  challenger-incorrect costs them the token and the original team is scored normally), clear
  `mtCurrentChallenge` after. **Verify:** with 3+ teams, have two non-active teams race to tap
  Challenge simultaneously (confirm only the first succeeds), run one challenge that's correct
  (card goes to challenger) and one that's incorrect (token deducted, original team's own result
  stands).

- [x] **Step 8 — Winning, scoreboard, gameover, Play Again.** Server: `checkMtWin` called after
  every card-count change (normal reveal, auto card, successful challenge) — on hit, set
  `phase = 'gameover'`, populate `mtMatchWinners`, call `awardMtScoreboard` (rank teams by final
  card count, standard competition ranking, fan out to every member's `room.scoreboard[name]`,
  mirrors `awardMenifotScoreboard`). Client: gameover screen (final standings per team, updated
  scoreboard via the shared `renderScoreboard` helper). `playAgainMusicTimeline` handler:
  re-snapshot connected players into existing teams (drop now-empty teams), reset every team's
  `timeline`/token count/card count, clear `mtUsedSongs`, re-deal starting cards, back to
  `ready`. Add `clearState` to fully wipe `mt*` fields for Back to Lobby. **Verify:** play a
  match to completion, confirm the win triggers the instant a team hits `MT_TARGET_CARDS` (not
  waiting for the full turn cycle), confirm scoreboard points match the ranking/tie rules,
  confirm Play Again produces a clean fresh match, confirm Back to Lobby fully clears state
  (rejoin and choose Music Timeline again from scratch to double check).

- [x] **Step 9 — Disconnect & restart resilience.** Server: `onDisconnect` — if the disconnecting
  player was the last connected member of the active team during `placing`/`locked`, discard
  `mtCurrentSong` (push to `mtUsedSongs`), call `advanceTurn`, re-trigger `generating` for the
  new active team; otherwise no-op (teammate can still act). `onReconnectBroadcast` — just
  re-broadcast `mtState`/`mtTeamSelectUpdate` depending on phase, mirrors Menifot's. Confirm host
  handoff (already generic, handled by `lobby.js`) naturally surfaces `mtCurrentSong` to the new
  host via `mtStatePayload`'s existing visibility rule — no special-casing needed if Step 3 was
  built correctly. `repairOnLoad`: no-op for `placing`/`locked` (state already resumes correctly
  since `mtCurrentSong` is a normal persisted field); for `generating` specifically, roll back to
  `ready` (an in-flight OpenAI call can't be resumed). **Verify:** with a team's only connected
  member, disconnect mid-turn and confirm auto-skip fires; close the host's tab mid-turn and
  confirm the reassigned host sees the same pending song; restart the dev server
  (`Ctrl+C`/`npm start`) mid-`placing` and confirm the room resumes exactly where it left off on
  reload.

- [x] **Step 10 — Visual polish + full regression.** Style `mt-*` elements in `style.css` to
  match the app's current look (see the poker-table restyle commit for Menifot/Codenames as the
  reference aesthetic — cards, team panels, timeline arrows). Confirm the existing global
  click-sound/haptics listener in `main.js` covers all new buttons (it's a generic
  `document.addEventListener('click', ...)` on any `<button>`, so this should be automatic — just
  verify no dead zones). Final full regression: play all six games back-to-back in one sitting
  per `CLAUDE.md`'s testing convention, plus one disconnect/reconnect per game.

## Testing notes

No automated suite exists (per `CLAUDE.md`); this plan leans on the same manual-QA convention
every other game in this repo uses. Two pure functions are worth keeping test-friendly even
without a runner yet, per `refactor_plan.md` §8's own reasoning ("cheapest to unit test, highest
value since they're the easiest to silently break during a copy-paste move"):

- `checkPlacement(timeline, releaseYear)` — no `room`/`ctx`/socket dependency, pure boolean logic
  with clear edge cases (before-first, after-last, between, same-year tie).
- `awardMtScoreboard`'s ranking/tie math — same shape as `awardMenifotScoreboard`, already a
  pattern this repo trusts.

## Out of scope

Everything already listed in `specs/music-timeline-specs.md`'s own "Explicitly out of scope
(v1)" section applies here unchanged — this plan doesn't add scope beyond that spec, only
sequences building it.
