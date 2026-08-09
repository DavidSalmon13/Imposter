# Kart Race — Specs

A same-room party game, fifth game in this app alongside Imposter, Codenames, 10 Seconds,
and Menifot. Every connected player drives a kart around one shared, fixed 3D track
(rendered with Three.js, low-poly primitives, no imported models). First kart to complete
the lap and cross the finish line wins; a host-controlled "End Race" button closes out the
race for everyone else, ranked by progress.

## Relationship to Imposter / Codenames / 10 Seconds / Menifot / shared app changes

- Fifth option on the "Choose a game" screen, using the same `chooseGame` socket event
  pattern: `room.game = 'kartrace'`.
- Reuses the shared lobby, host concept (first joiner, reassigned on disconnect), room-code
  model, and the shared per-room `room.scoreboard` (see `scoreboard-specs.md`).
- Mid-race joins are blocked the same way as the other four games: once the room leaves the
  shared lobby phase, new joiners get "Game in progress, wait for the next round."
- "Back to Lobby" (host-only, available any time) returns everyone to the shared lobby /
  choose-a-game screen, roster intact, clearing only Kart Race state — same pattern as the
  other four games.
- No ChatGPT / external API calls needed — this is physics/state logic only, like 10 Seconds
  and Menifot.
- Unlike the other four games, Kart Race renders a live 3D scene per client (Three.js) and
  runs a continuous per-room server tick while `phase === 'racing'`, rather than reacting
  only to discrete player actions. This is new to the app; see "Server authority &
  networking model" below.

## Configurable constants

Kept as named constants (matching `MF_MIN_PLAYERS` / `TS_MIN_PLAYERS` etc.) so values can be
tuned later without touching game logic. Defaults below are a reasonable v1 starting point,
not settled numbers — tune by playtesting once it's running.

| Constant | Default | Meaning |
|---|---|---|
| `KR_MIN_PLAYERS` | 2 | Floor to start a race |
| `KR_MAX_PLAYERS` | 8 | Ceiling — track/HUD readability and O(n²) kart-kart collision cost |
| `KR_LAP_COUNT` | 1 | Laps to finish. Configurable later, fixed at 1 for v1 |
| `KR_COUNTDOWN_MS` | 3000 | "3…2…1…GO" before racing starts, same pattern as 10 Seconds |
| `KR_TICK_MS` | 50 (20Hz) | Server physics step **and** broadcast interval — combined, no separate substep |
| `KR_MAX_SPEED` | tuned in-engine | Top forward speed under auto-accelerate |
| `KR_ACCEL` | tuned in-engine | Forward acceleration while not braking |
| `KR_BRAKE_DECEL` | tuned in-engine | Deceleration while braking |
| `KR_TURN_RATE` | tuned in-engine | Max turn (rad/s) at full steer input, scales down at low speed |
| `KR_TRACK_HALF_WIDTH` | tuned in-engine | Corridor half-width for on/off-track collision |
| `KR_KART_RADIUS` | tuned in-engine | Bounding radius used for kart-kart and hazard distance checks |
| `KR_ITEM_BOX_COUNT` | 4 | Fixed item box placements around the loop |
| `KR_ITEM_BOX_RESPAWN_MS` | 8000 | Time before a taken box can grant an item again |
| `KR_BOOST_MULTIPLIER` | 1.6× | Speed multiplier while a boost is active |
| `KR_BOOST_DURATION_MS` | 3000 | Boost duration |
| `KR_SHIELD_DURATION_MS` | 8000 | Shield expires after this long even if never hit |
| `KR_SHELL_RANGE` | tuned in-engine | Forward cone/radius the shell checks for a target |
| `KR_OIL_SLICK_COUNT` | 2 | Fixed oil slick placements |
| `KR_WALL_HAZARD_COUNT` | 2 | Fixed in-track wall-obstacle placements |
| `KR_SPINOUT_DURATION_MS` | 1200 | Steering disabled + speed cut, from oil slick or a landed shell |
| `KR_CHECKPOINT_COUNT` | 6 | Evenly spaced ordered checkpoints around the loop (checkpoint 0 = finish line) |

## Phases

```
lobby (shared) → ready → countdown → racing → results → (playAgain | backToLobby)
```

- **ready**: shows the full connected-player list and a host-only "Start Race" button.
  Roster is **not** required to be fully connected to start (unlike 10 Seconds) — whoever is
  connected when the host presses Start becomes `room.krPlayers`, frozen for the race, same
  pattern as Menifot's `mfPlayers`. Players who join later see the "game in progress" gate.
- **countdown**: fixed `KR_COUNTDOWN_MS` "3…2…1…GO" shown to everyone, driven by a single
  server-broadcast `room.krRaceStartAt` epoch timestamp, same mechanism as 10 Seconds'
  `tsRoundStartAt`. Karts are placed at the start line but auto-accelerate doesn't begin
  until the timestamp passes.
