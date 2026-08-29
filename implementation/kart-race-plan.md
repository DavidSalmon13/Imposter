# Kart Race — Implementation Plan

Companion to `../specs/kart-race.md` (rules/UX — read that first) and `refactor_plan.md` §4
(the game module contract this must implement). This doc pins down the *how*: exact files,
exact formulas/constants, and an ordered checklist, so there's nothing left to invent while
coding. Numbers below (speeds, radii, placements) are concrete implementation defaults, not
just "tuned in-engine" placeholders — change them during playtesting, but start here instead
of re-deriving from scratch.

**Convention, matching `refactor_plan.md` §7**: work through the checklist in order, one
box at a time. After each box, manually verify per that box's note (there's no test suite —
see `CLAUDE.md` "Testing"). Don't start the next box in the same pass.

## 1. File manifest

New files only — **no existing game file changes**, per the module contract:

```
public/data/kart-track.json        # single source of truth for track geometry (§2)
public/vendor/three/three.module.js # vendored Three.js, ES module build
server/games/kartRace.js            # the game module (§3)
public/js/games/kartRace.js         # client ES module (§5)
specs/kart-race.md                  # already written
implementation/kart-race-plan.md    # this file
```

Modified files — all shared/bootstrap, not game files:

```
server/gameRegistry.js   # +2 lines: require + GAMES map entry
public/index.html        # +1 game tile, +1 new <section>, script tag → type="module"
public/client.js          # +1 import, +1 screens{} entry, +1 choose-button handler,
                          #   +1 socket.on('krState', ...) listener, +2 lines in the
                          #   existing 'backToLobby' reset block (stop the KartRace client
                          #   loop) — small, additive, same shape as how tenseconds/menifot
                          #   were wired into this file originally
scoreboard-specs.md      # +1 row in the point-values table (per kart-race.md's note)
```

## 2. Track data (`public/data/kart-track.json`)

Single JSON file, served statically to the client and `require()`'d directly by the server
module (Node's `require` resolves JSON by path regardless of it living under `public/`) —
this guarantees the client's visuals and the server's collision/lap logic can never drift
out of sync with each other.

### Shape: parametric stadium (rounded oval)

Generate the centerline as a closed loop, not hand-authored points — still a single fixed
track (satisfies "no level editor"), just computed from fixed shape parameters instead of
literal coordinates typed by hand:

- `STRAIGHT_LENGTH = 60`, `TURN_RADIUS = 20` — two straights at `x = ±20`, `z` ranging
  `[-30, 30]`, joined by two 180° semicircular arcs of radius 20 centered at `(0, 30)` and
  `(0, -30)`.
- Direction of travel: counterclockwise when viewed from above (+Y looking down) — up the
  `x = +20` straight (z: -30 → 30), around the top arc through `(0, 50)`, down the
  `x = -20` straight (z: 30 → -30), around the bottom arc through `(0, -50)`, back to start.
- Sample **48 waypoints** evenly spaced by arc length around the full loop, starting at
  index 0 = the midpoint of the `x = +20` straight, i.e. `(20, 0)` — this is also the
  finish line, facing the direction of travel (+z at that point).
- Total loop length ≈ `2 × 60 + 2π × 20 ≈ 245.7` units.

### JSON shape

```json
{
  "waypoints": [{ "x": 20, "z": 0 }, /* ... 48 points, index 0 = start/finish */],
  "trackHalfWidth": 6,
  "checkpoints": [0, 8, 16, 24, 32, 40],
  "itemBoxes": [{ "waypointIndex": 4 }, { "waypointIndex": 20 }, { "waypointIndex": 28 }, { "waypointIndex": 44 }],
  "oilSlicks": [{ "waypointIndex": 12 }, { "waypointIndex": 36 }],
  "wallHazards": [{ "waypointIndex": 2, "lateralOffset": 2 }, { "waypointIndex": 30, "lateralOffset": -2 }]
}
```

- `checkpoints`: 6 waypoint indices, evenly spaced (every 8th of 48) — index 0 doubles as
  the finish line. Order matters (lap validity depends on crossing them in this order).
- `itemBoxes` / `oilSlicks`: waypoint index the object sits on (dead center of the track at
  that point).
- `wallHazards`: waypoint index **plus** a lateral offset (units, positive = to the right of
  the direction of travel) so they sit off-center and are avoidable, not full roadblocks.
  Placed on the straights (indices 2 and 30 above), not on the turns.
- Oil slicks placed just past each turn's apex (indices 12 and 36, the midpoints of the two
  semicircle arcs) — a natural spot for a hazard to matter (players are already turning).

