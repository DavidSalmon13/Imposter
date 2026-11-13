# Warfront: code map

Where every part of Warfront lives, so you can open only the 1–3 files a change needs. Rules come
from `docs/specs/warfront-specs.md`, and the build order from `docs/implementation/warfront-plan.md`.
Every file starts with a header comment saying what it owns, what it must not contain, and which
spec or mockup section it implements. **Keep every file at 400 lines or fewer (hard cap 500).** When a
file outgrows that, split it along its seams and update this map.

## 1. Files

### Server engine: `server/games/warfront/engine/` (pure, CommonJS)

No sockets, timers, `Date.now()`, `Math.random()`, OpenAI or DOM in here. Time arrives as `now`, and
randomness comes from `rngFor(seed, tick)` (`server/lib/rng.js`). `tests/games/warfront/engine/purity.test.js`
enforces this.

```
engine/
  constants.js            WF_* engine constants and TUNING (balance numbers)
  data.js                 Races, unit/facility/terrain/weapon/event tables, RPS, SIDES, map sizes, match lengths
  grid.js                 Tile ids/coords, neighbours, terrain lookups, passable, high ground, move cost
  pathing.js              floodFill, bfsPath, findPath (quickest route), pathCost
  mapgen.js               validateMap (AI JSON → normalized map) and the seeded fallback map generator
  state.js                createBattleState, makeUnit, unit lookups, step/build times, slots, stats, round3
  vision.js               visionFor: which tiles a team sees (units, base, held lighthouses)
  systems/movement.js     move orders, headFor/nearestTile, stepping along paths, pickups on arrival
  systems/facilities.js   build/craft orders, placement rules (D4/D17), construction, Workshop queue, losing one
  systems/economy.js      the Worker haul cycle (🔩 carved at the supply wall, 💎 from veins), haul orders, Refinery bonus, income rate
  systems/production.js   spawn points, produce orders, per-spawn-point build queue
  systems/combat.js       ranges, targeting, damage (RPS, luck, strategy edge, Archmage), base/Tower fire, fall back
  systems/lighthouses.js  lighthouse capture each step
  systems/weapons.js      firing a weapon (artillery, emp, airdrop, bombard, aegis): aim rules + effects (Step 10)
  systems/victory.js      win check (last side standing, or the match cap → most base HP)
  commands.js             applyCommand: validates a command and routes it to a system's order* function
  sim.js                  stepSim: calls the systems' step* functions in a fixed order, nothing else
  view.js                 viewForPlayer (fogged live view), own economy, eventsForPlayer, finalView
  index.js                re-exports the public API (exactly what the engine exported before the split)
```

### Server shell: `server/games/warfront/` (CommonJS)

```
warfront/
  index.js        the game-module contract gameRegistry.js loads (+ what tests reach into), no logic
  constants.js    roster limits, WF_TICK_MS, OpenAI timeout, alert throttle, win points
  roster.js       read-only room helpers: room code, team members, match length, startBlocker, canCommandMatch
  payloads.js     wfState per phase, battle/game-over payloads, catalogs, per-socket wfState/wfLive fan-out
  alerts.js       private "Under attack!" wfAlert, throttled per player (owns wfAlertLog)
  loop.js         per-room setInterval sim loop, tickRoom, finishBattle, scoreboard points (owns wfLoops)
  battlefield.js  OpenAI prompt + call (the only OpenAI user), fallback map, starting the battle
  lifecycle.js    room.state.warfront fields + SAVED_FIELDS, back-to-lobby reset, contract hooks, restart repair
  handlers.js     socket handlers: guard room/game/phase/authority, call engine or shell, answer callback
```

### Client: `public/js/games/warfront/` (ES modules)