- **racing**: the live 3D race. Server runs the authoritative tick (see below); every client
  renders all karts, the track, item boxes, and hazards. A host-only **"End Race"** button
  appears once at least one kart has finished (see "Race end" below).
- **results**: ranked list of every racer (finish order, or checkpoint-progress order for
  anyone who hadn't finished when the host ended the race), plus the updated scoreboard.
  Host-only **"Play Again"** and **"Back to Lobby"** buttons.

## Track

- Single hardcoded closed loop: a rounded oval (two straights + two curved ends), authored
  as an ordered list of centerline waypoints. No level editor, no track selection.
- `KR_CHECKPOINT_COUNT` evenly-spaced checkpoints along that same loop, checkpoint 0 doubling
  as the finish line. A lap only counts once a kart has crossed every checkpoint **in order**
  (0, 1, 2, … back to 0) — crossing out of order (e.g. cutting across the infield) is simply
  ignored, no penalty beyond not progressing. No anti-cheat beyond this ordering check.
- **On/off-track collision**: each tick, compute the kart's distance from the nearest
  centerline segment. Within `KR_TRACK_HALF_WIDTH`, no effect. Beyond it, the kart is pushed
  back toward the centerline and loses some speed — the track boundary behaves like a soft
  wall, not a hard stop.
- **Item boxes**: `KR_ITEM_BOX_COUNT` fixed points around the loop (roughly evenly spaced).
  Driving through one while not already holding an item grants one random power-up (equal
  weight across the 3 types) and starts that box's `KR_ITEM_BOX_RESPAWN_MS` cooldown; driving
  through an empty (recently-taken) or already-holding-an-item box does nothing.
- **Hazards**: `KR_OIL_SLICK_COUNT` oil slicks and `KR_WALL_HAZARD_COUNT` wall obstacles at
  fixed points on the track (not randomly generated, not regenerated between rounds). Both
  are always active — no cooldown, unlike item boxes.
  - **Oil slick**: driving over one (without an active shield) triggers a spin-out —
    steering disabled and speed cut for `KR_SPINOUT_DURATION_MS`.
  - **Wall obstacle**: a static in-track prop, distinct from the track boundary. Colliding
    with one bounces the kart back along its direction of travel and cuts its speed, using
    the same response magnitude as the track-boundary collision.

## Controls & camera

- Touch-friendly on-screen controls: left/right steer buttons, a brake button. No manual
  accelerate — auto-accelerate toward `KR_MAX_SPEED` whenever not braking.
- Braking decelerates toward 0 but **never produces reverse movement** — there is no manual
  reverse in v1. The only backward motion a kart ever experiences is the bounce-back from a
  wall-obstacle or track-boundary collision.
- A fourth on-screen button, **"Use Item"**, appears only while the player is holding an item
  (see "Items" below); tapping it fires/activates that item and clears the slot.
- Each client renders a third-person chase camera following its own kart (fixed offset
  behind and above, smoothed toward the kart's current position/heading). Other players'
  karts are rendered as low-poly kart models in a fixed color from an 8-color palette (one
  color per `KR_MAX_PLAYERS` slot), for at-a-glance identification.

## Server authority & networking model

- **Fully server-authoritative, no client-side prediction** — including for a player's own
  kart. The client never moves any kart itself; it only sends input and renders whatever the
  server last broadcast. This matches the rest of the app (every other game is a dumb client
  driven by server state) and avoids maintaining two copies of the physics model in lockstep.
  The tradeoff is up to one `KR_TICK_MS`-ish interval of input latency, acceptable for a
  same-room/same-wifi casual party game.
- **Client → server**: a `krInput` event `{ steer: -1|0|1, braking: bool }` sent immediately
  on any change, plus a periodic resend as a safety net against a dropped packet. A separate
  one-shot `krUseItem` event fires when the item button is tapped (it's a discrete action,
  not part of the continuous input state).
- **Server tick**: one `setInterval` per active room at `KR_TICK_MS`, running only while
  `room.phase === 'racing'` (started on entering `racing`, cleared on leaving it) — same
  per-room-timer-handle pattern already used for `cnTimerHandles` / `tsForceStopHandles`.
  Each tick: advance every kart's kinematic state (accel/turn/friction) from its last input,
  resolve track/hazard/kart-kart collisions, resolve any pending item-box pickups and item
  uses, check checkpoint/lap/finish crossings, then broadcast a `krState` event with every
  kart's transform (`x, z, headingRad, speed`) plus per-kart status (`lap`,
  `nextCheckpointIndex`, `heldItem`, `spinningUntil`, `boostUntil`, `shieldUntil`, `finished`,
  `finishRank`, `connected`).
- **Client interpolation**: every kart (including the local player's) is rendered by
  buffering the last two `krState` broadcasts and interpolating position/heading between
  them on a short render delay, rather than snapping to each new broadcast — smooths out the
  visible steps between `KR_TICK_MS`-spaced updates.

## Items

- One item slot per kart, held until used. Picking up a box while already holding an item
  does nothing (no stacking, no swapping).
- Three power-ups, equal random weight:
  - **Speed Boost** — `KR_BOOST_MULTIPLIER`× top speed for `KR_BOOST_DURATION_MS`.
  - **Shield** — blocks the next hit (shell or hazard) taken within `KR_SHIELD_DURATION_MS`;
    consumed on block, or simply expires if never hit.
  - **Shell** — instant lock-on, no simulated projectile. On use, the server checks for the
    nearest other kart within a forward cone/radius (`KR_SHELL_RANGE`) of the firing kart; if
    one is found and it isn't shielded, that kart immediately spins out (same effect and
    duration as an oil slick). If no target is in range, the shell is simply consumed with no
    effect (no partial refund).
- Disconnected (ghosted, see below) karts are not valid shell targets and don't trigger
  item-box pickups on their own (they're not being driven).

## Kart-kart collision

- Gentle push-apart: when two karts' bounding circles (`KR_KART_RADIUS`) overlap, each tick
  nudges both apart along the line between their centers, proportional to overlap depth, with
  both keeping most of their speed. No hard stop, no speed-loss penalty beyond the sideways
  push — bumping into someone costs a little momentum, not the race.

## Race end

- **Finishing**: a kart finishes when it completes `KR_LAP_COUNT` lap(s) — crosses every
  checkpoint in order and then crosses the finish line (checkpoint 0) again. Finish order is
  recorded live as karts finish (`finishRank`), visible to everyone during `racing`.
- Once the first kart finishes, a host-only **"End Race"** button appears (racing continues
  live for everyone else in the meantime — finishing first doesn't stop the race by itself).
- When the host presses **End Race**, `room.phase` moves to `results`. Any kart that hadn't
  finished is ranked by current progress (lap number, then checkpoint index reached) below
  every kart that did finish.

## Disconnect / reconnect

- **Mid-race disconnect**: the kart freezes in place (stops accelerating, holds its last
  position/heading) and becomes a **ghost** — excluded from kart-kart collision checks so a
  dropped connection can't block the track or unfairly wall off other racers. It also stops
  being a valid shell target while ghosted.
- **Reconnect**: the player's kart resumes at its last known state (position, heading, lap
  progress, held item, any active spin-out/boost/shield timers) and rejoins collision checks
  normally. The reconnecting client's next `krState` broadcast picks it back up like any other
  kart — no special resync step needed, since the server never stopped simulating (a frozen,
  ghosted kart is still part of `room.krKarts`, just not colliding and not receiving new
  input).
- A player who disconnects during `ready` (before the race starts) is simply not included
  when the host presses Start — `room.krPlayers` is frozen from whoever is connected at that
  moment, same as Menifot's `mfPlayers`.

## Scoring

Points are awarded via `ctx.addScore` once, when the host presses **End Race**, based on
final `results` ranking:

| Placement | Points |
|---|---|
| 1st | **+3** |
| 2nd | **+2** |
| 3rd | **+1** |
| Everyone else (4th and below, including non-finishers) | **0** |

This should also be added as a row in `scoreboard-specs.md`'s point-values table for
consistency with the other four games, as part of implementation.

## Server state additions

- `room.krPlayers`: frozen roster (names) for the current race, set from connected players
  when the host presses Start.
- `room.krKarts`: map of name → `{ x, z, headingRad, speed, lap, nextCheckpointIndex,
  heldItem, spinningUntil, boostUntil, shieldUntil, finished, finishTime, finishRank,
  connected }`.
- `room.krRaceStartAt`: epoch ms the countdown ends and racing begins, or `null` outside
  `countdown`.
- `room.krItemBoxes`: array of `{ id, takenUntil }` — fixed positions live in code (not
  persisted, since they're static), only pickup/respawn state is per-room.
- `room.krResults`: final ranked list, populated when the host presses End Race.

## Play Again / Back to Lobby

- **Play Again** (host-only, from `results`): brings back every currently-connected player
  (re-freezes `room.krPlayers`), resets all kart/item-box/race state, and starts a new
  `ready` phase. Matches the other four games' full-reset model.
- **Back to Lobby** (host-only, available any time including mid-race): returns everyone to
  the shared lobby, roster intact, clears all Kart Race state (stops the server tick if one
  is running).

## Explicitly out of scope (v1)

- No AI/bot karts.
- No drifting/boost-chaining mechanics.
- No multiple tracks or track editor — one hardcoded loop.
- No physics engine (cannon-es/rapier, etc.) — simple kinematic accel/turn/friction only.
- No manual reverse.
- No simulated projectile flight for the shell — instant lock-on only.
- No spectator mode beyond the existing lobby/back-to-lobby flow.
- No client-side movement prediction — fully server-authoritative, accepted input latency.
- No anti-cheat / server-side verification beyond checkpoint-order gating for laps.
- No persistent leaderboard or champion tally across Play Again sessions, beyond the shared
  per-room `room.scoreboard`.