Write this file by direct computation (a quick throwaway Node/JS snippet using the formulas
above is the easiest way to get 48 evenly-spaced points on two line segments + two arcs) —
the snippet itself doesn't need to be kept, only its JSON output.

- [x] **Step 1 — Write `public/data/kart-track.json`.** Verify: `JSON.parse(fs.readFileSync(...))`
  succeeds, 48 waypoints form a closed loop back to index 0, checkpoint/item/hazard indices
  are all `< 48`.

## 3. Server module (`server/games/kartRace.js`)

Follow `server/games/tenseconds.js`'s shape exactly (closure-local timer-handle Map, a
single `<x>StatePayload` builder, a single `broadcast<X>` function, init/clear functions,
then the five-ish contract exports at the bottom).

### 3.1 Constants

```js
const KR_MIN_PLAYERS = 2;
const KR_MAX_PLAYERS = 8;
const KR_LAP_COUNT = 1;
const KR_COUNTDOWN_MS = 3000;
const KR_TICK_MS = 50;                 // 20Hz — physics step AND broadcast, combined
const KR_MAX_SPEED = 24;               // units/s
const KR_ACCEL = 18;                   // units/s^2
const KR_BRAKE_DECEL = 30;             // units/s^2
const KR_TURN_RATE = 2.4;              // rad/s at full steer and full speed
const KR_KART_RADIUS = 1.4;
const KR_TRACK_BOUNCE_SPEED_FACTOR = 0.5; // speed retained after boundary/wall bounce
const KR_ITEM_PICKUP_RADIUS = 2.5;
const KR_ITEM_BOX_RESPAWN_MS = 8000;
const KR_BOOST_MULTIPLIER = 1.6;
const KR_BOOST_DURATION_MS = 3000;
const KR_SHIELD_DURATION_MS = 8000;
const KR_SHELL_RANGE = 14;
const KR_SHELL_HALF_ANGLE_RAD = (20 * Math.PI) / 180; // 40° cone
const KR_HAZARD_RADIUS = 1.5;
const KR_SPINOUT_DURATION_MS = 1200;
const trackData = require('../../public/data/kart-track.json');
```

### 3.2 State shape (fields added to `createRoomState()`'s conceptual model — see §3.6 for
the actual `savedFields` list; don't edit `roomStore.js` itself, these just need to exist as
plain properties the module reads/writes on `room`)

```js
room.krPlayers = [];       // frozen roster (names) for the current race
room.krKarts = {};         // name -> KartState (see below)
room.krRaceStartAt = null; // epoch ms countdown target, or null outside countdown
room.krItemBoxes = [];     // parallel array to trackData.itemBoxes: [{ takenUntil }]
room.krResults = null;     // final ranked list, set at End Race
```

`KartState` (one per name in `room.krPlayers`):
```js
{
  x, z, headingRad, speed,          // physics
  pendingInput: { steer: 0, braking: false }, // last received input, applied each tick
  progress: 0,                      // cumulative arc-length traveled this lap (0..trackLength)
  lap: 0,
  nextCheckpointIndex: 0,
  heldItem: null,                   // null | 'boost' | 'shield' | 'shell'
  boostUntil: 0, shieldUntil: 0, spinningUntil: 0, // epoch ms, 0 = inactive
  finished: false, finishTime: null, finishRank: null,
}
```

