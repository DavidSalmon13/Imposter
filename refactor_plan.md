# Refactor Plan: Split `server.js` and `client.js` Into Per-Game Modules

## 1. Why

`server.js` is 2,452 lines and `public/client.js` is 1,775 lines. Both are single files
that interleave four independent games (Imposter, Codenames, 10 Seconds, Menifot) with
shared plumbing (room lifecycle, scoreboard, persistence, socket wiring). Concretely:

- Every game's socket handlers, state fields, and broadcast functions live in one file.
- Adding or touching one game requires reading/understanding all four to find the edges.
- Shared dispatch points (`chooseGame`, `disconnect`, `reconnectPayload`,
  `ROOM_SAVED_FIELDS` + `loadRoomsFromDisk`) each contain one `if/else` branch per game,
  so every new game touches the same handful of spots across the file.
- There is no structural boundary that stops a change to Menifot from accidentally
  breaking Codenames (shared `rooms` Map, shared helper functions, shared file).

This refactor gives each game its own module with a defined contract, and shrinks the
shared "core" to room lifecycle + persistence + dispatch. It does **not** by itself make
the app horizontally scalable — see §7 for what's separate.

## 2. Current State (for reference)

| File | Lines | Contents |
|---|---|---|
| `server.js` | 2452 | Express app, Socket.io setup, all 4 games' state/logic/handlers, persistence |
| `public/client.js` | 1775 | All DOM refs, all 4 games' render/interaction logic, socket listeners |
| `menifot-eval.js` | ~90 | Poker hand evaluation for Menifot — **already a separate module**, this is the pattern to follow |
| `data/rooms.json` | — | Disk snapshot of `rooms` Map, gitignored, resaved every 5s |

Room state today is one flat object (`createRoomState()`) with every game's fields
mixed together (`cnBoard`, `tsActivePlayers`, `mfHands`, ...) plus shared fields
(`scoreboard`, `hostName`, `phase`). No test suite exists.

## 3. Target Directory Structure

```
server.js                    # bootstrap only: express/http/io setup, static
                              #   serving, load/save interval, listen — ~60 lines
server/
  roomStore.js                # rooms Map, createRoomState, normalizeRoomCode,
                               #   generateRoomCode, getRoom, roomEmit
  persistence.js               # ROOM_SAVED_FIELDS, saveRoomsToDisk, loadRoomsFromDisk
  lobby.js                    # createRoom/join/backToLobby/background upload/
                               #   resetToLobby/scoreboard reset — cross-game lifecycle
  gameRegistry.js              # wires games/* into chooseGame, disconnect,
                               #   reconnectPayload, socket handler registration
  lib/
    shuffle.js
    validateName.js
    openai.js                  # generateWordAndHint + generateWordGrid's shared
                               #   fetch-to-OpenAI logic, factored to one call site
  games/
    imposter.js
    codenames.js
    tenseconds.js
    menifot.js
    menifot-eval.js            # moved as-is from repo root

public/
  index.html                  # add type="module" to the client.js script tag
  js/
    main.js                   # bootstrap: socket connection, screen routing,
                               #   shared DOM refs, lobby/join/create UI
    shared/
      dom.js                  # screens{} map + generic show/hide helpers
      scoreboard.js            # renderScoreboard (used by all 4 games)
      format.js                # capitalize, time/distance formatters
    games/
      imposter.js
      codenames.js
      tenseconds.js
      menifot.js
```

Backend uses plain CommonJS `require`/`module.exports` — no bundler needed, Node
supports it natively. Frontend uses native ES modules (`<script type="module">`),
also no bundler needed — all files are same-origin static assets already served by
Express, and every browser you're targeting for "hundreds of users on phones in a
room" supports `type="module"` natively.

## 4. The Module Contract

This is the part that actually kills the `if/else`-per-game duplication. Every file
in `server/games/` exports the same shape:

```js
// server/games/<name>.js
module.exports = {
  id: 'imposter',              // matches room.game value
  minPlayers: 3,
  maxPlayers: null,             // null = no cap

  // Called from the chooseGame handler once shared validation (host-only, phase
  // check, player count) passes. Sets room.phase/game and does first broadcast.
  onChoose(ctx, roomCode, room) { ... },

  // All of this game's socket.on(...) registrations, given (io, socket) plus ctx.
  registerHandlers(ctx, io, socket) { ... },

  // Replaces the per-game branch in reconnectPayload().
  reconnectPayload(ctx, room, existingPlayer) { ... },

  // Replaces the per-game branch in the disconnect handler.
  onDisconnect(ctx, roomCode, room, name) { ... },

  // Field names this game owns in room state — feeds ROOM_SAVED_FIELDS so a new
  // game only needs to list its own fields, not edit a shared array by hand.
  savedFields: ['cnBoard', 'cnActiveTeam', /* ... */],

  // Optional: repair a room loaded mid-round after a process restart (today this
  // logic is hardcoded per-game inside loadRoomsFromDisk).
  repairOnLoad(ctx, room) { ... },

  // Optional: reset this game's fields to empty (used by resetToLobby).
  clearState(room) { ... },
};
```

`ctx` is a small object built once in `server.js` and passed to every game module,
giving them access to shared helpers without each file doing its own `require`
web and without circular imports between `games/*.js` and `roomStore.js`:

```js
const ctx = {
  rooms, roomEmit, io,
  connectedNames, scoreboardEntries, addScore, broadcastLobby,
  attachToRoom, saveRoomsToDisk,
};
```

`gameRegistry.js` holds `const GAMES = { imposter, codenames, tenseconds, menifot }`
and the dispatch shell:

```js
// chooseGame handler becomes:
const game = GAMES[selectedGame];
if (!game) return callback({ ok: false, error: 'Invalid game' });
if (connectedNames(room).length < game.minPlayers) return callback({ ok: false, error: `Need at least ${game.minPlayers} players` });
room.game = game.id;
roomEmit(roomCode, 'gameChosen', { game: game.id });
game.onChoose(ctx, roomCode, room);
callback({ ok: true });
```

Same pattern collapses `reconnectPayload`, `onDisconnect` dispatch, and
`ROOM_SAVED_FIELDS` (becomes `Object.values(GAMES).flatMap(g => g.savedFields)`).
**Adding a 5th game becomes: write one file implementing this contract, add one
line to `GAMES`.** No existing file needs to change.

## 5. Function-to-Module Mapping

Mechanical inventory of where every current top-level function in `server.js` goes.

**`server/roomStore.js`**
`createRoomState`, `rooms` (the Map), `normalizeRoomCode`, `generateRoomCode`,
`getRoom`, `roomEmit`

**`server/persistence.js`**
`ROOM_SAVED_FIELDS` (built from game modules per §4), `saveRoomsToDisk`,
`loadRoomsFromDisk` (shell only — per-game repair delegates to `repairOnLoad`)

**`server/lib/shuffle.js`**: `shuffle`
**`server/lib/validateName.js`**: `validateName`
**`server/lib/openai.js`**: the shared `fetch('https://api.openai.com/...')` call,
parameterized so `generateWordAndHint` and `generateWordGrid` both call through it
instead of duplicating the request/error-handling boilerplate

**`server/lobby.js`**
`connectedNames`, `scoreboardEntries`, `addScore`, `broadcastLobby`, `setHost`,
`resetToLobby`, `attachToRoom`, `joinExistingRoom`, `reconnectPayload` (shell that
calls `game.reconnectPayload`), socket handlers: `createRoom`, `join`, `chooseGame`
(shell), `resetScoreboard`, `backToLobby`, `clearBackground`, the
`/api/rooms/:roomCode/background` route, `disconnect` (shell that calls
`game.onDisconnect`)

**`server/games/imposter.js`**
Constants: `MIN_PLAYERS`, `TWO_IMPOSTER_THRESHOLD`, `LEVELS`, `LEVEL_SPEC`,
`WORD_CATEGORIES`. Functions: `generateWordAndHint`, `failImposterRound`,
`finishVoting`, `maybeFinishVoting`, `imposterPointsFor`, `playersInImposterRound`,
`broadcastVoting`, `broadcastImposterReporting`, `broadcastImposterResults`,
`finishImposterReporting`, `maybeFinishImposterReporting`. Handlers: `vote`,
`endImposterRound`, `reportEliminated`. Reconnect branch for phases `playing` /
`reporting` / `roundResults` / `generating` / `voting`. Disconnect branch for
`voting` / `reporting`. Load-repair: `generating`→`voting` rollback, reporting
auto-fill.

