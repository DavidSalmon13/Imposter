# Warfront: Implementation Plan

Turns `../specs/warfront-specs.md` into code. That spec is the source of truth for *rules* (what the
game does); this doc is the source of truth for *how it gets built*: file names, function names,
event names, the decisions the spec leaves open, and a step order where every step ends in
something you can run (`npm test`) and play in a browser.

**The game must look exactly like `design/warfront/`** (spec section "Look & feel — the design is
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
| D11 | Forge "+1 per worker" vs "a bonus" | Forge Workers earn **+0.25 Supply/sec** on top of `supplyPerWorkerSec` (`TUNING.forgeWorkerBonusSec`). Forge's structure discount is **−1 💎** on every facility and tower (`TUNING.forgeStructureDiscount`). Bastion keeps its listed stats; it's already Forge-only. |
| D13 | High ground (added 2026-11-11 with David) | Hills are high ground: ranged units (base `Rng` ≥ 2) get +1 range on hills, −1 range when shooting from low ground at a target on hills; melee (`Rng` 0–1, incl. Workers, Battlemage, towers, Golems, Bastion, a base's attack) only hits targets on the **same level**. Stacks with hills' ×1.45 defense. Implemented in Step 6 as `effectiveRange(state, attacker, target)` + `canReach(...)`. |
| D14 | Under attack (added 2026-11-11 with David) | Hit → private "Under attack!" alert (banner + buzz + tile/minimap ping) for the owner, throttled per player (10 s, or at once if ≥4 tiles from the last alert); base hits alert the whole team. The attacker is revealed to the victim's team for 3 s. An idle unit hit by an enemy it can't hit back falls back ≤3 tiles out of that attacker's reach; units on **Hold** (new `hold` command) never do. |
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
socket (wfCommand) ──► warfront.js handler ──► engine.applyCommand(state, name, cmd, now)
                                                      │  (validates, mutates, returns ok/no-op)
setInterval(WF_TICK_MS) ─► warfront.js tickRoom ──► engine.stepSim(state, dt, { now })
                                                      │  returns { events }
                                                      ▼
                           broadcastLive: for each connected player
                             io.to(socketId).emit('wfLive', engine.viewForPlayer(state, name))
```

- **`server/games/warfrontEngine.js` is pure.** No sockets, no OpenAI, no timers, no `Date.now()`.
  Time comes in as `now`, randomness as `rngFor(seed, tick)`. It exports the data tables, map
  helpers, `applyCommand`, `stepSim`, `viewForPlayer` and `winnerByBaseHp`. Everything in
  "Combat/Economy/Movement" in the spec is implemented here and unit-tested here.
- **`stepSim` mutates `state` in place** and returns `{ state, events }` (same object). Cloning a
  few hundred units 5×/s per room is wasted work; tests treat the input as owned by the call.
- **`server/games/warfront.js` is the shell:** handlers, OpenAI calls, the interval map, persistence
  hooks, payload fan-out. It should stay thin. If a rule shows up here, it belongs in the engine.
- **Static vs live payloads.** The map (tiles, veins, supply sources, bases, theme, lore) never
  changes during a match, so it's sent **once** as `wfState` (on battle start, reconnect and phase
  changes). The 5×/s `wfLive` carries only the dynamic part. This is the main lever on bandwidth
  (see Step 15).
- **The client is a dumb renderer.** It never simulates. Between snapshots it tweens unit stacks
  using each unit's `stepEndsAt`, so movement looks smooth at 5 Hz.

## Target files

**New:**
- `server/lib/rng.js`: `mulberry32(seed)`, `hashSeed(seed, tick)`, `rngFor(seed, tick)`,
  `randomSeed()`. Tiny and dependency-free.
- `server/games/warfrontEngine.js`: pure engine (see above).
- `server/games/warfront.js`: the game module (contract per `refactor_plan.md` §4, namespaced like
  `codenames.js`).
- `public/js/games/warfront.js`: client module (`init` / `applyState` / `applyJoin` / `stop`).
- `public/js/games/warfrontSprites.js`: the unit/building/terrain SVG strings, lifted from
  `design/warfront/source/Units.dc.html` and `Main.dc.html`. Created in Step 3 and used by every
  client step; never emoji placeholders.
- `public/warfront.css`: `wf-*` styles. A separate file because it'll be large (terrain textures,
  sprites, keyframes); loaded after `theme-afterglow.css`.
- `tests/helpers/` stays as is; new `tests/games/warfrontEngine.test.js` (pure engine) and
  `tests/games/warfront.test.js` (handlers/loop through the harness), plus `tests/lib/rng.test.js`
  if a `tests/lib/` folder is preferred (otherwise put it in `tests/games/`).

**Touched:**
- `server/gameRegistry.js`: `require('./games/warfront')`, add `warfront` to `GAMES`.
- `server/roomStore.js`: one comment line: `// Warfront phases: 'teamSelect' | 'generating' |
  'playing' | 'gameover'` and `// Warfront fields live in state.warfront`.
- `public/index.html`: `#wf-team-screen`, `#wf-screen` (battlefield), `#wf-gameover-screen`;
  the WARFRONT tile drops `tile-wip` and the "Under construction" sub-label; link `warfront.css`.
- `public/js/main.js`: import the module, add `warfront` to `GAMES`, replace the "Coming soon"
  poke handler (lines ~690–702) with `socket.emit('chooseGame', 'warfront', ...)`, add
  `WF_MIN_PLAYERS = 2` to `renderLobby`'s underfilled logic, add a "Building the battlefield…"
  label to `showGenerating` if it isn't generic.
- `public/style.css` / `public/theme-afterglow.css`: remove the WIP-tile rules for
  `#choose-warfront-btn` once the tile is live.
- `CLAUDE.md`: "Four games today" is already stale; update the game count/list and mention
  Warfront's sim loop under Architecture.
- `design/warfront/`: add the screens/elements the mockups don't have yet and replace the
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

**Engine exports** (`warfrontEngine.js`): `RACES`, `UNIT_TYPES`, `TERRAIN_TYPES`, `TUNING`,
`WEAPON_EFFECTS`, `EVENT_EFFECTS`, `FACILITIES`, `MAP_SIZES`, `MATCH_LENGTHS`, `TEAM_PHRASES`;
`tileId(x,y,w)`, `tileXY(id,w)`, `manhattan`, `neighbors`, `bfsPath(map, from, to)`;
`validateMap(raw, size)`, `buildFallbackMap(size, rng)`; `createBattleState(map, roster, opts)`;
`applyCommand(state, name, cmd, now)`; `stepSim(state, dtMs, { now })`;
`viewForPlayer(state, name)`; `winnerByBaseHp(state)`; `rollEvent(state, rng)`.

**Module-local functions** (`warfront.js`): `createState`, `clearState`, `stopLoop(roomCode)`,
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
Done 2026-11-11: `specs/warfront-specs.md` now carries D1–D12, the unit prices and the numbers
table. The spec remains the rules source of truth; change a rule there first, then here.

### Step 1: RNG + data tables ✅
Done 2026-11-11. Unit ids are camelCase (`laborer`, `mysticArcher`, …); the tower lives in
`FACILITIES` with its combat stats; engine-side `WF_*` constants (vision, step time, unit cap, dt clamp,
match cap, event interval) are exported from the engine, loop/roster ones are left for the module.
`TEAM_PHRASES` = the mockup's four (`push`/`defend`/`needResources`/`hitBase`). RNG tests live in
`tests/games/rng.test.js`.
- `server/lib/rng.js`. Tests: same seed+tick → same sequence; different tick → different sequence;
  output in `[0,1)`.
- `warfrontEngine.js` data tables only: `RACES`, `UNIT_TYPES` (hp, atk, cost, move, class, range,
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
`clearState` keeps `phaseConfig`, `lobbyRaces` and the avoid-lists. `warfront.css` scopes every
rule through `:is(#wf-team-screen) .wf` so the mockup's buttons beat style.css's global `button`
hover/active rules; add later screen ids to that `:is()`. Additions the mockup doesn't draw, in its
style: a "Not on a team" line, a Back to Lobby button, an error/notice line, and bottom padding that
clears the floating reaction row. Workers have no art yet (needed from Step 4).
- `warfront.js` with `createState`/`clearState`/`onChoose` (→ `teamSelect`, reset `p.team`/
  `p.leader`), team-select handlers, `broadcastWfState`, `reconnectPayload` for `teamSelect`.
  Register in `gameRegistry.js`.
- Client: enable the tile, `#wf-team-screen` ported from `design/warfront/1-team-select.html`
  (Red/Blue columns, race picker, captain button, host options, Randomize, Start), with the mockup's
  "Planning time" control turned into **Match length** (8 / 12 / 16 min). Create `warfront.css` and
  `warfrontSprites.js` here, porting the shared panel/typography styles and the race art the screen
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
- Client: `#wf-screen` ported from `design/warfront/2-battlefield.html`: the **2.5D tilted world**
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
- Client: live combat effects ported from `design/warfront/3-resolution.html` (clash damage
  numbers, march trails, base-hit flash and HP drop), driven by `death`/`baseHit` events. The
  `wfAlert` banner reuses the mockup's amber `.ping` marker on the tile and minimap, plus a banner in
  the HUD's panel style and a haptic buzz.
- **Browser:** armies meet and fight without input; the effects look like the `3-resolution`
  frames.

### Step 7: Economy + production + hauling
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

### Step 8: Win, game over, scoreboard
- Engine: win check each step (base ≤0 → other team wins; `now ≥ matchEndsAt` → `winnerByBaseHp`).
- Module: `finishBattle` stops the loop, sets `winner`/`phase = 'gameover'`, `awardWfScores`
  (+2 per winning-team player, 0 on draw), `ctx.recordGameResult(room, 'warfront', participants)`,
  broadcasts. `playAgainWarfront` regenerates; back-to-lobby clears.
- Engine: track `armies[name].stats` (`kills`, `lost`, `baseDmg`) during combat.
- Client: `#wf-gameover-screen` ported from `design/warfront/4-game-over.html` (winner banner,
  final base HP, final map unfogged, Kills / Lost / Dmg table with ★ MVP for most base damage,
  Play Again / Back to Lobby, shared scoreboard); "round N" becomes the match time.
- Tests: base kill ends immediately and awards points; timeout winner by HP; equal HP → draw, 0
  points; `recordGameResult` participants shape; no tick runs after game over.
- **Browser:** a full match (use a short `matchLength` dev override) through to the scoreboard and
  back to the lobby. **This is the first fully playable build.**

### Step 9: Facilities + towers
- Engine: `build` command (Mineral cost with Forge discount, visible-tile rule D4, one structure per tile,
  Refinery adjacency), structures as `structure` units with build-complete time; Refinery deposit
  point + vein rate +1; Forward Barracks as a spawn point; Workshop weapon queue; Tower auto-attack.
- Client: Build tab in the console's panel style; SVG art for Refinery, Forward Barracks, Workshop
  and Tower in the mockups' sprite conventions (team-coloured `.tc` parts, the square iron frames
  `2c-command-cards` gives structures).
- Tests: each placement rule; destroying a Refinery stops its effect immediately; Barracks spawn.

### Step 10: Special weapons
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
- Update `design/warfront/` so the mockups match the real-time game: the HUD clock, event banner,
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

## Testing notes

- **The engine is where the suite earns its keep.** Every rule in the spec should have an engine
  test that builds a tiny hand-made map (e.g. a 5×3 strip), places units, calls `stepSim` N times
  with a fixed seed, and asserts the result. Add a small `makeBattle({ units, terrain })` builder
  inside `warfrontEngine.test.js` so tests stay short.
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
