# Warfront: Implementation Plan

Turns `../specs/warfront-specs.md` into code. That spec is the source of truth for *rules* (what the
game does); this doc is the source of truth for *how it gets built*: file names, function names,
event names, the decisions the spec leaves open, and a step order where every step ends in
something you can run (`npm test`) and play in a browser.

**The game must look exactly like `docs/design/warfront/`** (spec section "Look & feel — the design is
binding"). Every client step below ports the matching mockup's markup, CSS and SVG directly, from
the first screen onward; there is no placeholder-art phase. A client step isn't done until its
screen matches its mockup side by side (open the mockup and the game on the same phone width and
compare), apart from the round-based elements the spec's swap table replaces.

Read `../specs/warfront-specs.md` in full before Step 1. This doc doesn't repeat rule details, only
where they land in code. Read `refactor_plan.md` §4 for the game-module contract.

Warfront is the app's **first live simulation**. Every other game is event-driven: a socket message
arrives, state changes, everyone gets a broadcast. Warfront also has a **per-room loop** that
advances the world 5×/s whether or not anyone taps anything. Almost everything novel about this
plan follows from that: a pure engine, a loop owned by the module, a static/dynamic payload split,
and stricter cleanup of interval handles.

## Decisions this plan makes (spec gaps)

The spec leaves these open or contradicts itself. D1, D2, D4, D8–D12 and the map sizes / match
lengths were **agreed with David on 2026-11-11**; D3, D5–D7 are engine-level clarifications, and the
numbers are proposed starting values for the balance pass. **Step 0 folds all of it back into the
spec**; change anything there first.

**Rules that were contradictory or vague**

| # | Topic | Decision |
|---|---|---|
| D1 | Who starts the match | **Host or either captain** may tap Start Battle / Play Again (team-select says captain, Start says host, game-over says both; this unifies them). Host-only options (match length, map size, randomize) stay host-only. |
| D2 | "Minerals buy elite units" | **Basic units cost 🔩 Supply only; advanced units cost 🔩 Supply + 💎 Minerals**, more Minerals the stronger the unit (prices in "Unit prices" below). Workers are Supply-only too, so a player can always rebuild an economy and a basic army. Minerals also buy facilities, towers and Workshop weapons. Rewrite the spec's Cost-currency paragraph and add a 💎 column to the race tables. |
| D3 | Bastion "damages enemies on its tile" | Bastion is a structure with **range 0** (its own tile only). Same range system as everyone else. |
| D4 | "Friendly-controlled tile" (where you may build) | **Anywhere your team can see**: a tile is buildable if it is currently in the player's team vision (`WF_VISION`), passable, has no enemy unit on it, and has no structure. A **Refinery** additionally needs a vein on or orthogonally adjacent to the tile. |
| D5 | `strategyEdge` "nearby" / "dominant class" | For an attacker: the enemy's **dominant class** is the most common RPS class (melee/mounted/ranged) among enemy units within Manhattan 2 of the attacker (tie or none → no dominant class → edge 0). `strategyEdge` = fraction of the attacker's team's RPS units within Manhattan 2 that counter it. |
| D6 | Archmage "in any battle it joins" | Real time has no battles, so: a hit whose **attacker is within Manhattan 2 of a friendly Archmage** gets luck ×0.5; a hit whose **target is within Manhattan 2 of an enemy Archmage** gets luck ×1.5. Multiple Archmages don't stack. |
| D7 | Seeded randomness across restarts | Persist `seed` (set at battle start) and `tick` (incremented per step) in `room.state.warfront`. Step N's RNG is `rngFor(seed, tick)`. |
| D8 | Battlemage `aoe` | Hits **every enemy unit on its target's tile** (not every enemy in range), which keeps damage bounded and readable. |
| D9 | Base defense | **Bases have a weak tower-like attack**: atk 2, range 1, `attackMs` 1500 (`TUNING.baseAtk` / `baseRange` / `baseAttackMs`), so a lone raider can't chip a base for free. A base is also "contested" when ≥1 friendly unit stands on the base tile; while contested, enemy units can't damage it (except `bombard`). |
| D10 | Build queues | Each spawn point's queue is **sequential**: one unit builds at a time. `doneAt` of item N+1 starts counting when item N finishes. |
| D11 | Forge "+1 per worker" vs "a bonus" | Forge Workers carve Supply **×1.5 faster** at the supply wall (`TUNING.forgeCarveBonus`; was +0.25/sec before 2026-11-13). Forge's structure discount is **−1 💎** on every facility and tower (`TUNING.forgeStructureDiscount`). Bastion keeps its listed stats; it's already Forge-only. |
| D13 | High ground (added 2026-11-11 with David) | Hills are high ground: ranged units (base `Rng` ≥ 2) get +1 range on hills, −1 range when shooting from low ground at a target on hills; melee (`Rng` 0–1, incl. Workers, Battlemage, towers, Golems, Bastion, a base's attack) only hits targets on the **same level**. Stacks with hills' ×1.45 defense. Implemented in Step 6 as `effectiveRange(state, attacker, target)` + `canReach(...)`. |
| D14 | Under attack (added 2026-11-11 with David) | Hit → private "Under attack!" alert (banner + buzz + tile/minimap ping) for the owner, throttled per player (10 s, or at once if ≥4 tiles from the last alert); base hits alert the whole team. The attacker is revealed to the victim's team for 3 s. An idle unit hit by an enemy it can't hit back falls back ≤3 tiles out of that attacker's reach; units on **Hold** (new `hold` command) never do. |
| D15 | Lighthouses (added 2026-11-11 with David) | 2–4 per map: one near each base (starts owned by that team) + up to 2 contested (start neutral). Stand on it with only your team's units to capture it instantly; both teams or nobody = no change; can't be destroyed. Owner sees Manhattan `WF_LIGHTHOUSE_VISION = 5` around it. Built in **Step 8b**. |
| D16 | Walking speed (changed 2026-11-11 with David) | Much slower than first specced: `WF_STEP_MS_BASE` 900 → **4300** ms, and Move 1/2/3 = speed ×1/×1.5/×2 (`(1 + Move) ÷ 2`) instead of ×1/×2/×3. Medium-map crossing on plains: Warrior ~60 s, Outrider ~40 s, Raider ~30 s. **Then ×1.5 faster (2026-11-11, David): 4300 → 2867 ms** — Warrior ~40 s, Outrider ~27 s, Raider ~20 s. **Then ×1.5 faster again (2026-11-12, David): 2867 → 1911 ms** — Warrior ~27 s, Outrider ~18 s, Raider ~13 s. Movement orders path with A* weighted by terrain move cost (`findPath`), not unweighted BFS. |
| D17 | Facilities (agreed 2026-11-12 with David) | A build places a **construction site** at once (full HP, attackable, no effect or attack until done; destroyed = Minerals lost; counts toward the unit cap). Refinery = owner's Workers load **+1 💎/sec** on that vein (no stacking, enemies get nothing). Workshop command `{ kind:'craft', weaponId }`, **one at a time per player** (sequential `armies[].workshop`). A destroyed facility's work in progress is **lost, no refund** (Barracks queue; Workshop queue when the last Workshop falls). |
| D18 | Weapons (agreed 2026-11-13 with David) | Artillery anywhere, fog included (whiffs are used up; skips roof garrisons). EMP only on an enemy facility/Tower in sight, and it switches off **everything** (Tower fire, Refinery bonus + deposit, Barracks spawn + queue, Workshop crafting, construction) for `empMs`. Bombard on the enemy base, blocked by Aegis. Airdrop on a seen passable tile, as many as fit under the cap (refused at the cap). Artillery kills and Bombard damage count in battle stats. |
| D12 | Unit cap (not in spec) | **New: `WF_MAX_UNITS_PER_PLAYER = 30`** (structures included, Golems included). Produce is a no-op at the cap. Needed to bound payload size and DOM count on phones. |

**Numbers the spec references but doesn't give** (all live in `TUNING` and get revisited in the balance pass, Step 15)

| Constant | Value | Notes |
|---|---|---|
| Ranges (Manhattan) | worker 1, melee/mounted 1, ranged/siege 2, Apprentice 2, Battlemage 1, Summoner 2, Archmage 2, Golem 1, Tower 1, Bastion 0 | stored on `UNIT_TYPES[type].range` |
| `structureDefense` | ×1.5 | extra defense multiplier for every `structure` class unit, stacks with terrain |
| Facilities | Refinery 💎5, HP 15, 8s · Forward Barracks 💎7, HP 20, 10s · Workshop 💎7, HP 15, 10s | cost, HP, build time |
| Tower | 💎4, HP 18, atk 3, range 1, 6s | |
| Workshop weapon | 💎6, 10s per weapon, one at a time | player picks which weapon id |
| `artilleryDmg` | 8 per enemy unit on the tile | goes through terrain/structure defense |
| `bombardDmg` | 15 base HP | ignores contest and terrain |
| `empMs` / `aegisMs` | 15000 / 10000 | |
| Airdrop squad | 3× the firer's race's cheapest melee-ish unit (Militiaman / Warrior / Apprentice) | target must be friendly-visible and passable |
| `supplyDropAmount` | +5 Supply to every player | |
| `sandstormLuck` | `luckMagnitude` ×2 while active | |
| Map sizes | Small 12×8 · Medium 16×11 (matches the mockup) · Large 20×13 | `MAP_SIZES` |
| Match lengths | Short 8 min · Standard 12 min (spec default) · Long 16 min | `MATCH_LENGTHS` |
| `WF_MAX_DT_MS` | 1000 | clamp on one step's `dt` (protects against event-loop stalls) |

**Unit prices** (D2; basic = 💎0; build time stays `buildMsPerCost × Supply cost`; `startMinerals` stays 0 as in the spec)

| Race | Unit | 🔩 Supply | 💎 Minerals |
|---|---|---|---|
| all | Worker | 3 | 0 |
| Forge | Militiaman / Crossbow / Outrider / Bastion / Ballista | 3 / 4 / 5 / 6 / 6 | 0 / 0 / 2 / 3 / 4 |
| Horde | Warrior / Skirmisher / Raider / Berserker / Warchief | 3 / 4 / 5 / 5 / 8 | 0 / 0 / 2 / 2 / 5 |
| Arcane | Apprentice / Mystic Archer / Battlemage / Summoner / Archmage | 3 / 4 / 6 / 6 / 9 | 0 / 0 / 3 / 4 / 6 |

## Architecture

```
socket (wfCommand) ──► handlers.js ──► engine.applyCommand(state, name, cmd, now)   (engine/commands.js)
                                              │  (validates, routes to systems/*.order*, returns ok/no-op)
setInterval(WF_TICK_MS) ─► loop.js tickRoom ──► engine.stepSim(state, dt, { now })    (engine/sim.js)
                                              │  calls systems/*.step* in order; returns { events }
                                              ▼
                     payloads.js broadcastLive: for each connected player
                       io.to(socketId).emit('wfLive', engine.viewForPlayer(state, name))   (engine/view.js)
```

**Where everything lives: `docs/implementation/warfront-code-map.md`** (file tree, "to change X, edit
Y" table, layer rules, where Steps 10–15 put new code). Since Step 8c the code is small
single-purpose modules. Keep every file at 400 lines or fewer (hard cap 500), and split along the
seams the code map describes.

- **`server/games/warfront/engine/` is pure.** No sockets, no OpenAI, no timers, no `Date.now()`.
  Time comes in as `now`, randomness as `rngFor(seed, tick)`. It is layered: `constants` → `data` →
  `grid` → `pathing` → `mapgen` → `state` (+ `vision`) → `systems/*` (movement, facilities, economy,
  production, combat, lighthouses, victory) → `commands` → `sim` → `view`, and `index.js` exports
  the data tables, map helpers, `applyCommand`, `stepSim`, `viewForPlayer` and `winnerByBaseHp`.
  Everything in "Combat/Economy/Movement" in the spec is implemented here and unit-tested here
  (`tests/games/warfront/engine/<module>.test.js`).
- **`stepSim` mutates `state` in place** and returns `{ state, events }` (same object). Cloning a
  few hundred units 5×/s per room is wasted work; tests treat the input as owned by the call.
- **The rest of `server/games/warfront/` is the shell:** `handlers.js`, `battlefield.js` (OpenAI),
  `loop.js` (the interval map), `lifecycle.js` (state, persistence hooks), `payloads.js` +
  `alerts.js` (fan-out), `roster.js` and an `index.js` with the module contract. It should stay thin.
  If a rule shows up here, it belongs in the engine.
- **Static vs live payloads.** The map (tiles, veins, supply sources, bases, theme, lore) never
  changes during a match, so it's sent **once** as `wfState` (on battle start, reconnect and phase
  changes). The 5×/s `wfLive` carries only the dynamic part. This is the main lever on bandwidth
  (see Step 15).
- **The client is a dumb renderer.** It never simulates. Between snapshots it tweens unit stacks
  using each unit's `stepEndsAt`, so movement looks smooth at 5 Hz. `public/js/games/warfront/battle.js`
  calls the renderers (one module each: units, orders, fog, minimap, map objects, structures, fx,
  HUD, console) in a fixed order. Shared mutable state is one `S` object in `store.js`.

## Target files

The layout after Step 8c. Each file's one-line job is in the code map.

**New:**
- `server/lib/rng.js`: `mulberry32(seed)`, `hashSeed(seed, tick)`, `rngFor(seed, tick)`,
  `randomSeed()`. Tiny and dependency-free.
- `server/games/warfront/engine/`: the pure engine (see above). New systems go in
  `engine/systems/<name>.js` (Step 10 `weapons.js`, Step 11 `events.js`) and are wired through
  `commands.js` (orders) and `sim.js` (steps).
- `server/games/warfront/`: the game module (contract per `refactor_plan.md` §4, namespaced like
  `codenames.js`): `index.js`, `constants.js`, `roster.js`, `payloads.js`, `alerts.js`, `loop.js`,
  `battlefield.js`, `lifecycle.js`, `handlers.js`.
- `public/js/games/warfront/`: the client. `index.js` exports `Warfront` (`init` / `applyState` /
  `applyJoin` / `stop`). There is one module per screen part (see the code map), with shared state in
  `store.js` and element lookups in `dom.js`.
- `public/js/games/warfront/sprites.js`: the unit/building/terrain SVG strings, lifted from
  `docs/design/warfront/source/Units.dc.html` and `Main.dc.html`. Created in Step 3 and used by every
  client step; never emoji placeholders.
- `public/warfront/*.css`: `wf-*` styles, one file per screen/part (shell, team-select, battlefield,
  fx, console, lighthouses, game-over, facilities), linked from `index.html` after
  `theme-afterglow.css` in that order (the order is the cascade). A new part gets a new file linked
  last.
- `tests/helpers/` stays as is. Warfront's tests are `tests/games/warfront/`: `engine/<module>.test.js`
  (pure engine, shared helpers in `fixtures.js`) and `handlers`/`battlefield`/`loop`/`gameOver.test.js`
  (the shell through the harness, helpers in `shellFixtures.js`), plus `tests/games/rng.test.js`.

**Touched:**
- `server/gameRegistry.js`: `require('./games/warfront')`, add `warfront` to `GAMES`.
- `server/roomStore.js`: one comment line: `// Warfront phases: 'teamSelect' | 'generating' |
  'playing' | 'gameover'` and `// Warfront fields live in state.warfront`.
- `public/index.html`: `#wf-team-screen`, `#wf-screen` (battlefield), `#wf-gameover-screen`;
  the WARFRONT tile drops `tile-wip` and the "Under construction" sub-label; link `public/warfront/*.css`.
- `public/js/main.js`: import the module, add `warfront` to `GAMES`, replace the "Coming soon"
  poke handler (lines ~690–702) with `socket.emit('chooseGame', 'warfront', ...)`, add
  `WF_MIN_PLAYERS = 2` to `renderLobby`'s underfilled logic, add a "Building the battlefield…"
  label to `showGenerating` if it isn't generic.
- `public/style.css` / `public/theme-afterglow.css`: remove the WIP-tile rules for
  `#choose-warfront-btn` once the tile is live.
- `CLAUDE.md`: "Four games today" is already stale; update the game count/list and mention
  Warfront's sim loop under Architecture.
- `docs/design/warfront/`: add the screens/elements the mockups don't have yet and replace the
  round-based ones (Step 14).

## Event & function naming reference

Prefix `wf` throughout, matching the repo's per-game prefixes. **Warfront registers its own team
events** (it can't reuse Codenames' `joinTeam`/`claimLeader`, which guard on
`room.game === 'codenames'`).

**Client → server** (all `(data, callback)` with `callback({ ok, error })`, every handler guards
`room.game === 'warfront'` and the phase):

| Event | Who / phase | Does |
|---|---|---|
| `joinWfTeam` `(color)` | anyone · `teamSelect` | sets `p.team`, clears `p.leader` on team change |
| `claimWfCaptain` | team member · `teamSelect` | sets `p.leader` if the team has none |
| `setWfRace` `(race)` | anyone · `teamSelect` | `lobbyRaces[name] = race` |
| `setWfOptions` `({ matchLength, mapSize })` | host · `teamSelect` | stores into `phaseConfig` |
| `randomizeWfTeams` | host · `teamSelect` | even split, races untouched |
| `startWarfront` | host or captain (D1) · `teamSelect` | validates teams + races → `generateBattle` |
| `wfCommand` `(cmd)` | army owner · `playing` | `engine.applyCommand`; ack `{ ok }`; **no broadcast** (the next tick shows it) |
| `wfPing` `({ tileId })` | team member · `playing` | fan-out to same-team sockets only; rate-limited |
| `wfTeamMessage` `({ id })` | team member · `playing` | same; `id` must be in `TEAM_PHRASES` |
| `playAgainWarfront` | host or captain · `gameover` | regenerates map, same teams/races → `generateBattle` |

**Server → client:**
- `wfState`: full phase-aware payload from `wfStatePayload(room, viewerName)` (team lists +
  options in `teamSelect`; static map + first live view in `playing`; final state in
  `gameover`). Sent on every phase change, team-select change, and reconnect.
- `wfLive`: `engine.viewForPlayer(state, name)` + this tick's visible `events`, every
  `WF_BROADCAST_MS` while `playing`.
- `wfPing`, `wfTeamMessage`: relayed, same-team only.
- `generating`: reused shared event.

**Engine exports** (`engine/index.js`): `RACES`, `UNIT_TYPES`, `TERRAIN_TYPES`, `TUNING`,
`WEAPON_EFFECTS`, `EVENT_EFFECTS`, `FACILITIES`, `MAP_SIZES`, `MATCH_LENGTHS`, `TEAM_PHRASES`;
`tileId(x,y,w)`, `tileXY(id,w)`, `manhattan`, `neighbors`, `bfsPath(map, from, to)`;
`validateMap(raw, size)`, `buildFallbackMap(size, rng)`; `createBattleState(map, roster, opts)`;
`applyCommand(state, name, cmd, now)`; `stepSim(state, dtMs, { now })`;
`viewForPlayer(state, name)`; `winnerByBaseHp(state)`; `rollEvent(state, rng)`.

**Module-local functions** (`server/games/warfront/*.js`): `createState`, `clearState`, `stopLoop(roomCode)`,
`startLoop(ctx, roomCode)`, `tickRoom(ctx, roomCode)`, `broadcastLive(ctx, roomCode, room, events)`,
`broadcastWfState(ctx, roomCode, room)`, `wfStatePayload(room, name)`,
`generateBattlefield(room, size)` (OpenAI), `generateBattle(ctx, roomCode, room)`,
`fetchEventFlavor(ctx, roomCode, effectId)` (async, off-loop), `finishBattle(ctx, roomCode, room,
winner)`, `awardWfScores(ctx, room, winner)`, plus the contract methods.

## Server state (`room.state.warfront`)

Exactly the spec's "Server state" section, plus:
- `lobbyRaces: { [name]: race }`: picks made during team-select (persisted; copied into
  `armies[name].race` at start; kept for Play Again).
- `seed`, `tick` (D7).
- `winner: 'red' | 'blue' | 'draw' | null`.
- `nextUnitId`: monotonically increasing int for unit ids (persisted, so ids stay unique after a
  restart).
- `workshopQueues` live inside each army as `armies[name].workshop: [{ weaponId, doneAt }]`.

`savedFields` = every key above: Warfront has **no** ephemeral fields inside the namespace. The only ephemeral state is the module-local `wfLoops: Map<roomCode, Interval>` and the
per-socket rate-limit timestamps (`socket.data.wfLastPing`).

## Implementation order

Each step ends with `npm test` green and a browser check. Steps 1–2 are pure and need no browser.

### Step 0: Fold the decisions into the spec ✅
Done 2026-11-11: `docs/specs/warfront-specs.md` now carries D1–D12, the unit prices and the numbers
table. The spec remains the rules source of truth; change a rule there first, then here.

### Step 1: RNG + data tables ✅
Done 2026-11-11. Unit ids are camelCase (`laborer`, `mysticArcher`, …); the tower lives in
`FACILITIES` with its combat stats; engine-side `WF_*` constants (vision, step time, unit cap, dt clamp,
match cap, event interval) are exported from the engine, loop/roster ones are left for the module.
`TEAM_PHRASES` = the mockup's four (`push`/`defend`/`needResources`/`hitBase`). RNG tests live in
`tests/games/rng.test.js`.
- `server/lib/rng.js`. Tests: same seed+tick → same sequence; different tick → different sequence;
  output in `[0,1)`.
- `engine/data.js` data tables only: `RACES`, `UNIT_TYPES` (hp, atk, cost, move, class, range,
  race, flags), `TERRAIN_TYPES`, `TUNING`, `FACILITIES`, `WEAPON_EFFECTS`, `EVENT_EFFECTS`,
  `MAP_SIZES`, `MATCH_LENGTHS`, `TEAM_PHRASES`, `rpsMultiplier(a, b)`.
- Tests: every race has exactly one worker; every unit's race is real; RPS triangle is
  consistent (`rps(a,b) * rps(b,a) ≈ 1` for triangle pairs, 1 for everything outside it).

### Step 2: Map helpers, validation, fallback ✅
Done 2026-11-11. `validateMap` returns a normalized map (tiles as terrain strings, every feature
carries `tileId`, supply sources carry the `team` they serve; bad chokepoints are dropped, not fatal).
"Mirror-fair veins" = the richness-weighted mean Manhattan distance from each base to the veins
differs by ≤ 2; ≤ 8 weapon tokens; features may not share a tile. Also exports `isPassable` and
`floodFill`. Fallback maps mirror across the vertical axis.
- `tileId`/`tileXY`/`neighbors`/`bfsPath` (passable-only BFS, deterministic tie-break order).
- `validateMap(raw, size)`: the spec's hard checks (tile count, enums, one base per team on opposite
  halves and non-adjacent, one supply source adjacent to each base, veins/weapons on passable tiles,
  mirror-fair veins, flood-fill connectivity). Throws with a specific message.
- `buildFallbackMap(size, rng)`: mirror-symmetric (generate the left half, reflect), retry until
  `validateMap` passes (cap attempts; a final plain-plains map always passes).
- Tests: fallback maps pass validation across 200 seeds and all three sizes; hand-built bad maps
  fail with the right reason (disconnected base, missing supply source, bad enum, wrong count).

### Step 3: Module skeleton + team select (first browser step) ✅
Done 2026-11-11. `startWarfront` validates (host/captain, both teams 1–4, every team member has a
race; unassigned players don't block) then stays in `teamSelect` and sends everyone a `wfNotice`
("the battlefield is still being built") until Step 4. Teams are capped at 4 (`WF_MAX_TEAM_SIZE`).
`clearState` keeps `phaseConfig`, `lobbyRaces` and the avoid-lists. `public/warfront/*.css` scopes every
rule through `:is(#wf-team-screen) .wf` so the mockup's buttons beat style.css's global `button`
hover/active rules; add later screen ids to that `:is()`. Additions the mockup doesn't draw, in its
style: a "Not on a team" line, a Back to Lobby button, an error/notice line, and bottom padding that
clears the floating reaction row. Workers have no art yet (needed from Step 4).
- `server/games/warfront/` with `createState`/`clearState`/`onChoose` (→ `teamSelect`, reset `p.team`/
  `p.leader`), team-select handlers, `broadcastWfState`, `reconnectPayload` for `teamSelect`.
  Register in `gameRegistry.js`.
- Client: enable the tile, `#wf-team-screen` ported from `docs/design/warfront/1-team-select.html`
  (Red/Blue columns, race picker, captain button, host options, Randomize, Start), with the mockup's
  "Planning time" control turned into **Match length** (8 / 12 / 16 min). Create `public/warfront/*.css` and
  `sprites.js` here, porting the shared panel/typography styles and the race art the screen
  uses.
- `startWarfront` at this step just validates and moves to `generating` → immediately back with a
  "next step" toast (or stub straight to Step 4).
- Tests: join/captain/race/options/randomize guards; Start refused until both teams have
  `WF_MIN_TEAM_SIZE` and every joined player has a race; non-host non-captain can't start.
- **Browser:** choose Warfront, two phones join opposite teams, pick races, reconnect one phone on
  the team screen.

### Step 4: Map generation + static board ✅
Done 2026-11-11. The prompt asks for the spec's JSON shape; the OpenAI call is capped at 25 s
(`WF_MAP_TIMEOUT_MS`), then the fallback map is used. If a team empties while the map is generated,
the battle is cancelled back to team select with a notice. Until fog (Step 5) the `playing` payload
carries only the viewer's own team's units. The world is built from tiles with the mockup's own
pieces (water = shore/water blobs, forest = floor + trees, hills = grass plateaus merged into
rectangles, rock = rocky plateau + boulder, base = stone pad + castle). New art in the sprite
conventions: three race Workers, a supply depot, five weapon tokens. The console shows the minimap,
the map's theme/lore and 🔩/💎 only; Supply/sec arrives with the economy (Step 7). ☰ opens "Leave the
battle?" (back to lobby). **Not yet checked on a real phone:** headless Chromium here has no GPU and
pans the 20×13 board at ~26 fps, about the same as the mockup page itself (~29 fps), so this
machine can't judge phone smoothness.
- `generateBattlefield(room, size)`: prompt per spec (size from `phaseConfig.mapSize`, avoid-list
  from `mapHistory`, temp 1.1), then `validateMap`; on any throw → `buildFallbackMap`. Push the
  theme onto `mapHistory` (window 8).
- `createBattleState(map, roster, opts)` in the engine: armies, starting Workers, bases at
  `baseHp`, pickups, `seed`, `tick = 0`, clock. `generateBattle` stores it, sets `playing`,
  broadcasts `wfState`. **No loop yet.**
- Client: `#wf-screen` ported from `docs/design/warfront/2-battlefield.html`: the **2.5D tilted world**
  (`perspective` camera, `rotateX(40deg)` plane, raised ground, cliff walls), terrain textures,
  billboarded SVG castles/trees/crystals and unit stacks with count badges, the `.tiles` tap layer,
  drag-to-pan, and the HUD (base HP bars, match clock in place of `RND · PLAN`, 🔩 Supply + 💎
  Minerals). Supply sources, veins and weapon tokens that the mockup doesn't draw get SVG art in
  the same style. Check it on a real mid-range phone now: if the 2.5D camera stutters, **stop and
  ask David** rather than switching to a flat board.
- Tests: OpenAI mock returns a valid map → used; returns garbage / fails → fallback used and the
  game still reaches `playing`; `repairOnLoad` in `generating` → `teamSelect`.
- **Browser:** start a battle with and without `OPENAI_API_KEY`; both reach the board.

### Step 5: Loop + movement + fog ✅
Done 2026-11-11. Units carry a new `stepStartedAt` (the client tweens from it to `stepEndsAt`); the
step time uses the terrain of the tile being **entered**. A re-issued move lets the step in progress
finish (the new path continues from that tile), so units never snap back. `stepSim` itself bumps
`tick` and `clock.lastTickAt`, and chains steps from `max(stepEndsAt, now − dt)` so a stall or
restart can't fast-forward a unit through a backlog. Mineral drops are collected by any unit into
its owner's 💎 (no drop art yet; drops only appear once combat exists). `wfLive` = `viewForPlayer`
(own team: full paths; enemies in vision: only the tile they're stepping onto; spectators: no units)
+ `visible` ('0'/'1' per tile) + `eventsForPlayer` (own team's, or on a seen tile). The loop's
interval is `unref`'d. Client: tap your stack to select it (the mockup's green `.selr` rings),
tap any other tile to send it, tap it again to let go, tap another own stack to switch (so you
can't merge onto your own stack by tapping yet: the Move button comes with the console in Step 7);
`.gline` march lines (teammates' as `.ally`, blue variant added) and a `.click` marker; the info
well shows the selected stack like the mockup. Fog = a blurred SVG haze sheet per ground plane
(flat ground, each plateau, each castle pad; no 3D transform on the sheet, which made Chrome drop
its last row) plus the mockup's `.dim` on billboards in fog; the minimap darkens fogged tiles and
the player strip says "in sight"/"hidden" for the enemy. `repairOnLoad` doesn't restart the loop yet
(Step 13): a server restart mid-match freezes the board until then.
- Engine: `applyCommand` `move` (ownership, passable target, BFS path; empty path = no-op);
  `stepSim` movement (`stepMs` per spec × terrain move cost; advance through as many steps as `dt`
  allows); weapon-token and mineral-drop pickup on arrival; `viewForPlayer` with fog (D: Manhattan
  `WF_VISION` from own team's units + base) and the static/live split.
- Module: `startLoop` (one `setInterval(WF_TICK_MS)` per room, stored in `wfLoops`), `tickRoom`
  (`dt = min(now − lastTickAt, WF_MAX_DT_MS)`, `stepSim`, `tick++`, `broadcastLive`). `stopLoop`
  called from `clearState`, `finishBattle`, back-to-lobby and when `rooms` no longer has the room.
  `tickRoom` must be **exception-safe** (try/catch, log, never let one bad step kill the interval or
  the process).
- Client: select a stack (own units only) → tap a tile → `wfCommand move`; tween stacks using
  `stepEndsAt`; fogged tiles dimmed; enemy stacks appear/disappear with vision.
- Tests (engine): path around water; forest step takes 2× plains; Raider (move 3) outpaces a
  Warrior; re-issuing a move repaths; fog hides an enemy 3 tiles away and shows it at 2; the
  enemy-hauler `carrying` field is absent outside vision. Tests (module, `t.mock.timers`): loop
  starts on battle start, ticks, stops on back-to-lobby; a thrown error inside one tick doesn't stop
  later ticks.
- **Browser:** two phones walk units around; each sees the other only within vision.

### Step 6: Combat ✅
Done 2026-11-11. Combat runs after movement each step and is **simultaneous**: every fighter picks
its target from the field as it stood at the step's start, then all damage lands together (so unit
order never decides a fight). HP is kept to 2 decimals. Bases carry a new `atkReadyAt`; a base is
not a target while contested, shielded or at 0 HP, and bases never shoot each other. "High shooting
high" uses plain range (the spec's parenthesis), so the +1 is only for shooting down. Units gain
`holding` and `revealedUntil`; the `hold` command lets the step in progress finish, then stops.
Events: `underAttack` / `baseHit` (with `fromTileId`, `dmg`, attacker type `by`, `ranged`) and
`death`; the module throttles them into per-socket `wfAlert { tileId, base }`. `armies[].stats`
are **not** counted yet (Step 8). No Hold button yet: it arrives with the console (Step 7).
Client: per-tile damage numbers, loss chips and bursts from `3-resolution`, bolts (violet for
Arcane) for ranged hits and sparks for melee, dust puffs and the mockup's red `.foe` arrow for
enemies on the move, a castle burns below half HP, the HUD bar blinks on a base hit; the alert is
a `.pnl` banner ("▲ UNDER ATTACK", tap to look) plus the amber `.ping` on the tile and minimap and a
buzz. **Browser check was done in a static harness** (real index.html + client module fed real
engine snapshots, headless Chrome at 390px) because this session had no network for `npm install`;
not yet played on two real phones, and no live disconnect/reconnect check.
- Engine: per-unit `atkReadyAt` cooldown; target selection = nearest enemy in range (Manhattan,
  deterministic tie-break by unit id); damage formula from the spec with RPS, terrain defense,
  `structureDefense`, Horde ×1.15/luck ×0.6, Archmage (D6), Battlemage aoe (D8), siege ×3 vs
  structures; `strategyEdge` (D5); deaths (Worker drops `carrying` into `pickups.mineralDrops`);
  idle units hold, moving units fire on the way. Base damage and the base's own weak attack per D9.
  High ground per D13: `isHigh(map, tileId)`, `effectiveRange(map, attacker, targetTileId)` and a
  same-level check for melee, used by target selection. Under attack per D14: emit `underAttack`
  on every hit; set `revealedUntil[victimTeam]` on the attacker (and show it in `viewForPlayer`);
  fall back for idle units that can't hit back (`fallBackTile(state, unit, attacker)`); `hold`
  command sets `holding`, move/haul clear it.
- Module: turn `underAttack` events into per-socket `wfAlert { tileId }` with the per-player
  throttle (module-local map, not persisted); base hits go to the whole team.
- Emit `death`/`baseHit` events for client FX.
- Tests: RPS matchup outcomes over many seeds (melee beats mounted on average); hills defender
  survives longer than plains; Horde luck spread narrower than Arcane's; aoe hits all units on one
  tile and none on the next; contested base takes no damage; a base shoots an adjacent raider; siege cracks a base 3× faster;
  identical seed → identical fight. High ground (D13): a Crossbow on a hill hits a target 3 tiles
  away and the same Crossbow on plains doesn't; a ground Crossbow can't hit a hill target 2 tiles
  away but can at 1; a ground Warrior next to a hill can't hit the unit on it and vice versa, and
  can once it stands on a hill tile; the Battlemage (range 1) follows the melee rule. Under attack
  (D14): an idle Warrior shot by a Crossbow 2 tiles away walks out of range (≤3 tiles) and a
  holding one doesn't; a Warrior that can hit back stays and fights; a fogged shooter appears in
  the victim team's view for 3 s then disappears; alerts reach only the owner, at most one per
  10 s in one area, a far-away hit alerts at once, a base hit alerts the whole team.
- Client: live combat effects ported from `docs/design/warfront/3-resolution.html` (clash damage
  numbers, march trails, base-hit flash and HP drop), driven by `death`/`baseHit` events. The
  `wfAlert` banner reuses the mockup's amber `.ping` marker on the tile and minimap, plus a banner in
  the HUD's panel style and a haptic buzz.
- **Browser:** armies meet and fight without input; the effects look like the `3-resolution`
  frames.

### Step 7: Economy + production + hauling ✅
Done 2026-11-11. Runs after combat each step: Supply accrual, then the haul loops, then finished
queue items spawn (`spawn` / `deposit` events). `unit.haul` is `{ veinTileId, stage, luck }`;
a contested vein's ± swing is rolled **once per load** (per step it averaged away) from its own RNG
stream, so combat's draws are unchanged. The unit cap counts queued orders too, and a Summoner needs
two free slots (its Golem). Only the base is a spawn point / deposit for now (`spawnPoints` /
`depositTiles` grow Barracks and Refineries in Step 9); `mineralRush` and the Refinery +1 come with
Steps 11 and 9. `wfState` carries the viewer's race `catalog` (prices, build time) and `carryCap`;
`me` gains `supplyRate`, `units`/`unitCap` and `queues`. Client: the mockup's command card with the
Worker as a sixth card (long names hyphenated like the mockup's "Militia-man"), 2c's per-race glow and
structure frame, 🔩 on the card and 💎 under it in mineral cyan, hotkeys, a queue count and a build bar
in the stacks' HP-bar style; Move / Haul / Hold (Haul arms "tap a vein"; tapping a vein with only
Workers selected hauls too); `+N/s` beside 🔩. New art in the sprite conventions: the Golem, a
crystal over loaded haulers, a dropped-load billboard; "+4💎" rises over the base on a deposit and
"<Unit> ready" lines use the mockup's `[Team]` overlay style. No Produce/Build/Weapons tab bar yet
(only Produce exists; the bar arrives with Build in Step 9); team pings/phrases stay for Step 12.
**Checked in a harness, not the real server:** packages couldn't be installed here (no network), so
the browser check ran the real `public/` client against the real engine and `wfStatePayload` via a
polling stand-in for socket.io (390px, headless Chrome, 4× sim speed): select Workers → Haul → vein,
queue units by tap and hotkey, spawns incl. Summoner + Golem, two deposits of 4 💎, page reload
mid-haul (Workers kept hauling). A real socket reconnect and two real phones are still unchecked.
- Engine: Supply accrual (trickle + workers on/adjacent to own supply source + Forge bonus); `produce`
  (race check, affordability in 🔩 and, for advanced units, 💎 per D2, debit now, sequential queue per spawn tile, unit cap D12, Summoner →
  Golem); `haul` (auto-loop state machine on the unit: `toVein` → `loading` → `toDeposit` →
  deposit → repeat; contested-vein luck on load rate; nearest deposit = base or own Refinery); plain
  `move` clears `haul`.
- Client: the command console ported from `2-battlefield.html` + `2c-command-cards.html` (per-race
  glow, unit cards with letter keys, greyed when unaffordable), showing 🔩 and, for advanced units,
  💎 instead of 💰; queue progress; **Move / Haul / Hold** buttons replace Move / Hold / Undo /
  Clear; the Lock Orders bar is removed. HUD shows the Supply rate per second.
- Tests: worker-less player still gains trickle; two Workers on the supply source double the
  worker share; produce debits the unit's Supply (+ Minerals for advanced units) immediately (refused if short) and spawns after `buildMsPerCost × cost`; queue is
  sequential; wrong-race produce is a no-op; full haul cycle deposits `carryCap` Minerals; killing a
  loaded hauler leaves a drop an enemy can collect.
- **Browser:** a full economy loop: harvest, build an army, haul from the middle.

### Step 8: Win, game over, scoreboard ✅
Done 2026-11-11. The win check runs at the end of each step; both bases falling in the same step is a
draw (added to the spec). `clock.endedAt` records the end (the match cap itself on a timeout), and
once `winner` is set `stepSim` is a no-op. A kill goes to the hit that drops the unit; `baseDmg`
counts what the base actually lost (no overkill); bases earn no stats. `finalView(state)` is the
unfogged end state. MVP = most base damage (> 0), ties to more kills; none if no base was hit.
Points/participants come from `armies` (so a player who dropped mid-match still counts).
`WF_DEV_MATCH_MS` (env, dev only) overrides the match length for quick test matches. Client: the
scene is the real final map built by `buildWorld` into a second camera (the battlefield's CSS now
also scopes `#wf-gameover-screen`), framed with a transform on the fallen base; the loser's castle
becomes the mockup's ruin with its fire glow, flames and smoke, the winners' banners stand on its pad,
scorch marks round it, winners' stacks cheer, confetti in the winners' colours. Additions in the
mockup's style: Blue and draw title glows (and 44px for "BLUE WINS!", which overflows at 50px),
◆ DEFEAT ◆ / ◆ STALEMATE ◆ under the title, "Time up · … · m:ss" lines, a dimmed Play Again plus a
note for players who can't start it, and the shared scoreboard as a panel of wells. Portraits use
the team roster's `RACE_PORTRAITS`. **Checked in a harness, not the real server** (no network for
`npm install`): real `public/` + the real lobby/game modules behind a long-polling stand-in for
socket.io, headless Chrome at 390px, two players: base kill → game over on both phones, reload on
the board and on game over, Play Again (refused for a non-captain, then by the host), a time-up
win, Back to Lobby. Not yet on two real phones.
- Engine: win check each step (base ≤0 → other team wins; `now ≥ matchEndsAt` → `winnerByBaseHp`).
- Module: `finishBattle` stops the loop, sets `winner`/`phase = 'gameover'`, `awardWfScores`
  (+2 per winning-team player, 0 on draw), `ctx.recordGameResult(room, 'warfront', participants)`,
  broadcasts. `playAgainWarfront` regenerates; back-to-lobby clears.
- Engine: track `armies[name].stats` (`kills`, `lost`, `baseDmg`) during combat.
- Client: `#wf-gameover-screen` ported from `docs/design/warfront/4-game-over.html` (winner banner,
  final base HP, final map unfogged, Kills / Lost / Dmg table with ★ MVP for most base damage,
  Play Again / Back to Lobby, shared scoreboard); "round N" becomes the match time.
- Tests: base kill ends immediately and awards points; timeout winner by HP; equal HP → draw, 0
  points; `recordGameResult` participants shape; no tick runs after game over.
- **Browser:** a full match (use a short `matchLength` dev override) through to the scoreboard and
  back to the lobby. **This is the first fully playable build.**

### Step 8b: Lighthouses (D15) ✅
Added 2026-11-11 with David; comes after the game is playable end to end (Step 8).
Done 2026-11-11. Home = the one lighthouse on a base's half within `LIGHTHOUSE_HOME_RANGE` (4) of it;
the rest must each be fair (distances to the bases differ by ≤ 2) or form a mirrored pair (left-right,
or rotated 180°). Fallback maps put the home one 2–3 tiles from the base, and the contested pair near
the centre (hills preferred), more than 4 from both bases, at least 3 tiles apart, and none in the
top row (the tall tower is clipped at the camera's top edge). Capture runs after combat, before the
economy. A `lighthouse` event goes to **every** player (owners are public), not just those who can
see the tile. The plan's map field is `map.lighthouses` (with `team` = starting owner) and
`state.lighthouses`; views carry `lighthouses`. Client: a stone tower in the castle's greys with a
`.tc` lamp room (grey `.tm-none` while neutral), a pulsing pool of light in the holder's colour like
a vein's glow, a minimap diamond above the fog, a ring flash in the new colour and a
"Red took the south-west lighthouse" line in the team's HUD colour; stacks on a lighthouse stand at
its foot so the lamp stays visible. **Checked in the same harness as Step 8** (no real server): a
unit ordered onto the contested lighthouse flips it, the red phone's fog opens around it, the blue
phone's lamp turns red with no fog change, and a reload keeps it.
- Engine: `MAX_LIGHTHOUSES = 4`, `WF_LIGHTHOUSE_VISION = 5`. `validateMap` reads `lighthouses`:
  2–4, exactly one per base half within Manhattan 4 of that base (not on it), extras fair (distance
  to each base differs by ≤ 2, or a mirrored pair), passable, reachable, own tile. `buildFallbackMap`
  places one per base and a mirrored contested pair (prefer hills/chokepoint tiles near the centre).
  `createBattleState` adds `lighthouses: [{ tileId, team }]` (home ones owned, others `null`).
  `stepSim` (after movement and combat) flips a lighthouse when only one team's units stand on it and
  emits `lighthouse { tileId, team }`. `visionFor` adds radius `WF_LIGHTHOUSE_VISION` around each
  lighthouse the team controls. `viewForPlayer` carries `lighthouses` (everyone sees owners).
- Module: add `lighthouses` to `SAVED_FIELDS`; prompt asks for the lighthouses as in the spec.
- Client: lighthouse SVG billboard in the sprite conventions (stone tower, lamp in the owner's team
  colour via `.tc`, unlit grey when neutral, a soft light cone like the vein glow), minimap marker,
  a flip flash + a notice line in the mockup's `[Team]` overlay style ("Red took the north
  lighthouse").
- Tests: validation (too many, none near a base, two near one base, unfair extra, on water);
  fallback maps carry valid lighthouses across seeds and sizes; starting owners; capture by one team,
  no flip while contested or empty; vision radius 5 from an owned lighthouse and none from an enemy or
  neutral one; persisted through the snapshot round-trip.
- **Browser:** walk a unit onto a contested lighthouse; your fog opens up to 5 tiles around it and the
  enemy's view shows the lamp turn your colour.

### Step 9: Facilities + towers ✅
Done 2026-11-12, rules per D17 (agreed with David the same day). Facilities are units with a
`buildDoneAt` (0 once standing) and stats from `FACILITY_UNITS` (`unitStats(type)` covers both
tables); `armies[].facilities` mirrors them and drops one when it dies. Construction runs first in
each step (so a Tower that finishes can fire the same step), the Workshop last; new events `built`
and `crafted`. `wfState` carries `buildCatalog` (race prices), `weaponCost`/`weaponMs`; `me.workshop`
holds the craft queue. Client: Produce / Build tabs in team-select's `.seg` style (Weapons waits for
Step 10); Build cards in 2c's square structure frame; arming one shows dashed green squares on
buildable tiles; the mockup's Tower, tent (Forward Barracks) and smithy (Workshop) are lifted from
`Main.dc.html`, the Refinery is new art; a site is pale behind scaffolding with a build bar. Tapping
your facility with nothing selected picks it: a picked Barracks is where Produce spawns, a picked
Workshop swaps the card well for its five weapon cards (a separate craft row didn't fit a 390×844
phone). Units selected + tap on your facility still moves them there. **Checked on the real server**
(headless Chrome, two players, 390px): haul, Tower, Refinery with a deposit at it, a server restart
mid-match with both phones reconnecting, Workshop + craft, Barracks + a Militiaman spawned there, a
page reload. A hauler already walking home when its Refinery finishes keeps going home that trip.
- Engine: `build` command (Mineral cost with Forge discount, visible-tile rule D4, one structure per tile,
  Refinery adjacency), structures as `structure` units with build-complete time; Refinery deposit
  point + vein rate +1; Forward Barracks as a spawn point; Workshop weapon queue; Tower auto-attack.
- Client: Build tab in the console's panel style; SVG art for Refinery, Forward Barracks, Workshop
  and Tower in the mockups' sprite conventions (team-coloured `.tc` parts, the square iron frames
  `2c-command-cards` gives structures).
- Tests: each placement rule; destroying a Refinery stops its effect immediately; Barracks spawn.

### Step 8c: Split into small modules ✅
Done 2026-11-12, after Step 9. A pure move refactor with no behaviour or visual change: the engine,
shell, client, CSS and tests went from a few huge files to the layout in "Target files" and
`warfront-code-map.md`. The same 321 tests pass, and a seeded browser run matches main screen for
screen. Systems may import an earlier system (movement → facilities → economy → production → combat
→ lighthouses → victory) because some order/step functions are shared. `visionFor` sits in
`engine/vision.js` below the systems because the build rule (D4) needs it.

### Step 10: Special weapons ✅
Done 2026-11-13. New `engine/systems/weapons.js` (`orderWeapon`, `weaponBlocker`); events wait in
`state.pendingEvents` (not persisted) for the next `stepSim`. EMP pauses via `isDisabled` /
`builtFacilities(army, type, now)`, so the step functions for construction, production and the
Workshop now take `dt`. Client: `console/weapons.js` (Weapons tab, firing mode), fire hints in
`structures.js`, FX in `fx.js`, styles in `weapons.css`. Rules agreed with David (D18). Checked in
headless Chrome at 390px and 360px: every weapon fired from the tab, the refusals, notices on both
phones, and a server restart mid-match. **Deviation:** at 360px the arsenal count beside the
"Weapons" tab label is clipped; the cards show their own counts.
- Engine: `weapon` command for each id per the spec + numbers table; aegis via
  `bases[team].shieldUntil`; emp via a `disabledUntil` on the structure unit.
- Client: Weapons tab and firing mode (tap weapon → tap target tile) in the console's panel style;
  FX per id in the `3-resolution` effect style.
- Tests: each effect, including artillery whiffing on an empty tile and airdrop refused on a fogged
  tile.

### Step 11: Battlefield events
- Engine: `rollEvent` at `nextEventAt` and applying each `EVENT_EFFECTS` id; set generic title.
- Module: after a roll, `fetchEventFlavor` asynchronously (OpenAI, avoid-list `eventHistory`);
  when it resolves, write `title`/`text` **only if the same event is still active**. Never awaited
  inside `tickRoom`.
- Client: the mockup's ▲ Chance card component, reused as the event banner with a countdown.
- Tests: events roll on schedule; `mineralRush` doubles load rate for its duration; flavor failure
  leaves the generic title; a slow flavor call doesn't delay ticks.

### Step 12: Private team channel
- `wfPing` / `wfTeamMessage` fan-out to same-team connected sockets (never `roomEmit`); 1 per
  second per socket rate limit; `TEAM_PHRASES` enum.
- Tests: an opponent socket never receives either; spam is dropped.

### Step 13: Reconnect, persistence, restart hardening
- `reconnectPayload` (synchronous) for all four phases; `onReconnectBroadcast`; `onDisconnect` just
  re-broadcasts team select (in `playing` nothing to do; units keep executing).
- `repairOnLoad` per spec: `generating` → `teamSelect`; `playing` → `lastTickAt = now`, regenerate
  missing event flavor, `startLoop`. Note `repairOnLoad` receives `(ctx, room)` without the room
  code; follow how `codenames.js` recovers it (look up the code from `ctx.rooms`).
- Tests: snapshot a mid-match room through JSON (`JSON.parse(JSON.stringify(...))`), repair it, tick
  once, and assert positions continued (no giant catch-up jump); `wfLoops` rebuilt.
- **Browser:** kill and restart the server mid-match; both phones resume. Disconnect one phone
  mid-haul; its Workers keep hauling.

### Step 14: Design fidelity pass + update the mockups
- Side-by-side check of every screen against its mockup at phone width (team select, battlefield,
  command console for all three races, combat effects, game over); fix every difference that isn't
  in the spec's swap table.
- Update `docs/design/warfront/` so the mockups match the real-time game: the HUD clock, event banner,
  🔩/💎 costs, Move/Haul/Hold, Produce/Build/Weapons tabs, facilities, towers, veins, hauling
  Workers, drops and weapon tokens; turn `3-resolution.html` into live-effect frames; rewrite the
  README's round-based description.

### Step 15: Performance + balance pass
- **Measure** `wfLive` payload bytes per player at 4v4 with the unit cap reached
  (`Buffer.byteLength(JSON.stringify(view))`). Target **< 6 KB per player per tick** (≈ 30 KB/s
  per phone). If over: send enemy units as per-tile stacks (`{ tileId, team, counts, hpPct }`) and
  keep per-unit detail only for own units; drop unchanged fields.
- **Measure** `tickRoom` time at 4v4 cap (target < 5 ms) and the 5 s persistence snapshot size.
- Balance: play several matches; tune `TUNING` and unit tables; write the changes back into the
  spec's tables.

### Game-feel polish (Steps 16–20)
Added 2026-11-12 with David. Client only: every cue below comes from data `wfLive`/`wfAlert` already
send (`underAttack`/`death`/`spawn` carry `owner` and `unitId`, `built` carries `owner`, `baseHit`
carries `team`, `wfAlert` is already per-socket), so no engine or sim-loop change. Shared rules for all
five: each new concern gets its own module with the standard header comment and a line in the code
map; every Warfront file stays ≤ 400 lines; no build step or npm package; effects animate only
`transform`/`opacity` (no new `filter`/blur/drop-shadow animation); nothing runs per frame while the
battlefield is idle; any visual change goes into `docs/design/warfront/source/*.dc.html` **and** its
generated static page first (the repo has no generator, so both are edited by hand), then gets ported.
Done in the order 21 → 24, then 16 → 20 (David, 2026-11-12), one commit each, `npm test` after each.
Decided with David the same day: Step 16 **replaces** the per-figure `wfHit`/`wfBrace` `filter`
flashes in `attacks.css` with the opacity-only overlay (no filter animation left); Warfront's Sound
toggle **is** the app-wide mute; the ☰ battle menu is **drawn into the mockups** (Step 18) before its
Sound/Vibration rows are ported.
Client tests: pure, DOM-free helpers (throttles, stack signatures, zoom maths) live in their own
modules so `tests/games/warfront/client/*.test.mjs` can import them under `node --test` (Node 22
loads the ES-module `.js` files by syntax detection). Everything with DOM is checked in a headless
Chrome harness at 360px and 390px, and the "on a real phone" list is reported per step.

### Step 16: Impact feedback (hit flash, base-hit shake, spawn pop, in-place stacks)
- **Goal:** hits read instantly and cheaply: a white flash on the stack that took damage, a small
  camera shake when your base is hit, a scale pop on a stack that gains a new unit. Hits stop
  rebuilding stacks: the HP bar updates in place, and a stack is rebuilt only when its make-up changes.
- **Mockup first:** add a "hit flash", "spawn pop" and "base hit shake" frame to `3-resolution.html`
  (`source/Resolution.dc.html`) in the existing frame style.
- **Files touched:** `units.js` (split `stackSig` into a make-up sig and an HP sig; `fillStack` only on
  make-up change; `updateStackHp` sets the bar's `scaleX` + colour class in place), new `stackSig.js`
  (pure: `makeupSig`, `hpPct`, `hpClass`), new `impact.js` (`flashStacks(events)`, `popStacks(events)`,
  `shakeCamera()`: toggles a class on the stack's `.bb` / on `#wf-cam`, removed on `animationend`),
  `battle.js` (call `playImpact(view.events)` after `renderUnits`), new `public/warfront/impact.css`
  linked after `attacks.css` (keyframes: white overlay opacity flash, `scale` pop, `translate` shake;
  all off under `prefers-reduced-motion` except the flash), `battlefield.css` (`.hpb span`
  `transform-origin: left`), `public/index.html` (css link), code map, README table.
- **Flash without a filter:** a white overlay span over the stack's figures (`.wf-flash`, a
  pre-built child of `.sqbb` at opacity 0) whose opacity animates 0 → 0.7 → 0 in ~160 ms.
  Note: the per-figure hit flinch in `attacks.css` (`wfHit`) already animates `filter: brightness()`;
  see the question in the review note on whether to keep or replace it.
- **Shake:** `#wf-cam` only, via the individual `translate` property (so it composes with Step 19's
  zoom `scale` on a wrapper and never touches `#wf-world`'s `rotateX`). ~250 ms, ±3 px, own base only,
  at most once per 600 ms.
- **Acceptance:** a hit on a stack (own or enemy in sight) flashes it once per snapshot; `fillStack`
  is not called when only HP changed (checked with a counter in the harness over 30 s of a fight);
  the HP bar width and colour track HP; a spawned unit pops the stack it appears in; own base hit
  shakes the camera, the enemy base doesn't; reduced motion: no shake, no pop; the Performance panel
  shows no new filter/layout work during a fight and no frames scheduled when idle.
- **Tests:** `client/stackSig.test.mjs`: make-up sig unchanged when only HP changes, changes on
  type/count/selection/load; `hpPct` clamps and `hpClass` thresholds (75/35).

### Step 17: Sound
- **Goal:** short synthesized cues for your own unit hit, unit death, unit produced, building
  finished, your base hit, Under attack, victory and defeat; quiet by default, throttled, own things
  only, with a Sound toggle in the ☰ menu.
- **Mockup first:** none for the cues; the Sound/Vibration toggle rows in the ☰ menu are drawn with
  Step 18 (see the review note on the menu not being in the mockups).
- **Files touched:** new `audio.js` (`wfSound.hit()`, `.death()`, `.produced()`, `.built()`,
  `.baseHit()`, `.alert()`, `.victory()`, `.defeat()`, `playSounds(events, you, myTeam)`: filters to own
  owner/team, one cue per kind per snapshot, per-cue throttle; a Warfront master `GainNode` at ~0.35
  into the shared context), new `throttle.js` (pure `makeGate(minGapMs)` taking `now`, shared with
  Step 18), `public/js/fx.js` (export the existing `getAudioCtx` so Warfront reuses the one
  already-unlocked context instead of opening a second; the one non-Warfront change), `battle.js`
  (call `playSounds`), `fx.js` (the alert plays `wfSound.alert()` instead of `sfx.error()`),
  `gameOver.js` (victory/defeat once per `goBuiltFor`), `menu.js` (Sound row bound to the shared
  `isMuted`/`toggleMuted`), code map.
- **Acceptance:** each cue plays for own events and not for an enemy's or a teammate's; 10 hits in
  100 ms give one hit sound; muting from the menu silences Warfront and the lobby's speaker button
  shows muted (and vice versa); the setting survives a reload; first tap unlocks audio on iOS; no
  sound object is created per frame or while idle.
- **Tests:** `client/throttle.test.mjs` (gate opens once per gap); `client/soundFilter.test.mjs`
  (the pure event → cue list: own unit hit → `hit`; enemy hit → nothing; teammate's death → nothing;
  own team's `baseHit` → `baseHit`; duplicate events in one snapshot → one cue).

### Step 18: Haptics
- **Goal:** Android buzzes for your base hit, your unit produced, the Under attack alert and the end
  of the match, with a separate Vibration toggle next to Sound.
- **Mockup first:** add the Sound and Vibration rows to the ☰ battle menu, drawn into
  `2-battlefield.html` (`source/Main.dc.html`) in the menu's existing `wf-menu-item` style (two-line
  label + state on the right).
- **Files touched:** new `haptics.js` (`wfBuzz.baseHit()`, `.produced()`, `.alert()`, `.matchEnd()`,
  `.tap()`, `.warn()`, `.success()`: feature-detects `navigator.vibrate`, checks the `wf-vibrate`
  pref (try/catch), throttles with `throttle.js`), every Warfront call to the shared
  `haptics`/`haptic` (`input.js`, `util.js`, `fx.js`, `console/*.js`) switched to `wfBuzz` so the
  Vibration toggle governs them all; `battle.js`/`gameOver.js` call sites; `menu.js` (Vibration
  row; hidden when `navigator.vibrate` is missing, e.g. iOS); `shell.css` or `console.css` for the
  row's on/off state; code map.
- **Acceptance:** each buzz fires for own events only; Vibration off stops all Warfront buzzes but
  not sound; Sound off doesn't stop vibration; the row is absent on iOS; setting survives a reload;
  a blocked `localStorage` (private mode) falls back to on without throwing.
- **Tests:** `client/hapticFilter.test.mjs` (event → buzz list, own only; base hit throttled).

### Step 19: Pinch-to-zoom
- **Goal:** two-finger pinch (and ctrl+wheel) zooms the battlefield 0.6×–1.6× anchored between the
  fingers, without breaking one-finger pan, tap select/move, the minimap view box or `lookAt`.
- **Mockup first:** none (no new visuals).
- **How:** a new `#wf-zoom` sizer between `#wf-vp` and `#wf-cam` in `public/index.html`, sized to
  cam × zoom so native scrolling covers the zoomed world; `#wf-cam` gets `transform: scale(z)` with
  origin top-left (transform only). Touch: non-passive `touchstart`/`touchmove` on `#wf-vp` that act
  only with two touches (one finger stays native scrolling), plus `gesturestart` `preventDefault` on
  iOS. While pinching only the transform changes; on release the sizer and scroll offsets are
  committed so the anchor stays under the fingers, and `S.suppressClickUntil` swallows the stray tap.
- **Hit-testing:** taps already resolve through the DOM (`.tiles` cells with `data-tile`, picked by
  `closest()` in `index.js`), and the browser hit-tests through the 3D/scale transforms, so
  `input.js`/`geometry.js` need no maths change; verified per zoom level in the harness.
- **Files touched:** new `zoom.js` (gesture wiring, `setZoom(z, anchorX, anchorY)`), new
  `zoomMath.js` (pure: `clampZoom`, `anchoredScroll`), `camera.js` (`syncView` and `lookAt` divide by
  `S.zoom`; mouse pan unchanged), `store.js` (`zoom: 1`, written by `zoom.js`, `battle.js` reset per
  battle), `battlefield.css` (`#wf-zoom`, `#wf-cam` transform-origin, `touch-action: pan-x pan-y` on the
  viewport), `public/index.html` (sizer), `index.js` (wire `enableZoom()`), code map.
- **Acceptance:** at 0.6, 1, 1.6: tapping each corner tile and a plateau tile selects/moves to that
  exact tile; the minimap box matches the visible area; `lookAt` centres the castle; one-finger pan and
  desktop drag still pan; pinch never zooms the page itself; ctrl+wheel zooms on desktop; zoom resets
  on a new battle; nothing runs when not gesturing.
- **Tests:** `client/zoomMath.test.mjs` (clamping; the anchor point maps to the same world point
  before and after; round trip at both limits).

### Step 20: Unit readability on small phones
- **Goal:** on a 360px-wide phone in a 4v4 fight, unit types and teams are told apart at a glance.
- **Mockup first, then stop for approval:** propose the change in `source/Units.dc.html` /
  `2b-unit-roster.html` and `source/Main.dc.html` / `2-battlefield.html` (candidates: a stronger,
  thicker team ring; a thin dark outline on figures as a static SVG stroke, not a `drop-shadow`; a
  bigger type chip with the type icon), and show before/after screenshots of both pages at 360px.
  Implementation waits for David's OK; the approved treatment is then written into the spec's "Game
  feel" section.
- **Files touched (after approval):** `units.js` (chip markup), `sprites.js` (outline stroke if
  chosen), `battlefield.css` (ring, chip sizing), the two mockups, README if the roster page changes.
- **Acceptance:** side-by-side screenshots of the live game and the updated mockups at 360px match;
  a 4v4 harness fight at 360px is legible (types and teams named correctly from a screenshot by
  someone who hasn't seen the code); no new filter/shadow animation.
- **Tests:** none new beyond Step 16's sig tests (chip text comes from `makeupSig`'s counts).

### Step 20a: Vein glow bug fix ✅
Done 2026-11-12. David saw the minerals' "background moving". Cause: `attacks.css` (commit e83a430)
declared a second `@keyframes wfPulse` (`scale(1.18)`, for the Arcane orb), and being later in the
cascade it replaced `battlefield.css`'s opacity pulse everywhere. So every vein glow and contested
ring, lighthouse glow and dropped-load glow grew 18% and snapped back every 2.2 s. Fix: the orb's
keyframes are now `wfOrbPulse`. No new rule: keyframe names are global, so check for an existing name
before adding one.

### Step 21: Clear selection ✅
Done 2026-11-12. Mockups for Steps 21–24 drawn first in `2-battlefield.html` / `source/Main.dc.html`
and `2c-command-cards.html` / `source/Rosters.dc.html`. Ported: a selected stack swaps its team ring
for `.selg` (76px green tile ring, static glow) and gets a `.selm` ▼ over its HP bar, lifted with the
labels (`translateZ(40px)`) so the 3D sort never hides it. Checked in headless Chrome (two players,
390px and 360px): tap selects (ring + marker), tap again lets go, both ride along a walking stack.
- **Goal:** tapping your stack makes it obvious which units you're commanding, on the map and in the
  console. Today the team ring is swapped for a small 30px green ring under each figure, which is easy
  to miss at phone scale.
- **Mockup first, then show David:** in `source/Main.dc.html` / `2-battlefield.html`, draw the
  selected state. Candidates: a full-tile green ground ring (static, brighter than the team ring), a
  green ▼ marker floating above the stack, the count chip turning green. Also show other selected
  stacks in a multi-select (Step 23).
- **Files touched:** `units.js` (selected markup in `fillStack`), `battlefield.css` (`.selr` /
  marker), the mockups.
- **Acceptance:** at 360px, with two of your stacks and an enemy stack on neighbouring tiles, a
  screenshot shows which one is selected; the marker moves with a walking stack; nothing animates
  while it stands still (no infinite pulse).
- **Tests:** covered by `makeupSig` (selection already rebuilds the stack).

### Step 22: Soldier HP and army size ✅
Done 2026-11-12. A stack's HP bar is one segment per soldier (lowest HP first, up to 8), each a
`scaleX` fill; the stack is rebuilt only when its make-up changes (new pure `stackSig.js`, which
also does Step 16's sig split) and HP repaints the segments in place. The info well lists every
selected soldier's bar (up to 10, then "+N"), lowest first, and "HP 5 · 9 · 33 (of N each)". The
header shows `⚔ soldiers/cap`. **Deviation:** the number is soldiers on the field, not `me.units`,
which also counts units in training and buildings (cap slots); the count turns amber when the cap is
full so a blocked Produce card makes sense. The bar's class is `sqhp`, not `seg` (the segmented
control's `.seg` padding squashed it to 0 px). Also fixed: `hp-r` had no CSS, so a badly hurt
stack never turned red. Checked in headless Chrome at 360px: wounding two of three soldiers through
the live store repaints the segments red/amber/green, keeps the same figure nodes, and matches the
console.
- **Goal:** you can see how much life each soldier has, and how many soldiers you have in total.
- **Mockup first, then show David:** (a) on the map, one thin HP bar per figure under its feet
  (up to the 4 figures a stack draws) instead of the single stack bar, or the stack bar split into one
  segment per unit; (b) in the console info well, the selected units as a row of mini portraits each
  with its own HP bar (the current pips are capped at 10 and unlabelled), and "8 selected"; (c) in
  the HUD next to 🔩/💎, an army count `⚔ 14/30` (units/cap).
- **Data:** none new. Each unit's `hp` is in `wfLive`, max HP is `UNIT_MAX_HP`, and `me.units`
  already counts slots used toward the cap (`WF_MAX_UNITS_PER_PLAYER`).
- **Files touched:** `units.js` (per-figure bars, updated in place, see Step 16), `console/selection.js`
  (selected list), `hud.js` + `public/index.html` (army count), `battlefield.css`/`console.css`,
  the mockups. If `console/selection.js` passes 400 lines, the selected list moves to
  `console/selectedList.js`.
- **Acceptance:** wounding one soldier of four shows only that soldier's bar drop; the info well
  matches; the army count changes on spawn and death; HP changes update in place (no stack rebuild).
- **Tests:** `client/stackSig.test.mjs` adds per-unit HP fractions (sorted, lowest first).

### Step 23: Bulk actions in the console ✅
**×1/×5 removed 2026-11-12 (David):** a Produce card tap always queues one unit. Five queued units kept
walking out one by one long after the taps, which read as the base producing on its own. Gone: the
switch, `batch.js` and its test, `S.produceBatch`; the command row is back to four buttons (Move ·
Haul · Hold · ⊕ All), in the mockups too. Select all stays.
Done 2026-11-12. **Deviation (agreed with David):** the ×1/×5 switch isn't beside the tabs (only
~35px free there at 360px); it's a fifth button in the command row, Move · Haul · Hold · ⊕ All ·
×1/×5 Recruit, and the mockup was changed to match. Select all picks every fighter (not buildings
or a Tower's garrison); tapping it again adds the Workers; it's lit while every fighter is selected.
×5 sends up to five `produce` commands one after another (no engine change), stopping at the
first refusal, and says "Recruited 2 of 5 · not enough 🔩". The switch resets to ×1 each battle.
Checked in headless Chrome at 360px: ×5 with 7 🔩 queued 2 Militiamen with that notice; ⊕ selected
both Militiamen, ⊕ again added the two Laborers; one map tap set all four walking.
- **Goal:** from the console, select every soldier you have in one tap, and buy several units at once.
- **Mockup first, then show David:** in the console (`2-battlefield.html` /
  `2c-command-cards.html`), (a) a **Select all** button next to Move/Haul/Hold that selects all your
  combat units (not Workers or garrisons; a second tap adds Workers); (b) a **×1 / ×5** switch on the
  Produce tab in the `.seg` style: at ×5 a card tap queues five of that unit (or as many as Supply,
  Minerals and the unit cap allow, with a notice saying how many).
- **Data:** no engine change. ×5 sends up to five `produce` commands, one at a time, each waiting for
  the previous answer, and stops at the first refusal so the notice reports the real count. If that
  proves too slow on a phone, propose a `count` field on `produce` instead.
- **Files touched:** `console/selection.js` (Select all), `console/cards.js` (×1/×5 and batched
  produce), `store.js` (`produceBatch: 1`), `public/index.html`, `console.css`, the mockups.
- **Acceptance:** Select all picks every combat unit across the map, the selection shows on every
  stack (Step 21), and a map tap moves them all; ×5 with enough Supply queues five; with Supply for
  three it queues three and says so; ×5 never goes over the unit cap.
- **Tests:** `client/batch.test.mjs` (pure: how many fit given supply, minerals, cost, cap).

### Step 24: Building info on tap ✅
Done 2026-11-12. New `console/buildingInfo.js` draws a building in the info well (picked or
long-pressed) as in `2c-command-cards.html`: owner-coloured portrait (pale while being built), a
YOURS / ENEMY / BUILDING tag, a filled HP bar (`scaleX`, striped build bar with "% BUILT" on a site),
the description on its own line, and an order line (amber "destroy it" lines for enemy buildings).
It also owns the long-press (400 ms on the tile layer; a finger that moves > 8 px is a pan and cancels
it). The Tower's order line is now the mockup's "▸ SEND UP TO 3 UNITS ONTO ITS ROOF".
**Not in the mockups:** a teammate's building gets an ALLY tag (the YOURS style), its owner's name and no
order line. Checked in headless Chrome at 360px and 390px with your Tower, an enemy Refinery and your
construction site: selection kept, no command sent by a long-press, HP 32 → 9 repaints the bar red
live, the stack comes back after 4 s, a short tap still sends the units, the map viewport doesn't
change height, and the hint shows once. Also checked: a reload mid-match comes back to the battle.
- **Goal:** tap a building you built and see what it's for and its HP. Today this works only with
  nothing selected (`input.js` picks it and `renderInfo` shows its name, `HP x/max`, the `UNIT_INFO`
  description and one HP pip). With units selected, the same tap moves them to the building, which is
  needed for sending units onto a Tower or haulers to a Refinery, so the info seems missing.
- **Change:** a **long-press** (~400 ms, the same gesture as the Produce card's lore) on any building
  you can see (yours or an enemy's in sight) shows its info for 4 s, whatever is selected and without
  changing the selection. A plain tap keeps today's behaviour. The info well also gets a proper HP bar
  (`hp/max` with a filled bar, like the stack bar) and the description on its own line, plus a
  one-time hint "Long-press a building for its info" the first time you build.
- **Mockup first, then show David:** the info well with a building shown (`2-battlefield.html` /
  `2c-command-cards.html`), for your own building, an enemy building and one under construction.
- **Files touched:** `input.js` (long-press on the tile layer, with `S.suppressClickUntil` so the
  release isn't also a tap), `store.js` (`inspect: { id, until }`), `console/selection.js` (render the
  inspected building; enemy ones show name, HP and description only), `console.css`, the mockups.
- **Data:** none new. Enemy buildings in sight are already in `wfLive` with `hp` and `type`.
- **Acceptance:** with units selected, long-pressing your Tower shows its info and the units stay
  selected; a short tap still sends them onto the roof; an enemy Refinery in sight can be inspected;
  HP in the well updates live as it takes damage.
- **Tests:** none for the DOM gesture; harness check at 360px.

## Testing notes

- **The engine is where the suite earns its keep.** Every rule in the spec should have an engine
  test that builds a tiny hand-made map (e.g. a 5×3 strip), places units, calls `stepSim` N times
  with a fixed seed, and asserts the result. Use the `makeBattle({ rows, units, … })` builder (and
  the other helpers) in `tests/games/warfront/fixtures.js` so tests stay short, and put each test in
  the `engine/<module>.test.js` of the module it exercises.
- **Determinism test:** run the same 2-minute scripted match twice with the same seed and assert
  identical final state. Catches any accidental `Math.random()`/`Date.now()` in the engine.
- Module tests use the harness (`createTestCtx`, `makeHandlerSocket`, `mockOpenAi`,
  `emissionsFor`) and `t.mock.timers` for the interval. Check that every handler rejects the wrong
  phase and the wrong game, and that fog is enforced in what each socket actually receives.
- As always, the suite doesn't cover the frontend, lobby glue or persistence: run the browser
  happy path after every step, plus one disconnect/reconnect mid-match.

## Out of scope

Everything in the spec's "Explicitly out of scope (v1)" section, plus, for this plan:
- No client-side prediction or rollback. A tap shows up on the next 200 ms tick.
- No delta-compressed snapshots unless Step 15's measurement requires it.
- No spectator mode for players who join mid-match. They land on the board with no army and a
  "match in progress" note until game over.