**`server/games/codenames.js`**
Constants: all `CN_*`. Module-local state: `cnTimerHandles` Map (was a top-level
Map in `server.js`, becomes a closure-local Map inside this module). Functions:
`clearCnTimerHandle`, `startCnTimer`, `cnTimerExpired`, `teamMembers`,
`teamPlayersInfo`, `broadcastTeamSelect`, `cnTeamValid`, `generateWordGrid`,
`buildBoard`, `boardForViewer`, `broadcastCodenamesState`, `failCodenamesRound`,
`checkTeamWin`, `awardCodenamesScores`, `finishCodenamesGame`,
`generateCodenamesRound`. Handlers: `joinTeam`, `claimLeader`, `setCnTimer`,
`startCodenames`, `startCnTurnTimer`, `guessWord`, `endTurn`,
`playAgainCodenames`. Reconnect branch for `teamSelect` / `generating` /
`playing` / `gameover`. Disconnect branch for `teamSelect` / `playing` /
`gameover`. Load-repair: timer resumption from `cnTurnEndsAt`.

**`server/games/tenseconds.js`**
Constants: all `TS_*`. Module-local `tsForceStopHandles` Map. Functions:
`clearTsForceStopHandle`, `clearTsState`, `tsDisconnectedActive`,
`tensSecondsStatePayload`, `broadcastTensSeconds`, `initTensSecondsGame`,
`startTensSecondsRound`, `scheduleTsForceStop`, `applyTsForceStops`,
`assignTsDnf`, `submitTsStop`, `allTsContendersIn`, `maybeResolveTsRound`,
`resolveTsRound`, `eliminateTsPlayers`, `finishTsRoundResolution`,
`awardTensSecondsScores`, `continueTsAfterResults`. Handlers:
`startTensSeconds`, `tsStop`, `tsContinue`, `playAgainTensSeconds`. Reconnect
payload: reuses `tensSecondsStatePayload` directly (already game-scoped — easiest
of the four). Disconnect branch: DNF assignment during `running`. Load-repair:
force-stop timer resumption.

**`server/games/menifot.js`**
Constants: all `MF_*`. Functions: `clearMfState`, `emptyMfAllocation`,
`mfAllocationCounts`, `mfBoardLimits`, `mfCountsFeasible`, `mfAllocationValid`,
`mfCommunityCards`, `dealMenifotRound`, `autoLockEvenSplit`, `menifotPublicBoards`,
`menifotLockStatus`, `menifotStatePayload`, `broadcastMenifot`, `initMenifotGame`,
`startMenifotMatch`, `startMenifotNextRound`, `setMfCardBoard`, `lockMfHand`,
`allMfLocked`, `finalizeMenifotRound`, `revealMfCard`, `awardMenifotScoreboard`.
Handlers: `startMenifot`, `mfAssignCard`, `mfLock`, `mfRevealCard`, `mfNextRound`,
`playAgainMenifot`. Reconnect payload: reuses `menifotStatePayload` directly.
Disconnect branch: auto-lock on drop during `allocating`. Load-repair:
`allocating`/`roundResults` → `ready` reset. Depends on `menifot-eval.js`
(`buildDeck`, `rankBoard`) — moves alongside into `server/games/`.

## 6. Coupling Points That Need Care

These are the reasons this isn't a pure copy-paste job:

1. **Flat room state.** `createRoomState()` returns one object with every game's
   fields at the top level. Keep it flat for this refactor (don't namespace into
   `room.imposter = {...}` etc. yet) — namespacing is a bigger, separately-valuable
   change (see §9) and mixing it into a file-split makes the diff much harder to
   verify. `savedFields` per module (§4) gets you most of the isolation benefit
   without touching the state shape.