### 3.3 Core helper: `nearestTrackPoint(x, z)`

The one function everything else leans on. Loop over the 48 waypoint segments, find the
closest segment, return:
```js
{ lateralOffset, arcLength, segmentIndex }
```
- `lateralOffset`: signed perpendicular distance from the centerline at that point (sign
  tells which side, only magnitude matters for collision).
- `arcLength`: cumulative distance along the loop from waypoint 0 to the projected point —
  this is what checkpoint/lap progress is measured against. Precompute each waypoint's
  cumulative arc length once (from `trackData`) at module load, not per call.

48 segments × up to 8 karts × 20Hz = ≤ 7680 segment checks/sec — trivial, no spatial
indexing needed.

- [x] **Step 2 — `nearestTrackPoint`.** Write it standalone against the loaded `trackData`,
  verify with a few hand-checked points (e.g. `(20, 0)` should return `arcLength ≈ 0`,
  `lateralOffset ≈ 0`; a point 10 units outside the track near the start should return
  `lateralOffset ≈ 10`) before wiring it into the tick loop.

### 3.4 Physics tick (`stepKartRace(ctx, roomCode, room)`, called every `KR_TICK_MS`)

For each name in `room.krPlayers` with a kart that isn't already `finished`:

1. `dt = KR_TICK_MS / 1000`.
2. **If `spinningUntil > now`**: ignore `pendingInput`, decay `speed` toward 0 at
   `KR_BRAKE_DECEL`, skip straight to position update (heading unchanged — the client plays
   a cosmetic spin animation locally based on the `spinningUntil` flag, no server-side
   heading spin needed).