```
warfront/
  index.js              Warfront = { init, applyState, applyJoin, stop }: routes by phase, wires DOM events
  battle.js             renderBattle (wfState in playing) + applyLive (every wfLive): calls renderers in order
  store.js              S: the one shared mutable store (every former module-level let/Map/Set)
  dom.js                every $('wf-…') lookup, grouped by screen
  constants.js          menus, world geometry, race/facility/weapon/unit names, card names, hotkeys
  util.js               el, noise, emit, flashError, feed (notice lines over the map)
  clock.js              serverNow, syncClock (skew-smoothed server clock for tweening)
  sprites.js            SVG art (units, castles, terrain, facilities, tokens) lifted from the mockups
  teamSelect.js         the team-select screen
  world/geometry.js     tileCentre, elevationAt, ent, billboard, plateaus, standPoint, stepPoint, compass
  world/build.js        buildWorld: the static battlefield (terrain, plateaus, decor, bases, layers)
  units.js              unit stacks: grouping, sprite/labels, placement, tweening (startTween), HP bar painted in place
  stackSig.js           pure: make-up sig (when a stack rebuilds), per-soldier HP segments + colour class (tested)
  orders.js             own march lines + destination marker
  fog.js                fog sheet + lifting it where the team sees
  minimap.js            the 1:10 minimap (terrain, units, fog)
  camera.js             minimap view box sync, lookAt, desktop mouse pan
  map-objects.js        weapon tokens, dropped loads, lighthouses, castles (burning)
  structures.js         facilities/towers on the field (Step 9) + build-mode hint tiles
  fx.js                 one-shot combat effects from events, march dust, Under attack alert
  attacks.js            per-unit attack animations: each type's strike, when it fires, hit flinch
  projectiles.js        shots in flight (3D arc, spell trails) and the impact burst on the target
  menu.js               in-battle ☰ menu: Restart battle (host/captain), Back to lobby
  hud.js                base HP bars, match clock, enemies-in-sight strip
  console/cards.js      Produce cards (per race), produceUnit
  console/build.js      Produce/Build tabs, Build cards (arm a facility), Workshop weapon cards (craft)
  console/selection.js  info well (stack/structure/lore), Move/Haul/Hold/All button state, sendOrder
  console/bulk.js       Select all (fighters, again: + Workers)
  console/weapons.js    Weapons tab: arsenal cards, firing mode (arm → tap a tile), fireAt
  console/buildingInfo.js  a building in the info well (picked or long-pressed, Step 24) + the long-press gesture
  input.js              onTileTap: select, pick a facility, move, haul, place an armed build
  gameOver.js           the game-over screen
```

### Styles: `public/warfront/` (linked from `public/index.html` in this order, which is the cascade)

```
shell.css          full-screen shell + scoping rules shared by every Warfront screen
team-select.css    team select (1-team-select.html)
battlefield.css    battlefield: camera, plateaus, billboards, orders, squads, overlays, console frame, fog
fx.css             live combat effects, burning castle, HP blink, Under attack banner (3-resolution.html)
attacks.css        per-unit attack keyframes, projectiles + impacts, ground rings, hit flinch (attacks.js, projectiles.js)
console.css        command cards (2c-command-cards.html) + console real-time parts
lighthouses.css    lighthouses on map + minimap
game-over.css      game over (4-game-over.html)
facilities.css     Step 9: tabs, Build + Workshop cards, structures on the field, build hints
weapons.css        Step 10: three tabs, weapon cards, fire hints, EMP'd building, Aegis dome, weapon FX
```

Every rule is scoped through a screen id. Selectors and class names are shared with the markup in
`public/index.html` (`#wf-team-screen`, `#wf-screen`, `#wf-gameover-screen`).

### Tests: `tests/games/warfront/`