2. **Timer handles.** `cnTimerHandles` and `tsForceStopHandles` are today
   module-level `Map`s in `server.js`. They move into their owning game module as
   closure-local state — nothing outside `codenames.js` / `tenseconds.js` ever
   touched them directly, so this is safe.
3. **`ctx` object avoids circular requires.** `games/*.js` need `roomEmit`/`io`;
   `roomStore.js`/`lobby.js` need to call into `games/*.js` via the registry. Passing
   `ctx` into each game module's exported functions (rather than having games
   `require('../roomStore')` directly) avoids a require cycle and makes each game
   module's dependencies explicit and mockable for tests.
4. **OpenAI call duplication.** `generateWordAndHint` and `generateWordGrid`
   currently each hand-roll the same `fetch` + error handling. Factor the HTTP call
   into `lib/openai.js` as one function; each game keeps its own prompt-building
   logic (that part is genuinely game-specific).
5. **`joinExistingRoom`'s per-phase broadcast dispatch.** Right now it has an
   `if (room.phase === 'voting') ... else if (room.phase === 'teamSelect') ...`
   chain to decide what to re-broadcast on reconnect. This is really "ask the
   active game to re-broadcast its current state" and should become
   `GAMES[room.game]?.onReconnectBroadcast(ctx, roomCode, room)` — add this as a
   fifth optional contract method alongside `reconnectPayload`.

## 7. Migration Order

Work through this as a stack of small, independently-verifiable steps — not one
big rewrite. Each item below is a checkbox.

**Convention: find the first `- [ ]` item, implement only that one, verify it,
then flip it to `- [x]`. Don't start the next box in the same pass.**

After every step: manually run through the affected game(s)' full happy path
(create room → choose game → play a full round → scoreboard updates → back to
lobby) plus one disconnect/reconnect, since that's the logic most likely to
regress silently. There's no automated test suite today (§8 covers whether to
add one).

- [x] **Step 1 — Branch + baseline.** Create a branch for this refactor. Don't
  touch `main` until the split is verified working end-to-end. *(One-time setup;
  only needs doing once, first.)*
- [x] **Step 2 — Extract zero-risk leaves.** Move `shuffle` →
  `server/lib/shuffle.js`, `validateName` → `server/lib/validateName.js`. Pure
  functions, no state, mechanical `require` swap. Verify: server starts clean,
  spot-check one game still loads.
- [x] **Step 3 — Extract `server/lib/openai.js`.** Isolate the shared OpenAI
  `fetch` call used by both `generateWordAndHint` (Imposter) and
  `generateWordGrid` (Codenames) into one function; each game keeps its own
  prompt-building. Verify: start an Imposter round and a Codenames round,
  confirm word/hint and board generation still work.
- [x] **Step 4 — Extract `server/roomStore.js` + `server/persistence.js`.** Move
  `createRoomState`, the `rooms` Map, `normalizeRoomCode`, `generateRoomCode`,
  `getRoom`, `roomEmit`, `ROOM_SAVED_FIELDS`, `saveRoomsToDisk`,
  `loadRoomsFromDisk`. Keep `ROOM_SAVED_FIELDS` as a plain hardcoded array for
  now (see §6, point 1). Verify: restart the server mid-game for each of the 4
  games and confirm state survives, same as today.
- [x] **Step 5 — Extract `server/lobby.js`.** Move join/create/scoreboard/
  background upload/`backToLobby`/`disconnect` shell/`reconnectPayload` shell.
  `server.js` should now be just bootstrap + requires + the four games' logic
  still inline. Verify: full lobby flow (create, join, name conflicts),
  background image upload/clear.
- [ ] **Step 6a — Extract `server/games/menifot.js`.** Move per §5 mapping.
  Wire into the existing `chooseGame`/`disconnect`/`reconnectPayload` if/else
  **by hand** (call `menifot.onChoose(...)` etc. from the existing branches) —
  don't build the registry yet. Verify: full Menifot match including reconnect
  mid-allocation.
- [ ] **Step 6b — Extract `server/games/tenseconds.js`.** Same approach as 6a.
  Verify: full 10 Seconds game including a disconnect during a running round
  (DNF path).
- [ ] **Step 6c — Extract `server/games/codenames.js`.** Same approach. Verify:
  full Codenames game including the turn timer and a disconnect during
  `playing`.
