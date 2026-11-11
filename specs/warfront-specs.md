# Warfront — Specs

A same-room, two-team **real-time strategy** game — the ninth game in this app and its first live
simulation. Two teams each defend a **base**; every player commands their own **army** on a shared
**AI-generated top-down grid battlefield**. You win by reducing the enemy base's HP to zero.
Inspired by StarCraft and reshaped for phones in a shared room: units move the instant you tap,
walking **tile-by-tile in real time** with a minimal slide animation, and combat happens
**continuously** as armies meet — there are **no rounds, no commit, no reveal**. Each player watches
their **own fogged phone**, so the game is about **strategy** (read the map — vein placement,
chokepoints, counter their army), **economy** (keep Workers harvesting Supply at home and hauling
Minerals from contested veins while your army covers them), and **same-room mind games** (scout what
they're building, hide your own push behind the fog, and coordinate silently with your team while
the opponents sit right next to you).

## Relationship to existing games / shared app changes

- New option on the "Choose a game" screen: `room.game = 'warfront'`, tile id
  `choose-warfront-btn`, icon suggestion ⚔️.
- Reuses the shared lobby, host concept, room-code model, and `room.scoreboard`
  (`scoreboard-specs.md`).
- **Two fixed teams, `red` and `blue`**, chosen on a team-select screen — the same model as
  Codenames (`code_name_specs.md`), reusing the per-player `team`/`leader` fields on
  `room.players`. Flexible size: 1v1 up to 4v4.
- Uses the shared OpenAI helper `chatCompletionJson` (`server/lib/openai.js`) to generate the
  battlefield **and** each battlefield event's flavor — same prompt→parse→**hard-validate**→fallback
  discipline Codenames/Imposter use. **Divergence from Codenames:** if OpenAI is unreachable or
  returns an unusable map, Warfront does **not** fail to start — it falls back to a procedural
  map (see "Map generation") so a game night never fails to start. The map *is* the game.
- **Namespaced room state** (the migrated pattern, like Bluff): all state lives under
  `room.state.warfront`, declared via the module's `namespaces` descriptor — no new flat
  `createRoomState()` fields. See "Server state."
- New pure-logic module `server/games/warfrontEngine.js` (map gen/validation, unit/terrain tables,
  and the **pure seeded simulation step** `stepSim` that advances movement, combat, economy,
  production, events and the win check) plus `server/lib/rng.js` (a seeded PRNG), both unit-tested
  the way `pokerEval.js`/`bluffHands.js` are. The module owns the per-room `setInterval` sim loop
  that drives `stepSim` and broadcasts; the engine itself stays free of sockets/OpenAI/timers.

## Look & feel — the design is binding

**The game must look exactly like the design mockups in `design/warfront/`.** They are the visual
source of truth the same way this spec is the rules source of truth: layout, colours, typography,
panels, the 2.5D tilted battlefield, the SVG unit/building/terrain art, team colouring and
animations all come from there. Build every screen by porting the mockup's markup, CSS and SVG
(editable originals in `design/warfront/source/*.dc.html`; how they're built is in
`design/warfront/README.md`) — not by re-creating a look-alike, and never with placeholder emoji
art. If something here can't be matched (for example the 2.5D camera is too slow on a phone), stop
and ask; don't silently ship a different look.

| Screen | Mockup |
|---|---|
| Team select | `1-team-select.html` |
| Battlefield (map, HUD, unit stacks, command console, team channel) | `2-battlefield.html` |
| Unit and structure art, race colours | `2b-unit-roster.html` (+ `source/Units.dc.html`) |
| Produce panels per race | `2c-command-cards.html` |
| Live combat effects (movement trails, clash damage numbers, base-hit flashes) | `3-resolution.html` |
| Game over | `4-game-over.html` |

**The mockups were drawn for the earlier round-based design.** Keep their look, but swap these
round-based elements for their real-time equivalent, styled with the same components:

| In the mockup | In the real game |
|---|---|
| "Planning time" option (team select) | **Match length** option (8 / 12 / 16 min), same segmented control |
| `RND 7 · PLAN` + per-round countdown (HUD) | **Match clock** counting down to `matchEndsAt` |
| ▲ Chance card | **Battlefield event** banner with its countdown |
| Player strip `planning` / `locked` / `hidden` | Player strip shows each teammate's name, race and online status |
| "Last rd" summary | Removed (combat is live; the `3-resolution` effects play on the map instead) |
| 💰 single currency, "of 8 · +3/rd" | **🔩 Supply** with its per-second rate **and 💎 Minerals**; unit cards show 🔩 and, for advanced units, 💎 |
| Move / Hold / Undo / Clear | **Move**, **Haul** (Workers), **Hold**; commands apply instantly so Undo/Clear go away |
| 🔒 LOCK ORDERS bar | Removed; the console gets **Produce / Build / Weapons** tabs in the same panel style |
| `3-resolution` as a separate reveal screen | No reveal screen; its march / clash / base-hit visuals become live on-map effects |
| "round 11" on game over | Match time at the end |