```
engine/<module>.test.js   one per engine module (data, pathing, mapgen, state, movement, economy,
                          production, facilities, combat, lighthouses, weapons, victory, view, sim, purity, sides)
fixtures.js               engine helpers: rawMap, makeBattle, run, fight, lightBattle, plantBuilt,
                          move/produce/haul/build/craft shorthands, SEEDS, spread
handlers.test.js          team-select handlers, guards, contract
battlefield.test.js       AI map, fallback, timeout, cancel, lighthouses on AI maps
loop.test.js              sim loop, wfCommand, fogged wfLive, alerts, economy, facilities, persistence
gameOver.test.js          win, game over, points, Play Again
client/*.test.mjs         pure client helpers (DOM-free modules only, e.g. stackSig.js), imported as ES modules
shellFixtures.js          shell helpers: setup, readyRoom, aiMap, startWith, playingRoom, plant, …
```

`npm test` (`node --test`) finds these recursively, so new test files need no registration.

## 2. To change X, edit Y

| To change… | Edit |
| --- | --- |
| A unit's stats (HP, attack, cost, move, range) | `engine/data.js` (`UNIT_TYPES`); the client's `UNIT_MAX_HP`/`UNIT_NAMES` in `client constants.js` if HP/name changed |
| A balance number (start Supply, attack speed, carry cap…) | `engine/constants.js` (`TUNING`) |
| Add a unit type | `engine/data.js` → art in `sprites.js` (`UNIT_SPRITES`, `UNIT_ICONS`) → `constants.js` names/hotkeys/card names (client) → tests in `engine/production.test.js` |
| Pathing or a terrain's move cost | cost: `engine/data.js` (`TERRAIN_TYPES`); lookups: `engine/grid.js`; search: `engine/pathing.js` |
| Combat damage, targeting, ranges, high ground | `engine/systems/combat.js` (+ `isHigh` in `engine/grid.js`); RPS tables in `engine/data.js` |
| Economy rates (Supply carving, supply wall, vein load) | `engine/systems/economy.js` + numbers in `engine/constants.js` |
| Facilities / build rules | `engine/systems/facilities.js` (+ `FACILITIES` in `engine/data.js`); client: `console/build.js`, `structures.js`, `facilities.css` |
| A new player command | `engine/data.js` (if it needs data) → `engine/systems/<system>.js` (`orderX`) → `engine/commands.js` (route + validate) → shell `handlers.js` only if it's a new socket event (commands ride `wfCommand`) → client `console/*.js` (button) and/or `input.js` (tap) → tests next to the system |
| What a player sees in the fog | vision radius: `engine/vision.js`; what's sent: `engine/view.js`; drawing: `fog.js` (+ `minimap.js`) |
| Map generation / the AI prompt | prompt + OpenAI call: shell `battlefield.js`; validation + fallback map: `engine/mapgen.js` |
| The sim tick (order of systems) | `engine/sim.js`; the interval/timing: shell `loop.js` |
| A payload field | shell `payloads.js` (wfState/battle/game over) or `engine/view.js` (wfLive); client reader: `battle.js` → the renderer that uses it |
| Who may start / roster rules | shell `roster.js` (+ `handlers.js` for the socket event) |
| Persisted fields / restart repair | shell `lifecycle.js` (`SAVED_FIELDS`, `createState`, `repairOnLoad`) |
| Team select | `teamSelect.js` + `team-select.css`; server: `handlers.js` (events), `payloads.js` (`teamSelectInfo`) |
| Terrain look | `world/build.js` + `world/geometry.js` (plateaus) + `battlefield.css`; art in `sprites.js` |
| Unit stacks and animation | `units.js` (+ `standPoint`/`stepPoint` in `world/geometry.js`, `clock.js` for timing); styles in `battlefield.css` (squads) |
| Minimap | `minimap.js` (+ `camera.js` for the view box, `map-objects.js` for lighthouse markers) |
| Combat effects | `fx.js` + `fx.css`; per-unit strikes: `attacks.js`, projectiles + impacts: `projectiles.js`, both styled in `attacks.css` |
| HUD (base HP, clock, strip) | `hud.js` + `battlefield.css`/`fx.css` |
| The info well / Move-Haul-Hold | `console/selection.js` (+ `console/buildingInfo.js` for buildings) + `console.css` |
| Command cards | Produce: `console/cards.js`; Build/Workshop: `console/build.js`; styles `console.css`, `facilities.css` |
| Tap behaviour on the map | `input.js` |
| Game over | client `gameOver.js` + `game-over.css`; server `payloads.js` (`gameOverPayload`), `loop.js` (`finishBattle`, points) |
| A screen's styles | the matching file in `public/warfront/` (see §1) |
| Under attack alerts | server `alerts.js`; client `onAlert` in `fx.js` |