- [ ] **Step 6d — Extract `server/games/imposter.js`.** Same approach. Verify:
  full Imposter round including the reporting phase and a disconnect during
  `voting`.
- [ ] **Step 7 — Build `server/gameRegistry.js`.** Replace the hand-wired
  if/else chains from step 6 with the `GAMES[...]` dispatch from §4. Derive
  `ROOM_SAVED_FIELDS` from each module's `savedFields`. Verify: all four games
  again, full regression pass, since this step touches every game's dispatch at
  once.
- [ ] **Step 8a — Frontend shared modules.** Extract `public/js/shared/dom.js`,
  `shared/scoreboard.js`, `shared/format.js`. Switch the `<script>` tag to
  `type="module"`. Verify in an actual browser: app loads, lobby renders,
  scoreboard renders.
- [ ] **Step 8b — Frontend `public/js/games/menifot.js`.** Verify in-browser:
  full Menifot match.
- [ ] **Step 8c — Frontend `public/js/games/tenseconds.js`.** Verify
  in-browser: full 10 Seconds game.
- [ ] **Step 8d — Frontend `public/js/games/codenames.js`.** Verify in-browser:
  full Codenames game.
- [ ] **Step 8e — Frontend `public/js/games/imposter.js` + assemble
  `main.js`.** Verify in-browser: full Imposter round, then a full pass through
  all four games back-to-back.
- [ ] **Step 9 — Cleanup.** Delete dead code left in `server.js`/`client.js`,
  update `package.json` `main` if needed. Final full pass through all four
  games in a real browser before merging.

## 8. Testing

No test suite exists today. Given the goal is "safe as possible," worth adding
before or during this refactor rather than after:

- A minimal integration harness using `socket.io-client` against a locally
  spun-up server instance, covering one full happy-path round per game plus one
  disconnect/reconnect per game. This is what actually lets you trust step 6/7
  of the migration instead of re-doing manual QA after every commit.
- If a full harness is too much up front, at minimum keep a written manual QA
  checklist (one per game: create → choose → play to completion → scoreboard →
  lobby → disconnect/reconnect mid-round) and run it after every phase in §7.
- Menifot's allocation validation (`mfCountsFeasible`/`mfAllocationValid`) and
  the Imposter scoring math (`imposterPointsFor`) are pure functions with no
  socket/timer involvement — cheapest to unit test directly, highest value since
  they're the easiest to silently break during a copy-paste move.

## 9. What This Refactor Does NOT Solve

Flagging this explicitly so the module split isn't mistaken for "now it scales to
hundreds of users":

- **Single process, in-memory `rooms` Map.** Even after modularizing, all room
  state lives in one Node process's memory. Party games with short-lived, small
  rooms may genuinely be fine on one well-sized instance for "hundreds of
  concurrent users" (that's hundreds of people across maybe tens of rooms, not
  hundreds of rooms) — this may not need solving at all. If it does: Socket.io's
  Redis adapter for multi-instance pub/sub, plus moving room state out of process
  memory (Redis or a DB), are the standard next steps — separate project from
  this one.
- **`data/rooms.json` disk snapshotting** doesn't work across multiple instances
  or on platforms with ephemeral disks (most container hosts). Fine for one
  instance; a blocker the moment you run more than one.
- **Namespacing room state per game** (§6, point 1) — a real isolation
  improvement, deliberately deferred out of this refactor to keep it low-risk.
  Worth doing once the module split has proven stable.

## 10. After This Lands: Replacing the "One Big Doc for Claude" Idea

Once each game is its own file with the contract in §4, the most useful
"read before you touch this" reference for an agent isn't one large
architecture document — it's a short header comment at the top of each
`games/<name>.js` describing that game's state fields and phase machine (most of
this already exists as inline comments in today's `createRoomState()`, e.g. the
phase-enum comments), plus one short root doc that's just an index: what each
module owns, and a note not to add cross-game dependencies without updating this
plan. That keeps the "context for the agent" scoped to what's actually relevant
to the file being edited, instead of one large document that goes stale and
that the agent has to skim in full on every task regardless of which game it's
touching.