3. **Else**: apply input —
   - `effectiveMax = KR_MAX_SPEED * (boostUntil > now ? KR_BOOST_MULTIPLIER : 1)`
   - `speed += (pendingInput.braking ? -KR_BRAKE_DECEL : KR_ACCEL) * dt`, clamp to
     `[0, effectiveMax]` (no reverse — braking floors at 0).
   - `turnScale = clamp(speed / KR_MAX_SPEED, 0.2, 1)` (some steering at low speed, less
     than full at high speed... actually just use this scale directly, don't overthink it)
   - `headingRad += pendingInput.steer * KR_TURN_RATE * turnScale * dt`
4. **Position**: `x += Math.sin(headingRad) * speed * dt`, `z += Math.cos(headingRad) * speed * dt`.
5. **Track boundary**: `{ lateralOffset } = nearestTrackPoint(x, z)`. If
   `Math.abs(lateralOffset) > trackData.trackHalfWidth`, call `applyBounce(kart)` (§3.5) and
   pull `x, z` back toward the centerline point by the excess.
6. **Hazards**: for each oil slick / wall hazard within `KR_HAZARD_RADIUS + KR_KART_RADIUS`
   of `(x, z)`: oil slick → `spinningUntil = now + KR_SPINOUT_DURATION_MS`; wall → same
   `applyBounce(kart)` as the track boundary (spec explicitly reuses that response).
7. **Item boxes**: for each box within `KR_ITEM_PICKUP_RADIUS` where `takenUntil <= now` and
   `kart.heldItem === null`: `kart.heldItem = ['boost','shield','shell'][Math.floor(Math.random()*3)]`,
   set that box's `takenUntil = now + KR_ITEM_BOX_RESPAWN_MS`.
8. **Progress / checkpoints / laps**: `{ arcLength } = nearestTrackPoint(x, z)`,
   `kart.progress = arcLength`. Let `target = trackData.checkpoints[kart.nextCheckpointIndex]`'s
   precomputed arc length. If `arcLength` has reached/passed `target` (accounting for the
   loop wraparound at `arcLength ≈ 0`), advance:
   `nextCheckpointIndex = (nextCheckpointIndex + 1) % checkpoints.length`. If it just wrapped
   to `0`, that was the finish-line crossing: `lap += 1`.
   - A kart briefly pushed backward by a bounce can't "un-cross" an already-counted
     checkpoint — this logic only ever looks at the *next* threshold, so a small backward
     nudge just delays reaching it, no special-casing needed.
9. **Finish**: if `lap >= KR_LAP_COUNT` and this tick's checkpoint-wrap was the finish
   crossing and `!kart.finished`: `finished = true`, `finishTime = now - room.krRaceStartAt`,
   `finishRank = 1 + (count of other karts with finished === true)`.

After all karts: **kart-kart collision** (§3.5), then `broadcastKartRace(ctx, roomCode, room)`.

### 3.5 Collision helpers

```js
function applyBounce(kart) {
  const { x, z } = nearestPointOnCenterline(kart.x, kart.z); // clamp position to boundary
  kart.x = clampedX; kart.z = clampedZ; // pulled back to trackHalfWidth from centerline
  kart.speed *= KR_TRACK_BOUNCE_SPEED_FACTOR;
}

function resolveKartKartCollisions(karts) {
  // all pairs, O(n^2) — n <= 8, fine
  for each pair (a, b) with connected karts:
    const dist = distance(a, b);
    const minDist = KR_KART_RADIUS * 2;
    if (dist < minDist && dist > 0) {
      const overlap = minDist - dist;
      const pushEach = overlap / 2;
      // move a and b apart along the a->b line by pushEach each; no speed change
    }
}
```

Kart-kart collision is **position-only** (push apart, keep speed) per the spec's "gentle
push-apart" decision — don't add a speed penalty here, that's only for track/wall/hazard
hits.

### 3.6 Contract exports

```js
const SAVED_FIELDS = ['krPlayers', 'krKarts', 'krRaceStartAt', 'krItemBoxes', 'krResults'];

module.exports = {
  id: 'kartrace',
  minPlayers: KR_MIN_PLAYERS,
  maxPlayers: KR_MAX_PLAYERS,
  onChoose,            // -> initKartRaceGame (sets phase='ready', freezes nothing yet)
  registerHandlers,    // startKartRace, krInput, krUseItem, krEndRace, playAgainKartRace
  reconnectPayload,    // { ok: true, ...kartRaceStatePayload(ctx, room, viewerName) }
  onDisconnect,        // no-op beyond broadcasting — see §3.7, connected flag does the work
  onReconnectBroadcast,// broadcastKartRace(ctx, roomCode, room)
  savedFields: SAVED_FIELDS,
  repairOnLoad,        // if phase==='racing', restart the tick interval (§3.8)
  clearState,          // stop tick interval, reset all kr* fields
};
```

### 3.7 Handlers (`registerHandlers`)

- **`startKartRace`** (host-only, `phase === 'ready'`, `ctx.connectedNames(room).length >= KR_MIN_PLAYERS`):
  freeze `room.krPlayers = ctx.connectedNames(room)`, build `room.krKarts` (spread start
  positions across the start line — e.g. offset each kart by `index * (2 * KR_KART_RADIUS + 0.5)`
  laterally from waypoint 0 so they don't spawn stacked), `room.krRaceStartAt = Date.now() + KR_COUNTDOWN_MS`,
  `room.phase = 'countdown'`, broadcast. Set a one-shot `setTimeout` for `KR_COUNTDOWN_MS`
  that flips `room.phase = 'racing'` and calls `startKartLoop(ctx, roomCode)` — mirrors how
  10 Seconds uses `tsRoundStartAt` to gate the client, but here the *server* also needs to
  know when to start ticking physics.
- **`krInput`** (`{ steer, braking }`): validate/clamp (`steer` ∈ `{-1, 0, 1}`, `braking`
  coerced to boolean — same "trust but clamp" pattern as `submitTsStop`'s `elapsedMs`
  clamping), store on `room.krKarts[name].pendingInput`. No broadcast — the next tick covers it.
- **`krUseItem`**: no payload. If `room.phase === 'racing'` and kart has `heldItem`:
  - `'boost'` → `kart.boostUntil = now + KR_BOOST_DURATION_MS`
  - `'shield'` → `kart.shieldUntil = now + KR_SHIELD_DURATION_MS`
  - `'shell'` → find nearest *other*, connected, non-finished kart within `KR_SHELL_RANGE`
    and within `KR_SHELL_HALF_ANGLE_RAD` of the firer's heading (dot-product test between
    the firer's forward vector and the normalized vector to the candidate). If found: if its
    `shieldUntil > now`, set `shieldUntil = 0` (shield absorbs the hit); else set
    `spinningUntil = now + KR_SPINOUT_DURATION_MS`. No target found → shell just consumed,
    no effect.
  - `kart.heldItem = null` in all three cases.
- **`krEndRace`** (host-only, `phase === 'racing'`, at least one kart `finished`):
  `stopKartLoop(roomCode)`, compute `room.krResults` = finished karts sorted by
  `finishRank` ascending, then unfinished karts sorted by `progress` descending (using
  `lap * trackLength + progress` as the real sort key so a kart on lap 2 always outranks one
  still on lap 1 — moot at `KR_LAP_COUNT = 1` today, but keep the formula correct since the
  spec calls out lap count as configurable later), award scores (§3.9), `phase = 'results'`, broadcast.
- **`playAgainKartRace`** (host-only, `phase === 'results'`): re-run the same init as
  `startKartRace`'s roster-freeze step but land back in `'ready'` (not straight into
  countdown) — matches Menifot/10 Seconds' "Play Again returns to a ready screen" pattern,
  not an instant restart.

### 3.8 Timer-handle lifecycle

Module-local `Map<roomCode, NodeJS.Timeout>` (`kartLoopHandles`), same pattern as
`cnTimerHandles` / `tsForceStopHandles`:

- `startKartLoop(ctx, roomCode)`: `setInterval(() => stepKartRace(ctx, roomCode, ctx.rooms.get(roomCode)), KR_TICK_MS)`, guard for room existing / still `phase === 'racing'` inside the callback (room could be reset mid-flight).
- `stopKartLoop(roomCode)`: `clearInterval` + delete from map. Call from `krEndRace`,
  `clearState`, and defensively at the top of `startKartLoop` (clear any stale handle first).
- `repairOnLoad(ctx, room)`: if `room.phase === 'racing'`, find the room's code in
  `ctx.rooms` (same lookup-by-value pattern `tenseconds.js`'s `repairOnLoad` already uses)
  and call `startKartLoop`. If `room.phase === 'countdown'`, the countdown's `setTimeout`
  was lost on restart too — just fast-forward it directly to `'racing'` and start the loop
  (don't try to resume a lost in-memory timeout; a countdown that's a few seconds short
  after a rare mid-countdown server restart is a non-issue).

### 3.9 Scoring (`awardKartRaceScores(ctx, room)`)

```js
const POINTS = [3, 2, 1]; // index 0 = 1st place
room.krResults.forEach((entry, i) => {
  ctx.addScore(room, entry.name, POINTS[i] || 0);
});
```

Also add the matching row to `scoreboard-specs.md`'s point-values table (1st +3 / 2nd +2 /
3rd +1 / everyone else 0) as noted in `kart-race.md` — small doc-only edit, do it in the
same step as writing this function so the two docs don't drift apart.

### 3.10 Disconnect / reconnect

Confirm first (don't assume): check how `room.players.get(name).connected` is toggled today
— it's almost certainly flipped centrally in `lobby.js`'s `disconnect` handler before
`game.onDisconnect` is even called (that's the pattern `tenseconds.js`/`menifot.js` rely on
already — they read `p.connected`, they don't set it). If confirmed, Kart Race's "ghost"
behavior needs **no new field at all**: every place that matters (kart-kart collision,
shell-targeting, item-box pickup gating) just checks `room.players.get(name)?.connected`
and skips disconnected karts. `onDisconnect` itself only needs to `broadcastKartRace(...)`
so clients immediately see the kart go translucent/ghosted; the kart's `pendingInput` simply
stops updating (no new input arrives), so it naturally stops turning — but **speed doesn't
zero itself** just from input stopping, since auto-accelerate would keep pushing it forward
under stale "not braking" input. Explicitly zero `speed` in `onDisconnect` (freeze fully,
matching the spec) rather than relying on input staleness.

- [x] **Step 3 — `server/games/kartRace.js` skeleton.** Constants, state shape comment
  block (like `roomStore.js`'s inline phase comments), empty contract exports wired to
  stub functions. Verify: `require('./kartRace')` doesn't throw, shape matches §3.6.
- [x] **Step 4 — `nearestTrackPoint` + physics tick, no items/hazards/scoring yet.**
  Wire `startKartRace`/`krInput`/the tick loop just enough that karts move, turn, and
  respect the track boundary. Verify: log kart state server-side for a fake room, confirm a
  kart with constant `steer: 0` and no braking loops the track and its `arcLength` increases
  monotonically per tick (mod wraparound).
- [x] **Step 5 — Checkpoints, laps, finish, `krEndRace`, scoring.** Verify: same manual
  log-driven check — after enough ticks, `nextCheckpointIndex` cycles 0→5→0 and `lap`
  increments; forcing `finished = true` on all karts and calling the End Race path produces
  a sane `krResults` order and calls `ctx.addScore` the expected number of times.
- [x] **Step 6 — Items, hazards, kart-kart collision.** Verify: place a kart's mocked
  position exactly on an item box / oil slick / wall-hazard waypoint and confirm the
  expected state change happens on the next tick.
- [x] **Step 7 — Disconnect/reconnect/repair.** Verify: disconnect a kart mid-tick-loop
  (kill its socket in a test client), confirm it freezes and stops colliding; reconnect,
  confirm it resumes receiving `krState` and can move again.

## 4. `server/gameRegistry.js` wiring

```js
const kartrace = require('./games/kartRace');
// ...
const GAMES = { imposter, codenames, tenseconds, menifot, kartrace };
```

That's the entire change — `ROOM_SAVED_FIELDS`, handler registration, disconnect/reconnect
dispatch, and load-repair all pick it up automatically through the existing `Object.values(GAMES)` loops.

- [x] **Step 8 — Wire into `gameRegistry.js`.** Verify: server boots clean, the other four
  games are unaffected (`node server.js`, spot-check one existing game still loads).

## 5. Client shell changes

### 5.1 Vendor Three.js

Download the ES module build of Three.js (r1xx, whatever's current stable) to
`public/vendor/three/three.module.js`. Add an import map to `index.html`'s `<head>`:

```html
<script type="importmap">
  { "imports": { "three": "/vendor/three/three.module.js" } }
</script>
```

### 5.2 `index.html`

- `<script src="client.js"></script>` → `<script type="module" src="client.js"></script>`.
- New tile in `#game-choice`, matching the existing four exactly:
  ```html
  <button id="choose-kartrace-btn" class="game-tile" type="button">
    <span class="game-tile-icon">🏎️</span>
    <span class="game-tile-name">Kart Race</span>
    <span class="game-tile-sub">Race the shared track</span>
  </button>
  ```
- New `<section id="kart-race-screen" class="screen hidden">`, structured like `ts-screen`
  (one section, sub-panels toggled by phase):
  ```html
  <section id="kart-race-screen" class="screen hidden">
    <div id="kr-ready-panel" class="hidden">
      <ul id="kr-player-list" class="player-list"></ul>
      <button id="kr-start-btn" class="hidden" disabled>Start Race</button>
      <p id="kr-ready-error" class="error"></p>
    </div>

    <div id="kr-race-panel" class="hidden">
      <canvas id="kr-canvas"></canvas>
      <p id="kr-countdown" class="hidden"></p>
      <div id="kr-hud">
        <span id="kr-lap-display"></span>
        <span id="kr-rank-display"></span>
      </div>
      <div id="kr-controls">
        <button id="kr-left-btn">◀</button>
        <button id="kr-right-btn">▶</button>
        <button id="kr-brake-btn">BRAKE</button>
        <button id="kr-item-btn" class="hidden"></button>
      </div>
      <button id="kr-end-race-btn" class="hidden">End Race</button>
    </div>

    <div id="kr-results-panel" class="hidden">
      <ol id="kr-results-list"></ol>
      <h2 class="scoreboard-heading">Scoreboard</h2>
      <ol id="kr-scoreboard" class="scoreboard-list"></ol>
      <button id="kr-play-again-btn" class="hidden">Play Again</button>
    </div>
    <button id="kr-back-btn" class="secondary hidden">Back to Lobby</button>
  </section>
  ```

- [x] **Step 9 — index.html + Three.js vendoring.** Verify: page loads with no console
  errors, `import * as THREE from 'three'` resolves in devtools, the new tile/section exist
  but do nothing yet (client.js isn't wired to them).

### 5.3 `public/client.js` (minimal shim — additive only)

```js
import { KartRace } from './js/games/kartRace.js';
// ...
const screens = { /* existing 8 entries */, kartRace: document.getElementById('kart-race-screen') };
// ...
chooseKartRaceBtn.addEventListener('click', () => chooseGame('kartrace'));
// ...
socket.on('krState', (data) => {
  KartRace.applyState(data);
  showScreen('kartRace');
});
// ...
// inside the existing socket.on('backToLobby', () => { ... }) block, alongside
// stopTsTick() / stopCnTimerTick():
KartRace.stop();
```

`KartRace.init(socket)` is called once at module load (top-level, alongside the existing
top-level `const socket = io();`) — it wires up button listeners and builds the Three.js
scene/renderer against `#kr-canvas`, but does nothing visible until `applyState` starts
feeding it data and `showScreen('kartRace')` unhides the section.

- [x] **Step 10 — Wire `client.js`.** Verify: choosing Kart Race from the lobby with 2+
  players reaches the ready screen and shows the player list (no 3D yet if §6 isn't done —
  fine, verify the screen/state plumbing in isolation first).

## 6. Client module (`public/js/games/kartRace.js`)

```js
import * as THREE from 'three';

export const KartRace = {
  init(socket) { /* one-time: fetch track JSON, build scene/renderer, wire button listeners */ },
  applyState(data) { /* buffer latest krState broadcast for interpolation + update HUD/panels */ },
  stop() { /* cancel the rAF loop, reset local buffers */ },
};
```

### 6.1 One-time setup (`init`)

- `fetch('/data/kart-track.json')` → build track meshes: a flat ribbon/plane along the
  centerline (width = `2 * trackHalfWidth`) for the drivable surface, plus simple primitive
  markers for item boxes (small rotating cubes), oil slicks (flat dark ellipses), wall
  hazards (boxes), and a finish-line stripe at waypoint 0. All low-poly `THREE.Mesh` +
  `MeshBasicMaterial`/`MeshStandardMaterial` — no imported models, per the spec.
  Also: kart mesh (a single simple shape, e.g. a box body + 4 small cylinder wheels, or even
  just a colored box for v1 — cosmetic polish is not the point), instanced once per
  `krPlayers` entry using the same 8-color palette by player index.
- Camera: `THREE.PerspectiveCamera`, updated every render frame to sit behind-and-above the
  local player's kart mesh (`camera.position.lerp(desiredOffset, smoothingFactor)` each
  frame, `camera.lookAt(kart position)`), not on a fixed track-wide view.
- Button listeners: `pointerdown`/`pointerup` on `#kr-left-btn`/`#kr-right-btn` set a local
  `steer` var (`-1`/`0`/`1`, right takes priority if both held) and `emit('krInput', { steer, braking })`
  immediately on any change, plus every 200ms as a resend safety net (`setInterval`, only
  while the race panel is visible). `#kr-brake-btn` same pattern for `braking`.
  `#kr-item-btn` (shown/labeled based on the local kart's `heldItem` from the latest
  broadcast) emits a one-shot `krUseItem` on tap.
- `#kr-start-btn`, `#kr-end-race-btn`, `#kr-play-again-btn`, `#kr-back-btn` wire to
  `startKartRace` / `krEndRace` / `playAgainKartRace` / the existing shared `backToLobby`
  emit — same call shape as every other game's equivalent buttons in `client.js`.

### 6.2 `applyState(data)`

`data` is the `krState` broadcast: `{ phase, karts: [{ name, x, z, headingRad, speed, lap, heldItem, spinningUntil, boostUntil, shieldUntil, finished, finishRank, connected }], viewerName, canEndRace, results?, scoreboard? }`.

- Push `{ timestamp: Date.now(), karts: data.karts }` onto a small ring buffer (keep last 2).
- Toggle `#kr-ready-panel` / `#kr-race-panel` / `#kr-results-panel` based on `data.phase`
  (`'ready'` / `'countdown'` | `'racing'` / `'results'`), same visibility-toggling pattern
  `applyTensSecondsState`/`applyMenifotState` already use for their sub-panels.
- Update HUD text (lap count, live rank if easy to derive — e.g. sort by `progress`), the
  item button's label/visibility from the viewer's own kart entry, `#kr-end-race-btn`'s
  visibility from `data.canEndRace`, and the results list / scoreboard from
  `data.results`/`data.scoreboard` when present.
- Start the render loop (`requestAnimationFrame`) on the first call if it's not already
  running; `stop()` cancels it.

### 6.3 Render loop (interpolation)

Each frame: pick a render timestamp `now - RENDER_DELAY_MS` (e.g. `RENDER_DELAY_MS = 100`,
roughly 2 ticks behind), find where that falls between the buffered pair of broadcasts, lerp
each kart's `x/z` and slerp/lerp `headingRad` between the two, update each kart mesh's
position/rotation, update the camera, `renderer.render(scene, camera)`. If only one
broadcast has arrived yet (race just started), render it directly with no interpolation.

- [x] **Step 11 — Static scene.** Build the track/hazard/item-box meshes from the fetched
  JSON with no karts yet. Verify in-browser: enter Kart Race, see the track rendered
  correctly-shaped and stationary, camera positioned sensibly.
- [x] **Step 12 — Kart rendering + interpolation, one browser tab.** Wire `applyState` +
  the render loop for a single local kart. Verify in-browser: steering/braking buttons
  visibly move your kart smoothly (not stepping every 50ms).
- [x] **Step 13 — Two+ browser tabs.** Verify: each tab sees the other's kart moving
  smoothly (interpolated, not snapping), item boxes/hazards trigger the right effects
  visibly, kart-kart collision pushes apart without stopping either kart.
- [x] **Step 14 — Full race flow.** Verify per `../specs/kart-race.md`'s own testing note:
  create room → choose Kart Race → 2+ tabs race a full lap → item boxes and hazards behave
  → finish line triggers ranking → End Race → results + scoreboard update correctly →
  Play Again → Back to Lobby.
- [x] **Step 15 — Disconnect/reconnect.** Verify: close one tab mid-race, confirm its kart
  ghosts (freezes, un-collidable) for everyone else; reopen and rejoin with the same name,
  confirm it resumes and rejoins collision.

## 7. Explicit reminders (don't scope-creep past `../specs/kart-race.md`'s non-goals)

No AI karts, no drift/boost-chaining, no second track, no physics engine dependency, no
manual reverse, no simulated shell projectile, no client-side movement prediction. If any of
these start feeling necessary mid-implementation, that's a sign to stop and re-check the
spec rather than freelance a fix.