## 3. Dependency rules

Imports go one way only. There are no circular imports. A lower layer never imports a higher one.

**Engine** (each file may import only from layers above it in this list):

1. `constants.js`
2. `data.js`
3. `grid.js`
4. `pathing.js`
5. `mapgen.js`
6. `state.js`, then `vision.js` (6b: it lives here, not in `view.js`, because facilities' build rule needs it)
7. systems, in this order: `movement` → `facilities` → `economy` → `production` → `combat` →
   `lighthouses` → `weapons` → `victory`. A system imports layers 1–6b and may import an **earlier** system
   in this order, never a later one. Today economy uses movement (`headFor`/`nearestTile`), production uses economy (`autoCarve`), and combat
   uses movement (`orderMove`) and facilities (`loseFacility`). Everything else imports layers 1–6b only.
8. `commands.js` (order* functions only)
9. `sim.js` (step* functions only)
10. `view.js`
11. `index.js`

**Shell:** `constants` → `roster` → `payloads` → `alerts` → `loop` → `battlefield` → `lifecycle` →
`handlers` → `index`. Shell files import the engine only through `engine/index.js`.

**Client:** `store`, `dom`, `constants` and `sprites` are leaves (no imports from Warfront modules
except `store`). Next come `util` and `clock`, then `world/geometry`, then the renderers (`fog`,
`minimap`, `units`, `orders`, `structures`, `map-objects`, `camera`, `fx`, `hud`, `world/build`),
then `console/*` and `input`, then `battle`/`gameOver`, then `index`. **No module imports `index.js` or
`battle.js`** (only `index.js` imports `battle.js`). Shared mutable state goes in `S` (`store.js`),
each field commented with which module writes it. Don't add a module-level `let` anywhere else.

## 4. Where new steps go

| Step | Server | Client |
| --- | --- | --- |
| 9 Facilities + towers (done) | `engine/systems/facilities.js`, Tower fire in `systems/combat.js` | `structures.js`, `console/build.js`, `facilities.css` |
| 10 Special weapons (done) | new `engine/systems/weapons.js` (`orderWeapon`, effects; aegis/emp state), route in `commands.js`, any step in `sim.js`; numbers in `data.js` (`WEAPON_EFFECTS`) | new `console/weapons.js` (Weapons tab + firing mode), FX per id in `fx.js` (split to `fx/weapons.js` if it passes 400), styles in a new `public/warfront/weapons.css` linked after `facilities.css` |
| 11 Battlefield events | new `engine/systems/events.js` (`rollEvent`, effects), called from `sim.js`; shell `battlefield.js`-style async flavour in a new `eventFlavor.js` (OpenAI), never awaited in `loop.js` | event banner in a new `eventBanner.js`, called from `battle.js`; styles in a new `events.css` |
| 12 Private team channel | new shell `teamChannel.js` (handlers + per-socket fan-out + rate limit), registered from `handlers.js`; `TEAM_PHRASES` in `engine/data.js` | new `teamChannel.js` (+ css) |
| 13 Reconnect / restart hardening | shell `lifecycle.js` (`reconnectPayload`, `repairOnLoad`), `loop.js` | `index.js` (`applyJoin`), `battle.js` |
| 14 Design fidelity | none | the renderer/CSS file for each screen (see §2) |
| 15 Performance + balance | payload size: `engine/view.js`, `payloads.js`; tick time: `engine/sim.js`/systems; balance: `engine/constants.js` (`TUNING`), `engine/data.js` | `units.js` if enemy stacks change shape |