Facilities, towers, veins, hauling Workers, mineral drops, weapon tokens and the Build/Weapons tabs
aren't drawn in the mockups yet: design them in the same visual language (panel chamfers, glow,
team colours, the SVG sprite conventions) and add them to the mockups (see the plan's Step 14).

## Configurable constants

Tuning lives in `warfrontEngine.js`'s `TUNING` block (gameplay balance) and the module
(timing/roster). All are expected to be iterated on during a balance pass.

| Constant | Value | Meaning |
|---|---|---|
| `WF_MIN_PLAYERS` | 2 | Connected players needed to start (1v1) |
| `WF_MAX_PLAYERS` | 8 | Max roster (4v4) |
| `WF_MIN_TEAM_SIZE` | 1 | Players a team needs to start |
| `WF_TICK_MS` | 200 | Simulation step interval (server advances the world ~5×/s) |
| `WF_BROADCAST_MS` | 200 | How often a fogged snapshot is pushed to each socket |
| `WF_STEP_MS_BASE` | 900 | Time to walk one tile at `Move 1` on plains (÷ Move, × terrain move-cost) |
| `WF_MATCH_CAP_MS` | 720000 | Hard match length (12 min); at the cap, higher base HP wins |
| `WF_EVENT_MS` | 60000 | Interval between battlefield events |
| `WF_VISION` | 2 | Fog-of-war vision radius (Manhattan) around friendly units/base |
| `WF_MAX_UNITS_PER_PLAYER` | 30 | Unit cap per player (structures and Golems included); Produce is a no-op at the cap. Bounds payload size and DOM count on phones |
| `WF_MAX_DT_MS` | 1000 | Clamp on one sim step's `dt` (protects against event-loop stalls) |
| `MAP_SIZES` | Small 12×8 · Medium 16×11 · Large 20×13 | Host's map-size option (width×height in tiles) |
| `MATCH_LENGTHS` | Short 8 min · Standard 12 min · Long 16 min | Host's match-length option (sets `WF_MATCH_CAP_MS`; Standard is the default) |
| `TUNING.baseHp` | 120 | Starting base HP |
| `TUNING.baseAtk` / `baseRange` / `baseAttackMs` | 2 / 1 / 1500 | A base's own weak tower-like attack (see "Combat") |
| `TUNING.startSupply` | 6 | Each player's **🔩 Supply** at match start |
| `TUNING.startMinerals` | 0 | Each player's **💎 Minerals** at match start (minerals are earned by hauling) |
| `TUNING.startWorkers` | 2 | Worker units each player begins with, on their base tile |
| `TUNING.baseTrickleSec` | 0.3 | Flat Supply **per second** per player (so a worker-less player never hard-stalls) |
| `TUNING.supplyPerWorkerSec` | 0.5 | Supply **per second** per Worker on a friendly supply source |
| `TUNING.forgeWorkerBonusSec` | 0.25 | Extra Supply/sec per **Forge** Worker on a friendly supply source |
| `TUNING.forgeStructureDiscount` | 1 | 💎 off every facility and tower a **Forge** player builds |
| `TUNING.mineLoadSec` | 0.5 | Minerals **per second** a Worker loads on a vein, × the vein's richness |
| `TUNING.carryCap` | 4 | Max Minerals a Worker carries before the auto-haul loop returns to deposit |
| `TUNING.buildMsPerCost` | 1200 | Build/spawn time **per point of a unit's 🔩 Supply cost** |
| `TUNING.attackMs` | 1000 | Base attack cooldown (per-unit overrides allowed) |
| `TUNING.luckMagnitude` | 0.35 | ± per-hit damage swing at zero strategy edge |
| `TUNING.hillRangeBonus` | 1 | Extra range for a **ranged** unit (base `Rng` ≥ 2) standing on hills (see "High ground") |
| `TUNING.uphillRangePenalty` | 1 | Range lost by a ranged unit **off** the hills shooting at a target **on** hills |
| `TUNING.structureDefense` | 1.5 | Extra defense × for every `structure` (bases, towers, facilities, Bastion, Golem); stacks with terrain |
| `TUNING.veinLuckMagnitude` | 0.4 | ± swing on a *contested* (central) vein's load rate |
| `TUNING.artilleryDmg` | 8 | `artillery` damage to each enemy unit on the target tile (through terrain/structure defense) |
| `TUNING.bombardDmg` | 15 | `bombard` damage to an enemy base (ignores contest and terrain) |
| `TUNING.empMs` / `aegisMs` | 15000 / 10000 | `emp` disable time / `aegis` base-shield time |
| `TUNING.airdropCount` | 3 | Units an `airdrop` spawns (the firer's race's basic melee unit: Militiaman / Warrior / Apprentice) |
| `TUNING.workshopWeaponCost` / `workshopWeaponMs` | 💎6 / 10000 | Price and build time of one Workshop weapon |
| `TUNING.supplyDropAmount` | 5 | Supply each player gets from a `supplyDrop` event |
| `TUNING.sandstormLuck` | 2 | `luckMagnitude` multiplier while a `sandstorm` is active |

### Races & units (the `RACES` + `UNIT_TYPES` data tables)

**Each player picks one of three races** at team-select (independent of their teammates — a team
can field combined arms: a builder + a fighter + a magician). A player may **only produce their
own race's units.** Races are the game's asymmetry and its main source of replay depth; a team's
shape is the blend of races its players chose.

Every unit has a **combat class** that plugs into a universal rock-paper-scissors backbone so
"what will they bring?" is always a live question:

> **melee > mounted > ranged > melee.** Countering the enemy's **dominant class** multiplies a
> unit's attack by `1.5`; being countered multiplies it by `0.67`. A composition that counters
> the enemy also **shrinks your own luck swing** (strategy buys consistency — see "Combat").

**Real-time reading of the stat columns.** Because the match is a live sim: a unit's **`Move` is
its walking speed** — tiles/sec, higher is faster (a Raider blitzes), slowed by terrain move-cost —
not a per-round step budget. Each combat unit also has an **attack range** (the `Rng` column, Manhattan
distance; `0` = its own tile only) and an **attack cooldown** (`attackMs`); it auto-attacks the
nearest enemy in range each cooldown. The 🔩 Supply cost also sets build time
(`buildMsPerCost × 🔩`). See "Combat" under the simulation section.

Four classes sit outside the triangle and interact via flags instead: **worker** (harvests Supply
at home and hauls Minerals from veins — barely fights, `atk 1`; the economic engine and the game's
juiciest soft target), **siege** (devastating vs structures/bases, fragile vs mobile units),
**caster** (fragile; some have `aoe`), and **structure** (can't move, high defense — bases, towers,
Forge's Bastion, a summoned Golem). Each race also has a **signature** modifier.

**Every race fields a Worker** (same stats, race flavor name). Workers are how both resources
flow, so losing them starves you — defend yours, hunt theirs.

| Unit | Icon | Class | HP | Atk | 🔩 | 💎 | Move | Rng | Notes |
|---|---|---|---|---|---|---|---|---|---|
| Laborer (Forge) / Peon (Horde) / Acolyte (Arcane) | ⛏️ | worker | 5 | 1 | 3 | 0 | 1 | 1 | harvests Supply on a supply source; loads Minerals on a vein (`carryCap 4`); deposits at base/Refinery; outside the RPS triangle (flat ×1) |

**⚒️ FORGE — the great builders.** Specialty: **defense + economy** (Forge Workers earn
`+forgeWorkerBonusSec` Supply/sec, every Forge facility and tower costs `forgeStructureDiscount` 💎
less, and only Forge fields the Bastion). All races can build, but Forge turtles and out-produces
best.

| Unit | Icon | Class | HP | Atk | 🔩 | 💎 | Move | Rng | Notes |
|---|---|---|---|---|---|---|---|---|---|
| Militiaman | 🛠️ | melee | 11 | 4 | 3 | 0 | 1 | 1 | basic; cheap, sturdy |
| Crossbow | 🎯 | ranged | 7 | 5 | 4 | 0 | 1 | 2 | basic |
| Outrider | 🐴 | mounted | 8 | 4 | 5 | 2 | 2 | 1 | |
| Bastion | 🏯 | structure | 20 | 3 | 6 | 3 | 0 | 0 | can't move; very high defense; attacks enemies on its own tile |
| Ballista | 💥 | siege | 8 | 4 | 6 | 4 | 1 | 2 | `×3` atk vs structures **and** bases |

**⚔️ HORDE — the great fighters.** Specialty: **raw combat** — Horde units get `×1.15` attack
and a **reduced luck swing** (`×0.6`); reliable brutes for whom strategy beats luck.

| Unit | Icon | Class | HP | Atk | 🔩 | 💎 | Move | Rng | Notes |
|---|---|---|---|---|---|---|---|---|---|
| Warrior | 🗡️ | melee | 11 | 5 | 3 | 0 | 1 | 1 | basic |
| Skirmisher | 🪃 | ranged | 7 | 5 | 4 | 0 | 1 | 2 | basic |
| Raider | 🐎 | mounted | 9 | 4 | 5 | 2 | 3 | 1 | fastest unit in the game |
| Berserker | 🪓 | melee | 6 | 9 | 5 | 2 | 1 | 1 | glass cannon |
| Warchief | 👑 | melee | 16 | 7 | 8 | 5 | 1 | 1 | elite bruiser |

**🔮 ARCANE — the magicians.** Specialty: **area magic + luck manipulation** (fragile,
expensive, high-impact — and the race that bends the game's luck, tying into the gambling theme).

| Unit | Icon | Class | HP | Atk | 🔩 | 💎 | Move | Rng | Notes |
|---|---|---|---|---|---|---|---|---|---|
| Apprentice | ✨ | caster | 6 | 4 | 3 | 0 | 1 | 2 | basic |
| Mystic Archer | 🏹 | ranged | 6 | 5 | 4 | 0 | 1 | 2 | basic |
| Battlemage | 🔥 | caster | 8 | 6 | 6 | 3 | 1 | 1 | `aoe`: hits **every** enemy unit on its target's tile |
| Summoner | 🧿 | caster | 7 | 3 | 6 | 4 | 1 | 2 | producing one also summons a **Golem** at the base |
| Archmage | 🪄 | caster | 10 | 7 | 9 | 6 | 1 | 2 | `luckBend`: hits by friendlies within 2 tiles of it get luck `×0.5`; hits on friendlies within 2 tiles of it get the enemy's luck `×1.5` (several Archmages don't stack) |
| Golem | 🗿 | structure | 18 | 5 | — | — | 0 | 1 | summoned by a Summoner (not built directly); can't move |

**Cost currency:** **basic units** (each race's two cheapest fighters) and **Workers** cost 🔩
Supply only. **Advanced units** cost 🔩 Supply **plus** 💎 Minerals — the stronger the unit, the more
Minerals. Minerals also buy facilities, towers and Workshop weapons (see those sections). This split
is what gives hauled Minerals a purpose: Supply keeps a basic army on the field from the first
second, Minerals are what let you field the strong units, out-tech and crack a base. Because
Workers and basic units never need Minerals, a player who loses everything can always rebuild.

(Stats above are the starting balance point and will be tuned.)

### Terrain types (`TERRAIN_TYPES`)

| Terrain | Passable | Defense × | Move cost |
|---|---|---|---|
| Plains | yes | 1.0 | 1 |
| Forest | yes | 1.25 | 2 |
| Hills | yes | 1.45 | 2 |
| Water | no | — | — |
| Rock | no | — | — |

Defense × raises the HP cost of killing a unit **standing on** that tile, so hills/forest are
strong to hold. **Move cost** now multiplies a unit's per-tile **step time** (forest/hills take
~2× as long to cross), so terrain shapes both where fights are winnable and how fast armies
redeploy. Water/rock are impassable (they shape lanes and chokepoints). **Hills are also high
ground**, which changes who can hit whom (see "High ground" under Combat).

## Phases

`room.phase` for Warfront: `teamSelect` → `generating` → `playing` → `gameover`. There is a
single live phase: once the battlefield is built, the whole match runs in `playing` while the
server's simulation loop ticks. No `planning`/`resolving` split exists — commands apply instantly
and the sim plays them out. All live bookkeeping (unit positions, build queues, the active
battlefield event, the match clock) lives in `room.state.warfront`, never in `room.phase`.

## Team-select phase (`teamSelect`)

- Choosing the game takes everyone to a team-select screen (its own `#wf-team-screen`, modeled
  on Codenames' `#team-select-screen` but Warfront-owned so the two games don't share DOM).
- Players tap **Join Red** / **Join Blue**. One player per team may **Become Captain**
  (`p.leader`) — the **host or either captain** may start/replay a match, mirroring Codenames'
  leader. A captain is **not** required to play (unlike Codenames' spymaster)
  — any team with ≥ `WF_MIN_TEAM_SIZE` members can start.
- **Each player also picks a race** (Forge / Horde / Arcane) for themselves — stored in
  `room.state.warfront.lobbyRaces[name]` during team-select and copied to
  `armies[name].race` at Start (kept for Play Again).
  Races are independent per player, so a team can be any blend. A player's race decides which
  units they may produce for the whole match. The screen shows each player's chosen race beside
  their name on the roster, and a short tooltip of each race's specialty.
- Host-only options on this screen: **match length** (`MATCH_LENGTHS`: 8 / 12 / 16 min) and
  **map size** (`MAP_SIZES`: Small 12×8 / Medium 16×11 / Large 20×13). A **Randomize Teams** button (host-only) splits the roster
  evenly, like Codenames (it does not change anyone's race).
- The host or either captain taps **Start Battle** once both teams have ≥ `WF_MIN_TEAM_SIZE` members **and every
  joined player has chosen a race**. This moves to `generating`.

## Map generation (`generating`)

Entered on Start Battle (and on Play Again). Sets `phase = 'generating'`, emits the shared
`generating` event (so the app's "Building the battlefield…" screen shows), then:

1. **Try OpenAI.** `generateBattlefield(room)` builds a prompt — open top-down battlefield, two
   bases at opposite ends, roughly mirror-symmetric fairness, water/rock impassable, **one supply
   source beside each base**, **1–2 mineral veins out in the contested middle** (the richest ones
   farthest from either base), **a few scattered weapon tokens** (rarer ones deeper in contested
   ground), and natural chokepoints — plus a short theme + lore — with an **avoid-list** of recent
   map themes (`room.state.warfront.mapHistory`) for variety, temp ~1.1, and a strict JSON shape.
   The model's output is a **suggestion only**.
2. **Hard-validate** (`validateMap`): exact tile count, terrain enums, exactly one base per team on
   passable opposite-half non-adjacent tiles, exactly one supply source adjacent to each base, every
   vein/weapon token on a passable tile, veins roughly mirror-fair, and full **connectivity**
   (flood-fill: each base reaches the other, every vein, and every weapon token). Any violation
   throws.
3. **Fallback.** On an OpenAI error *or* a validation failure, build a **procedural** map
   (`buildFallbackMap`) instead — a mirror-symmetric grid with guaranteed connectivity, a supply
   source at each base, 1–2 contested-centre veins, and symmetric weapon tokens. The game is
   therefore **always** playable.
4. Store the map on `room.state.warfront.map`, seed each player's army (`startWorkers` Workers on
   their base tile, `startSupply`/`startMinerals`, empty `arsenal`/`facilities`), set both bases to
   `baseHp`, build `pickups` from the map's weapon tokens, stamp `startedAt`/`matchEndsAt` and the
   first `nextEventAt`, set `phase = 'playing'`, **start the simulation loop**, and broadcast.

The map is **pure data** (ints + terrain enums + vein/base coords). The client is a **dumb
renderer** of the server's authoritative state — it never simulates — so every phone shows the
same world (modulo its own fog) and tweens between snapshots.

### JSON schema the model must return

```json
{
  "theme": "string (<=40 chars)",
  "lore": "1-2 sentences",
  "width": 9, "height": 7,
  "tiles": [ { "terrain": "plains|forest|hills|water|rock" } ],   // exactly width*height, row-major
  "bases": [ { "team": "red", "x": 0, "y": 3 }, { "team": "blue", "x": 8, "y": 3 } ],
  "supplySources": [ { "x": 1, "y": 3 }, { "x": 7, "y": 3 } ],     // exactly one adjacent to each base
  "veins":   [ { "x": 4, "y": 1, "richness": 1|2|3, "contested": true } ],  // 1-2 mineral veins to haul from
  "weapons": [ { "x": 4, "y": 5, "weaponId": "artillery|emp|airdrop|bombard|aegis" } ],  // ground pickups
  "chokepoints": [ { "x": 4, "y": 2 } ]
}
```

## The real-time simulation (`playing`)

The whole match runs in a single `playing` phase. The module runs a **simulation loop** per active
room: every `WF_TICK_MS` it advances the world, and every `WF_BROADCAST_MS` it pushes a **fogged
snapshot** to each socket, which the phone renders and tweens. No rounds, no commit, no reveal —
commands apply the instant they arrive and the sim plays them out.

The core is a **pure, seeded** engine function `stepSim(state, dtMs, { seed, tick })` in
`warfrontEngine.js` that advances every system by `dtMs` and returns `{ state, events }`. `events`
is a list of discrete things that happened this step (`spawn` / `death` / `deposit` / `baseHit` /
`weapon` / `pickup` / `battlefieldEvent`) for client sound/FX **only** — the client renders the
authoritative `state` and never recomputes anything. Because `stepSim` is pure and seeded, the full
simulation is deterministic and unit-testable (feed a state, tick N times, assert positions / HP /
economy), preserving the repo's pure-engine testing discipline even though the game is now live.

### Commands (client → server, applied instantly)

A player issues commands live; each is validated and applied the moment it arrives — no draft, no
commit, no debit-at-reveal. The single `wfCommand` event carries one of:

- **Move** `{ kind:'move', unitIds, toTileId }` — the selected unit(s) compute a BFS shortest path
  over passable terrain and **start walking immediately**. Re-issuing repaths at once; several
  units can be selected and sent together (so "move several soldiers to different places" is just
  several move commands).
- **Produce** `{ kind:'produce', unitType, atTileId }` — must be one of the player's **own race's**
  units and the player must be under `WF_MAX_UNITS_PER_PLAYER`; its **🔩 Supply (and 💎 Minerals
  for an advanced unit) is debited immediately**; the unit enters that spawn point's build queue and
  appears after `buildMsPerCost × 🔩`. Each spawn point builds **one unit at a time** — a queued
  unit's timer starts when the one ahead of it finishes. Spawns at the player's **base** or a friendly
  **Forward Barracks**. Producing an Arcane **Summoner** also spawns a **Golem** at the base.
- **Build** `{ kind:'build', facility, tileId }` — debits **Minerals** now; the structure rises on
  a buildable tile (see "Facilities") after its build time (see "Facilities"/"Towers").
- **Haul** `{ kind:'haul', workerIds, veinTileId }` — puts Worker(s) into the **auto-haul loop** on
  that vein (see Economy). Any plain move command cancels the loop.
- **Fire weapon** `{ kind:'weapon', weaponId, targetTileId }` — spends a weapon from the player's
  **arsenal**; the effect applies live (see "Special weapons").

All commands are validated server-side (ownership, race, affordability, unit cap, buildable tile, passability) and
ignored if invalid — a bad tap is a no-op, never an error that stalls the sim.

### Movement (grid-step, real time)

A unit occupies a tile and, when it has a path, walks to the next tile over
`stepMs = WF_STEP_MS_BASE ÷ moveStat × terrainMoveCost(nextTile)`. When a step completes the unit
snaps to the next tile and begins the next; the client slides the stack between tile centres for
the step's duration (the minimal animation). Units path around **impassable terrain only** — enemies
don't block tiles, they trigger combat. Stacking still renders as **one stack per occupied tile**
(count badge), so a tile can hold many units.

### Combat (continuous, auto-attack)

Each combat unit auto-attacks on its `attackMs` cooldown, dealing damage to the **nearest enemy in
range** (the unit's `Rng` from the race tables; Tower `1`, base `1`):

> `dmg = atk × rpsMultiplier(attacker,target) ÷ terrainDefense(targetTile) × (1 + luckSwing)`,
> where `luckSwing = (rng·2−1) × luckMagnitude × (1 − strategyEdge)` is rolled **per hit**.
> The enemy's **dominant class** is the most common RPS class (melee/mounted/ranged) among enemy
> units within 2 tiles of the attacker (a tie or none = no dominant class, edge 0);
> `strategyEdge` is the fraction of the attacker's team's RPS units within 2 tiles that counter it.
> Structures also divide damage by `structureDefense`.

The **rock-paper-scissors** triangle (melee>mounted>ranged, ×1.5/×0.67), **terrain defense**, and
all **race/flag modifiers** apply per hit: **Horde** ×1.15 atk and
×0.6 luck; an **Archmage** bends luck (own side ×0.5 / enemy ×1.5 within 2 tiles of it); a
**Battlemage** (`aoe`) hits **every** enemy on its target's tile, not just one; **siege** deals ×3 vs structures and bases. A unit at ≤0 HP
dies immediately (a loaded Worker **drops its cargo** on its tile). **Behaviour:** an idle unit (no
move order) **holds position and auto-attacks** enemies that enter range but does not chase; a unit
with a move order pursues it and fires at anything in range along the way. The enemy **base tile**
takes attack damage from enemies in range whenever no friendly unit is **contesting** it (≥1
friendly unit standing on the base tile); **siege** ×3, so a Ballista is the premier base-cracker.
A base also has its own **weak tower-like attack** (`baseAtk` 2, range 1, every `baseAttackMs`), so a
lone raider can't chip it for free. Ties between equally near targets break by unit id, so the sim
stays deterministic.

**High ground (hills).** Each tile is either **high** (hills) or **low** (every other passable
tile). A unit is **ranged** if its base `Rng` is 2 or more (Crossbow, Skirmisher, Mystic Archer,
Apprentice, Summoner, Archmage, Ballista); everything with `Rng` 0–1 is **melee** for this rule
(including Workers, the Battlemage, Towers, Golems, the Bastion and a base's own attack).
- A **ranged** unit's effective range is its `Rng`, **+`hillRangeBonus`** (1) while it stands on
  high ground, or **−`uphillRangePenalty`** (1) when it stands low and its target is high. (High
  shooting high, and low shooting low, use plain `Rng`.) So archers on a hill outrange everything
  around them, and ground archers must walk right up to the hill to answer.
- A **melee** unit can only hit targets **on the same level**: high hits high, low hits low,
  nobody strikes across the cliff edge in either direction. To fight a unit on a hill, melee
  troops must climb onto a hill tile themselves. The same applies to a base: a base's own attack
  and enemy melee on the base only reach units on the base tile's level.
- These stack with the hills' defense × (1.45) — holding high ground is strong on purpose; the
  balance pass may tune it.
- Target selection ("nearest enemy in range") uses the effective range and the level rule, so a
  unit never picks a target it can't hit.

### Economy (accrues continuously)

- **🔩 Supply:** each player accrues `baseTrickleSec` plus `supplyPerWorkerSec` for every Worker on
  (or orthogonally adjacent to) a friendly **supply source**; **Forge** Workers earn `+forgeWorkerBonusSec` each. It
  ticks up smoothly and the HUD shows the current rate. No passive node income exists — Supply is
  **earned by where your Workers stand**.
- **💎 Minerals via the auto-haul loop:** a Worker given a `haul` command runs hands-off — mine on
  the vein until `carrying` hits `carryCap` (rate `mineLoadSec × richness`; a **contested** vein's
  rate carries the ± `veinLuckMagnitude` swing), then walk to the **nearest friendly deposit**
  (base or Refinery), deposit into the player's Minerals, walk back, repeat — until re-ordered. The
  hauler is **exposed on the whole route**; killing it drops its current `carrying` as a reclaimable
  token any unit (either team) can collect by walking over it. This is the signature risk/reward —
  now a living supply line you can watch crawl across the map and choose to escort or raid.

### Battlefield events, weapons, win check (each step)

- A **battlefield event** fires every `WF_EVENT_MS` from the fixed menu (see "Battlefield events"),
  AI-flavored, applied live for its stated duration.
- **Weapons** apply the instant they're commanded (see "Special weapons").
- The **win check** runs every step: a base at **≤0 HP ends the match immediately** (that team
  loses); at `WF_MATCH_CAP_MS` the **higher-HP base wins** (`winnerByBaseHp`; equal HP is a draw).

## Facilities (spend Minerals to reshape the map)

Facilities are **player-owned `structure`s** placed by a `build` command on a **buildable** tile:
any tile currently in the player's team vision that is passable, has no enemy unit on it and has no
structure (validated with the Mineral cost the instant the command arrives; Minerals debit now, the structure rises after its build time). They are the
concrete form of the `armies[name].facilities` the state block reserves — on-map tech instead of an
abstract tree. All can't move, have high defense, and are killable; destroying one removes its
effect immediately. All cost **💎 Minerals**, so every facility is a bet that map control will
outpace the army you didn't build.

| Facility | Icon | Cost | HP | Build | Effect |
|---|---|---|---|---|---|
| Refinery | 🏗️ | 💎5 | 15 | 8s | Built on/adjacent a **vein**: loaded Workers may deposit here (short-haul, no trip home) **and** the vein's load rate `+1`. The premier raid target — taking it kills an enemy's whole mineral tempo. |
| Forward Barracks | 🏭 | 💎7 | 20 | 10s | A second spawn point: that player may produce units **here** instead of their home base, shortening the reinforcement line into the contested middle. |
| Workshop | 🔧 | 💎7 | 15 | 10s | Lets the player **construct** a special weapon of their choice (`workshopWeaponCost` 💎6, `workshopWeaponMs` 10s, one at a time) — an alternative to finding one on the ground, and a reliable Mineral sink when the map's weapon tokens are already taken. |

**Structures are no longer Forge-exclusive** — all races may build facilities and towers. Forge's
edge is the **Bastion** (Forge-only), the `forgeWorkerBonusSec` Supply bonus, and
`forgeStructureDiscount` 💎 off every facility and tower; it is still the turtle race, just not the
only one that can fortify.

## Towers (hold a place so your army can leave)

A **Tower** (`{ kind:'build', facility:'tower', tileId }`, **💎4**, HP 18, atk 3, builds in 6s) is
a `structure` that can't move, has high defense, and **auto-attacks enemy units within range `1`** (its own + adjacent
tiles) on its `attackMs` cooldown like any unit. Its whole purpose is the answer to *"if I push, my
base/vein is open"*:
a single Worker + a Tower can **hold a vein or a chokepoint** while your army operates elsewhere.
The AI map emits `chokepoints`, so a tower on a one-tile pass is geometry-strong and forces the
enemy to commit real force (or a weapon) to break through. Because towers cost Minerals, security
is always paid for out of your tech budget — never free.

## Special weapons (found on the ground, fired live)

Weapons are **map pickups**, not purchases (except via a Workshop). Map gen scatters weapon tokens
on specific tiles (`weapons[]`, richer/rarer ones deeper in contested ground). A unit that **walks
onto a weapon token** adds it to that **player's arsenal** (`armies[name].arsenal`) and removes the
token from the map — picking it up **denies it to the enemy**, so weapon tiles are their own reason
to contest a square. A weapon is fired with a `weapon` command whose `targetTileId` you tap live;
the effect applies **immediately** (fog means you're still guessing where their units are, so a
mis-aimed strike still whiffs — the mind game survives, it's just live instead of pre-committed).
Each weapon is **one-shot** (consumed on use); an un-fired weapon carries in your arsenal.

Effects are a **fixed, enumerated menu** (`WEAPON_EFFECTS`, deterministic — the map never invents a
weapon, it only places ids from this list):

| id | Icon | Effect (enumerated) |
|---|---|---|
| `artillery` | 🎯 | `artilleryDmg` to **every enemy unit** on the target tile. |
| `emp` | ⚡ | Disables an enemy **facility/tower** on the target tile for `empMs` (no yield, no attack). |
| `airdrop` | 🪂 | Spawns `airdropCount` of the firer's race's basic melee unit on a **friendly-visible**, passable target tile — instant reinforcement behind the lines. |
| `bombard` | 💣 | `bombardDmg` direct damage to an enemy **base**, ignoring the "contested by a defender" rule — reach over a wall. |
| `aegis` | 🛡️ | Your **base takes no damage for `aegisMs`** — a comeback / anti-snowball tool. |

(Damage/spawn magnitudes and durations live in `TUNING`; weapon mix and spawn counts are a
balance-pass dial.)

## Battlefield events (periodic luck everyone reacts to)

Every `WF_EVENT_MS` the sim rolls a **battlefield event** into
`room.state.warfront.event = { effectId, endsAt, title, text }`, active for its duration. The
**flavor** (title + one-line text) is AI-generated (reusing the battlefield call's style, with an
avoid-list in `room.state.warfront.eventHistory`), but the **mechanical effect is one of a fixed
menu** — the model picks from the menu, it never invents mechanics, so the sim stays deterministic
and the client can always render it. v1 menu (`EVENT_EFFECTS`):

| id | Effect (enumerated) | Duration |
|---|---|---|
| `supplyDrop` | instant +`supplyDropAmount` **Supply** to every player | instant |
| `mineralRush` | all vein load rates **doubled** for everyone (haul while it's hot) | `WF_EVENT_MS` |
| `sandstorm` | combat `luckMagnitude` ×`sandstormLuck` (variance up for everyone) | `WF_EVENT_MS` |
| `reinforcements` | one free Worker spawns at **each** base (rebuild a lost economy) | instant |
| `calm` | no mechanical effect (pure flavor) | — |

A banner shows the active event and a countdown. If flavor generation fails, the event falls back
to a generic title for the rolled effect; a bad flavor call never blocks the sim (the effect still
applies). Event flavor is fetched **off the sim loop** (async) and the sim uses the generic title
until it arrives, so the tick never waits on OpenAI.

## Fog of war & the private team channel (same-room hidden info)

Hidden info is enforced **server-side** via a per-viewer payload broadcast per-socket
(`io.to(socketId).emit('warfrontState', payloadForViewer(room, name))`), exactly like
Menifot/Codenames — never via CSS.

- **Fog:** every fogged snapshot a viewer always sees their own team's units and bases. Enemy
  units are included **only** if within `WF_VISION` (Manhattan) of a friendly unit or the friendly
  base; enemy units outside vision are omitted entirely (so a push can be hidden until it's on top
  of you — the real-time replacement for the old secret-commit mind game). An enemy Worker's
  **loaded (💎) status** is only revealed when it's in vision — you can't tell from afar whether
  that distant hauler is worth ambushing, which keeps raiding a read, not a certainty. Mineral
  veins, supply sources, weapon tokens, and dropped-load pickups are **static map features and
  always visible** (they're terrain, not hidden info).
- **Own-player data:** the payload carries only the viewer's own `supply`/`minerals`/`arsenal` and
  selection state; a player never sees another player's resources or arsenal (not even a
  teammate's, to keep payloads simple — teammates coordinate via the channel below).
- **Private team channel** — two transient, team-only socket events (fanned out only to
  same-team connected sockets, **never** `roomEmit`, which would leak to opponents):
  - `wfPing { tileId }` — flashes that tile on teammates' maps ("hit here" / "defend here").
  - `wfTeamMessage { id }` — a **preset** tactical phrase from a fixed enum (e.g. "Push!",
    "Defend base", "Need resources", "Hit their base") — no free typing, for speed and safety.
  Both are rate-limited per socket and **not persisted** (not game state).

## Ending the match & scoreboard integration

- Winner = the team whose enemy base hit 0 HP, or (at `WF_MATCH_CAP_MS`) the higher-base-HP team.
  The sim **stops its loop** the instant a winner is decided and sets `phase='gameover'`.
- Standard points, mirroring Codenames: every player on the winning team gets **2** points added
  to `room.scoreboard[name]`; the losing team gets 0. A **draw** (match cap, equal HP) awards 0
  to everyone. `ctx.recordGameResult(room, 'warfront', participants)` records lifetime history
  with `{ name, team, won, points }` per player.
- The `gameover` screen (matching `4-game-over.html`) shows the winner, both bases' final HP, the
  final map, a **per-player battle stats table** — **Kills**, **Lost** (own units lost), **Dmg**
  (damage dealt to the enemy base) — with a **★ MVP** for the most base damage, and the shared
  scoreboard (`renderScoreboard`). Stats are tracked live in `armies[name].stats` and are
  display-only (they don't change points). A **Play Again** (captain or host) regenerates a **fresh
  map** and starts a new battle with the same teams; **Back to Lobby** clears state.

## Disconnects & reconnect

- `onDisconnect` just re-broadcasts — a disconnected player's units simply keep executing their
  last commands (haulers keep hauling, armies hold or finish their move), and the sim never waits
  on anyone. Host handoff is the app's generic `lobby.js` logic. Reconnect is far simpler than the
  old turn model: there are **no draft orders to restore** (commands are instant and already
  applied), so a returning phone just resumes watching the live state.
- `reconnectPayload` (**synchronous**, like every game) returns the phase-aware payload so a
  reconnecting phone lands on the right screen: `teamSelect` → team lists + options; `generating`
  → minimal; `playing` → the current **fogged snapshot** (map, own resources/arsenal, the active
  event, the match clock) so the phone drops straight back into the live board; `gameover` → final
  state + scoreboard.
- `onReconnectBroadcast` re-sends the current state to the room.

## Server state (`room.state.warfront`, namespaced)

Declared via `namespaces: [{ id: 'warfront', createState, savedFields }]`. `createState()`:

All live-sim state is **persisted** (the snapshot every 5s doubles as a mid-match save), and
because every timestamp below is **absolute epoch-ms**, a reloaded match resumes seamlessly.

**Persisted (`savedFields`):**
- `phaseConfig` — `{ matchCapMs, mapSize }` chosen at team-select.
- `lobbyRaces` — `{ [name]: race }` picked at team-select (copied into `armies` at Start, kept for
  Play Again).
- `seed`, `tick` — the match's RNG seed (set at battle start) and the step counter; step N's
  randomness is `rngFor(seed, tick)`, so a restarted match continues the same random stream.
- `nextUnitId` — monotonically increasing unit-id counter (persisted so ids stay unique).
- `winner` — `'red' | 'blue' | 'draw' | null`.
- `map` — the battlefield (theme, lore, width, height, tiles, **supplySources**, **veins**,
  **weapons** (spawn list), bases, chokepoints).
- `bases` — `{ red:{hp,maxHp,tileId,shieldUntil}, blue:{...} }` (`shieldUntil` is an `aegis`
  expiry, 0 when none).
- `armies` — `{ [name]: { team, race, supply, minerals, arsenal:[weaponId],
  facilities:[{id,type,tileId}], queues:{ [spawnTileId]:[{unitType,doneAt}] },
  workshop:[{weaponId,doneAt}], stats:{kills,lost,baseDmg}, units:[Unit] } }`.
  A **Unit** = `{ id, type, class, tileId, hp, owner, carrying, path:[tileId…], stepEndsAt,
  atkReadyAt, haul:{veinTileId}|null }`. `race` is fixed for the match; `carrying` is a loaded
  Worker's Minerals (0 otherwise); `path`/`stepEndsAt` drive movement; `atkReadyAt` gates the next
  auto-attack; `haul` marks a Worker in the auto-haul loop. `facilities` are also mirrored as
  `structure` units for combat; `arsenal` is picked-up/built weapons not yet fired.
- `pickups` — `{ mineralDrops: { [tileId]: amount }, weapons: [{ tileId, weaponId }] }` — dropped
  hauler loads + weapon tokens **still on the map** (map gen's `weapons` minus collected).
- `clock` — `{ startedAt, matchEndsAt, lastTickAt }`.
- `event` — the active battlefield event `{ effectId, endsAt, title, text }` (null between events).
- `nextEventAt` — epoch-ms of the next battlefield-event roll.
- `mapHistory`, `eventHistory` — rolling avoid-lists (windowed) for AI variety.

**Ephemeral (NOT persisted, rebuilt on load):**
- the module-local **sim-loop interval** handle (`wfTimers: Map<roomCode, Interval>`), recreated
  by `repairOnLoad`/`startBattle`.
- nothing else: the seed stream position is derived from the persisted `seed` + `tick`.

Team membership is **not** duplicated here — it's sourced from `p.team`/`p.leader` on
`room.players` (reset by `resetToLobby`), and `armies` is keyed by player name.

### Restart resilience (`repairOnLoad`)

- `generating` → revert to `teamSelect` (an in-flight OpenAI call can't resume).
- `playing` → set `clock.lastTickAt = Date.now()` (so the first post-restart step uses a normal
  `dt`, not a giant catch-up jump), regenerate `event` flavor if the title is missing, and
  **restart the sim-loop interval**. All unit positions/HP/queues/carrying/clock survived in the
  snapshot, so the match picks up where it left off.
- `gameover` → leave as-is (no loop to run).
- Always rebuild the module-local `wfTimers` interval map (lost on restart).

## Explicitly out of scope (v1)

- **Real-time, but grid-step and coarse** — units move live but hop whole tiles on a server tick;
  there is **no free-pixel movement, no unit collision/flocking, no formations, no rally points,
  and no attack-move/patrol micro**. A tile is a stack (many units allowed); an idle unit holds &
  auto-attacks, a moving unit pursues its order and fires in range. Hauling is the automatic
  SCV-style loop — no manual mine/return micro. These are deliberate simplifications to keep the
  sim cheap and phone-renderable; richer control is a later enhancement.
- **No abstract upgrade tree** — "tech" in v1 is the fixed on-map **facilities** menu (Refinery /
  Forward Barracks / Workshop / Tower) only; there are no stat upgrades, research, or unit levels.
- **Facilities, weapons & events are closed, enumerated menus** — the exact facilities above, the
  exact `WEAPON_EFFECTS` ids (`artillery`/`emp`/`airdrop`/`bombard`/`aegis`), and the fixed
  `EVENT_EFFECTS` are all that exist; the AI places/themes/flavors them but never invents a new
  mechanic (the sim must stay deterministic and client-renderable).
- **Only Workers haul; a Worker barely fights** — combat units cannot carry Minerals, and a Worker
  is deliberately a soft target (no RPS role, `atk 1`). Hauling is a single `carrying` int, not a
  cargo inventory.
- **Dropped-load and weapon pickups never expire** — a Mineral drop or un-taken weapon token sits
  on its tile until a unit walks onto it; no decay timers (keeps it out of per-tile lifetime state).
- **Race is picked once and locked** for the whole match — no mid-match race swap. Only the three
  races (Forge/Horde/Arcane) and their listed units/signatures exist; unit abilities are the
  enumerated flag set (`worker`/`structure`/`siege`/`aoe`/`luckBend`/summon) only, nothing bespoke.
- **A summoned Golem is permanent in v1** (no expiry timer) — the "temporary summon" flavor is a
  later enhancement, kept out now to avoid per-unit lifetime state.
- **No real-token/currency betting** — "gambling" here is purely in-game (battlefield events,
  per-hit combat luck, contested-vein load variance, a live-aimed weapon that may whiff); the
  `server/betting.js` wallet is **not** used.
- **No free-for-all mode** — exactly two teams, `red`/`blue`.
- **No free-text team chat** — the private channel is pings + a fixed preset-phrase enum only.
- **No canvas rendering** — the map is DOM (a CSS grid of tiles + absolutely-positioned army
  stacks); units render as **one stack per occupied tile** (count badge), not one node per unit,
  to stay within phone DOM limits.
- **No per-unit free pathing around enemies** — movement is BFS shortest-path over passable
  tiles; blocking is by terrain, not by enemy occupancy (enemies just trigger auto-attacks when in
  range).
