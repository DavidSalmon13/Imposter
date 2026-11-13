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
- New pure-logic engine `server/games/warfront/engine/` (map gen/validation, unit/terrain tables,
  and the **pure seeded simulation step** `stepSim` that advances movement, combat, economy,
  production, events and the win check) plus `server/lib/rng.js` (a seeded PRNG), both unit-tested
  the way `pokerEval.js`/`bluffHands.js` are. The module owns the per-room `setInterval` sim loop
  that drives `stepSim` and broadcasts; the engine itself stays free of sockets/OpenAI/timers.

## Look & feel — the design is binding

**The game must look exactly like the design mockups in `docs/design/warfront/`.** They are the visual
source of truth the same way this spec is the rules source of truth: layout, colours, typography,
panels, the 2.5D tilted battlefield, the SVG unit/building/terrain art, team colouring and
animations all come from there. Build every screen by porting the mockup's markup, CSS and SVG
(editable originals in `docs/design/warfront/source/*.dc.html`; how they're built is in
`docs/design/warfront/README.md`) — not by re-creating a look-alike, and never with placeholder emoji
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

## Game feel (sound, haptics, impact, zoom, readability)

Agreed 2026-11-12 (plan Steps 16–20). All of it is client-only and runs off what `wfLive`/`wfAlert`
already send: each event's `owner`/`team`, `unitId`, `unitType`, and the per-socket alert. No engine
or sim-loop change.

- **Own things only.** Players sit in one room, so a phone makes sounds and vibrations only for its
  owner's units, structures and production, its team's base, its own "Under attack" alert, and the
  end of the match. Enemy hits, deaths and spawns, and a teammate's units, stay silent and still.
- **Sound** is synthesized with the Web Audio API (no audio files) through the app's one shared
  `AudioContext`, which is unlocked on the first tap (iOS requirement). The cues are: own unit hit,
  own unit death, own unit produced, own building finished, own base hit, Under attack, victory,
  defeat. Volume defaults to quiet: one Warfront master gain well below the app's other cues. Repeats
  are throttled per cue (at most one hit sound per 120 ms; the other cues have their own gaps, listed
  in `audio.js`), and a burst of events in one snapshot plays each cue at most once.
- **Haptics** (`navigator.vibrate`, feature-detected, so iOS Safari silently does nothing): own base
  hit, own unit produced, the Under attack alert, the end of the match, plus the existing tap/error
  ticks. Repeats are throttled like sound.
- **Toggles.** The ☰ battle menu gets **Sound** and **Vibration** on/off rows. Sound is the app-wide
  mute (the lobby's speaker button, `shorot-muted`), so muting in one place mutes the other.
  Vibration is Warfront's own (`wf-vibrate`, default on). Both are remembered in `localStorage`,
  every read and write wrapped in `try/catch` (a blocked store just means the default).
- **Impact feedback.** A stack that takes damage flashes white briefly; a stack that gains a newly
  produced unit pops (a short scale-up); your own base being hit gives the camera a small shake (the
  camera container, never the tilted world, so the 3D tilt is unchanged). With
  `prefers-reduced-motion: reduce`, shake and pop are off (the flash stays, it doesn't move). Effects
  animate only `transform` and `opacity`.
- **Stacks update in place.** A stack is rebuilt only when its unit make-up (types and counts),
  selection, load or shared-tile placement changes. HP changes and hits update the existing node:
  the HP bar's fill is a `scaleX` transform, recoloured green/amber/red at the same 75%/35% thresholds.
- **Zoom.** Two-finger pinch on the battlefield, and ctrl+wheel (trackpad pinch) on desktop, zoom
  between `WF_ZOOM_MIN` 0.6 and `WF_ZOOM_MAX` 1.6 (1 = the mockup's scale), anchored on the point
  between the fingers (or under the cursor). One-finger panning and tap-to-select/move are unchanged,
  a tap lands on the tile under the finger at every zoom, and the minimap's view box shows exactly
  what's on screen. The zoom resets to 1 for each new battle and isn't persisted.
- **Readability.** On a 360px-wide phone in a 4v4 fight, unit types and teams must be told apart at a
  glance. The exact treatment is designed in the mockups first (`2b-unit-roster.html`,
  `2-battlefield.html`) and recorded here once approved.
- **Selection.** Your selected stacks stand out at phone scale (treatment set in the mockups, Step 21),
  without an animation that runs while they stand still.
- **Soldier HP and army size.** Each soldier's HP is visible (on the map per figure, and per unit in
  the console for the selection), and the HUD shows your army size against the cap (`⚔ 14/30`).
- **Bulk actions.** The console has **Select all** (all your combat units; a second tap adds Workers).
  A Produce card tap always queues exactly **one** unit (the ×1 / ×5 switch was removed 2026-11-12 with
  David: units queued five at a time kept walking out long after the taps and read as a production bug).
- **Building info.** Long-pressing any building in sight (yours or an enemy's) shows its name, what it
  does and its HP in the info well for 4 s without changing the selection. A tap on your own building
  with nothing selected still picks it, as before.
- **Idle cost.** None of the above runs a per-frame loop: sounds, haptics and effects fire from
  snapshot events, and zoom only does work during a gesture.

## Configurable constants

Tuning lives in the engine's `TUNING` block in `server/games/warfront/engine/constants.js` (gameplay
balance) and the shell's `server/games/warfront/constants.js` (timing/roster). All are expected to be iterated on during a balance pass.

| Constant | Value | Meaning |
|---|---|---|
| `WF_MIN_PLAYERS` | 2 | Connected players needed to start (1v1) |
| `WF_MAX_PLAYERS` | 8 | Max roster (4v4) |
| `WF_MIN_TEAM_SIZE` | 1 | Players a team needs to start |
| `WF_TICK_MS` | 200 | Simulation step interval (server advances the world ~5×/s) |
| `WF_BROADCAST_MS` | 200 | How often a fogged snapshot is pushed to each socket |
| `WF_STEP_MS_BASE` | 1911 | Time to walk one plains tile at `Move 1` (÷ the Move speed factor, × terrain move-cost). A Warrior crosses a medium map (14 tiles) in ~27 s, a Raider in ~13 s (×1.5 faster than 2867 on 2026-11-12, which was ×1.5 faster than 4300 on 2026-11-11) |
| `WF_MATCH_CAP_MS` | 720000 | Hard match length (12 min); at the cap, higher base HP wins |
| `WF_EVENT_MS` | 60000 | Interval between battlefield events |
| `WF_VISION` | 2 | Fog-of-war vision radius (Manhattan) around friendly units/base |
| `WF_LIGHTHOUSE_VISION` | 5 | Vision radius (Manhattan) around each lighthouse a team controls (see "Lighthouses") |
| `WF_MAX_LIGHTHOUSES` | 4 | Most lighthouses a map may have |
| `WF_MAX_UNITS_PER_PLAYER` | 30 | Unit cap per player (structures and Golems included); Produce is a no-op at the cap. Bounds payload size and DOM count on phones |
| `WF_MAX_DT_MS` | 1000 | Clamp on one sim step's `dt` (protects against event-loop stalls) |
| `WF_REVEAL_MS` | 3000 | How long an attacker stays visible to the team it just hit (see "Under attack") |
| `WF_ALERT_COOLDOWN_MS` | 10000 | Minimum gap between two "Under attack!" alerts for one player in the same area |
| `WF_ALERT_AREA` | 4 | A hit at least this many tiles (Manhattan) from the last alert's tile counts as a new area and alerts at once |
| `TUNING.fallBackMaxTiles` | 3 | Furthest an idle unit walks on its own to get out of an attacker's reach |
| `MAP_SIZES` | Small 12×8 · Medium 16×11 · Large 20×13 | Host's map-size option (width×height in tiles) |
| `MATCH_LENGTHS` | Short 8 min · Standard 12 min · Long 16 min | Host's match-length option (sets `WF_MATCH_CAP_MS`; Standard is the default) |
| `TUNING.baseHp` | 120 | Starting base HP |
| `TUNING.baseAtk` / `baseRange` / `baseAttackMs` | 2 / 1 / 1500 | A base's own weak tower-like attack (see "Combat") |
| `TUNING.startSupply` | 6 | Each player's **🔩 Supply** at match start |
| `TUNING.startMinerals` | 0 | Each player's **💎 Minerals** at match start (minerals are earned by hauling) |
| `TUNING.startWorkers` | 2 | Worker units each player begins with, on their base tile |
| `TUNING.supplyCarveSec` | 0.8 | Supply **per second** a Worker carves while standing on a tile of its own **supply wall** |
| `TUNING.supplyCarryCap` | 3 | Max Supply a Worker carries before walking it into the base |
| `TUNING.forgeCarveBonus` | 0.5 | **Forge** Workers carve this much faster (×1.5) |
| `TUNING.incomeWindowMs` | 20000 | The HUD's +🔩/s is the Supply delivered over this window |
| `TUNING.forgeStructureDiscount` | 1 | 💎 off every facility and tower a **Forge** player builds |
| `TUNING.mineLoadSec` | 0.5 | Minerals **per second** a Worker loads on a vein, × the vein's richness |
| `TUNING.carryCap` | 4 | Max Minerals a Worker carries before the auto-haul loop returns to deposit |
| `TUNING.buildMsPerCost` | 1200 | Build/spawn time **per point of a unit's 🔩 Supply cost** |
| `TUNING.attackMs` | 1500 | Base attack cooldown (per-unit overrides allowed). Slowed from 1000 together with every unit's HP ×2 (2026-11-12) so fights last ~3× longer |
| `TUNING.luckMagnitude` | 0.35 | ± per-hit damage swing at zero strategy edge |
| `TUNING.hillRangeBonus` | 1 | Extra range for a **ranged** unit (base `Rng` ≥ 2) standing on hills (see "High ground") |
| `TUNING.uphillRangePenalty` | 1 | Range lost by a ranged unit **off** the hills shooting at a target **on** hills |
| `TUNING.unitHpScale` | 1.5 | Every unit type's HP in the race tables below is multiplied by this (2026-11-12; e.g. Militiaman 22 → 33) |
| `TUNING.towerGarrison` / `towerRangeBonus` / `towerVisionBonus` / `towerFallDmg` | 3 / 1 / 1 / 0.25 | Tower roof garrison size, its ranged bonus, the Tower's extra sight, and the max-HP share a garrison loses when its Tower falls (see "Towers") |
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
its walking speed**, not a per-round step budget: Move 1 / 2 / 3 walk at ×1 / ×1.5 / ×2 the base
speed (a speed factor of `(1 + Move) ÷ 2`), slowed by terrain move-cost. On open plains a Warrior
crosses a medium map in about 27 s and a Raider in about 13 s, so a raid is seen coming. Each combat unit also has an **attack range** (the `Rng` column, Manhattan
distance; `0` = its own tile only) and an **attack cooldown** (`attackMs`); it auto-attacks the
nearest enemy in range each cooldown. The 🔩 Supply cost also sets build time
(`buildMsPerCost × 🔩`). See "Combat" under the simulation section.

Four classes sit outside the triangle and interact via flags instead: **worker** (harvests Supply
at home and hauls Minerals from veins — barely fights, `atk 1`; the economic engine and the game's
juiciest soft target), **siege** (devastating vs structures/bases, fragile vs mobile units),
**caster** (fragile; some have `aoe`), and **structure** (can't move, high defense — bases, towers,
Forge's Bastion, a summoned Golem). Each race also has a **signature** modifier.

HP below is the base value; the game uses `HP × unitHpScale` (1.5), and each unit's real numbers
(power, HP, speed, range) and a one-line description show on its Produce card (long-press it) and
in the info well when it's selected.

**Every race fields a Worker** (same stats, race flavor name). Workers are how both resources
flow, so losing them starves you — defend yours, hunt theirs.

| Unit | Icon | Class | HP | Atk | 🔩 | 💎 | Move | Rng | Notes |
|---|---|---|---|---|---|---|---|---|---|
| Laborer (Forge) / Peon (Horde) / Acolyte (Arcane) | ⛏️ | worker | 10 | 1 | 3 | 0 | 1 | 1 | carves Supply at its supply wall (`supplyCarryCap 3`); loads Minerals on a vein (`carryCap 4`); deposits at base/Refinery; outside the RPS triangle (flat ×1) |

**⚒️ FORGE — the great builders.** Specialty: **defense + economy** (Forge Workers carve
Supply `forgeCarveBonus` faster, every Forge facility and tower costs `forgeStructureDiscount` 💎
less, and only Forge fields the Bastion). All races can build, but Forge turtles and out-produces
best.

| Unit | Icon | Class | HP | Atk | 🔩 | 💎 | Move | Rng | Notes |
|---|---|---|---|---|---|---|---|---|---|
| Militiaman | 🛠️ | melee | 22 | 4 | 3 | 0 | 1 | 1 | basic; cheap, sturdy |
| Crossbow | 🎯 | ranged | 14 | 5 | 4 | 0 | 1 | 2 | basic |
| Outrider | 🐴 | mounted | 16 | 4 | 5 | 2 | 2 | 1 | |
| Bastion | 🏯 | structure | 40 | 3 | 6 | 3 | 0 | 0 | can't move; very high defense; attacks enemies on its own tile |
| Ballista | 💥 | siege | 16 | 4 | 6 | 4 | 1 | 2 | `×3` atk vs structures **and** bases |

**⚔️ HORDE — the great fighters.** Specialty: **raw combat** — Horde units get `×1.15` attack
and a **reduced luck swing** (`×0.6`); reliable brutes for whom strategy beats luck.

| Unit | Icon | Class | HP | Atk | 🔩 | 💎 | Move | Rng | Notes |
|---|---|---|---|---|---|---|---|---|---|
| Warrior | 🗡️ | melee | 22 | 5 | 3 | 0 | 1 | 1 | basic |
| Skirmisher | 🪃 | ranged | 14 | 5 | 4 | 0 | 1 | 2 | basic |
| Raider | 🐎 | mounted | 18 | 4 | 5 | 2 | 3 | 1 | fastest unit in the game |
| Berserker | 🪓 | melee | 12 | 9 | 5 | 2 | 1 | 1 | glass cannon |
| Warchief | 👑 | melee | 32 | 7 | 8 | 5 | 1 | 1 | elite bruiser |

**🔮 ARCANE — the magicians.** Specialty: **area magic + luck manipulation** (fragile,
expensive, high-impact — and the race that bends the game's luck, tying into the gambling theme).

| Unit | Icon | Class | HP | Atk | 🔩 | 💎 | Move | Rng | Notes |
|---|---|---|---|---|---|---|---|---|---|
| Apprentice | ✨ | caster | 12 | 4 | 3 | 0 | 1 | 2 | basic |
| Mystic Archer | 🏹 | ranged | 12 | 5 | 4 | 0 | 1 | 2 | basic |
| Battlemage | 🔥 | caster | 16 | 6 | 6 | 3 | 1 | 1 | `aoe`: hits **every** enemy unit on its target's tile |
| Summoner | 🧿 | caster | 14 | 3 | 6 | 4 | 1 | 2 | producing one also summons a **Golem** at the base |
| Archmage | 🪄 | caster | 20 | 7 | 9 | 6 | 1 | 2 | `luckBend`: hits by friendlies within 2 tiles of it get luck `×0.5`; hits on friendlies within 2 tiles of it get the enemy's luck `×1.5` (several Archmages don't stack) |
| Golem | 🗿 | structure | 36 | 5 | — | — | 0 | 1 | summoned by a Summoner (not built directly); can't move |

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

## Free-for-all mode (3–4 players, added 2026-11-13)

A second **mode** next to the team game. The host picks it on the team-select screen
(`room.state.warfront.mode`: `'teams'` (default) | `'ffa'`). Team games are unchanged.

- **Who:** 3 or 4 players, each on their own. Start Battle in FFA needs 3–4 joined players, each
  with a race; team buttons, captains and Randomize Teams are hidden (the host starts).
  (Step 28: there is no join button in FFA, so every connected player in the room plays; a 5th
  player in the room blocks the start. The host's `wfSetMode` switch clears everyone's team and
  captaincy and lifts a Small map to Medium. Only the host may start, Play Again or Restart.)
- **Sides:** the engine knows four sides, `SIDES = ['red', 'blue', 'green', 'gold']`. A team game
  uses red and blue as today; in FFA each player gets one side (seeded random order at Start). A
  side is a team of one, so fog, targeting, vision, lighthouses, alerts and "your team" all work
  per side. Everyone else is an enemy.
- **Map:** one base in each corner, inset one tile from the edges (3 players leave one corner
  empty, chosen by the seed). Each base has its supply wall and a home lighthouse beside it. Veins
  and any contested lighthouses sit in the middle, the same distance from every base. Map size
  options stay the same, but FFA uses at least **Medium** (Small is not offered). The fallback
  generator mirrors one quarter onto all four (both axes), so every corner gets the same land.
  Validation (2026-11-13, Step 26): each base in its own corner quarter, its home lighthouse in that
  quarter within 4 tiles, any contested lighthouse within 2 tiles of the same distance from every
  base, veins (1–2) fair by the spread of their distances to every base, and every base reaching
  every other. A map has `sides`–4 lighthouses, so a 4-player map has only the home ones.
- **Elimination:** a base at **0 HP knocks its side out at once**. Its units and buildings crumble
  (removed with a `death` event each, no Mineral drops) and its held lighthouses go neutral. The
  player stays in the room and **watches with the fog lifted** (the whole map, like the game-over
  view) until the match ends. Their commands are refused.
  (Step 27: crumbling isn't counted as **Lost**; the step that ends the match leaves the final board
  as it stands. Every player gets a `knockedOut { team, place }` event.)
- **Winning:** the **last side standing** wins at once. If the last bases fall in the same step,
  it's a draw between those sides. At `WF_MATCH_CAP_MS` the standing side with the **most base HP**
  wins; equal top HP is a draw.
- **Placing and points:** sides are ranked by when they were knocked out (later is better); at the
  match cap the survivors are ranked by base HP. Points: **1st 3, 2nd 1**, the rest 0; a draw for
  1st gives each of those sides 2. History records `{ name, team: side, won: place === 1, points }`.
- **Bombard** in FFA is aimed at any enemy base (tap it). **Under attack** alerts, the HUD and the
  game-over screen list every side's base (up to 4 small HP bars, each in its side's colour).

## Map generation (`generating`)

Entered on Start Battle (and on Play Again). Sets `phase = 'generating'`, emits the shared
`generating` event (so the app's "Building the battlefield…" screen shows), then:

1. **Try OpenAI.** `generateBattlefield(room)` builds a prompt — open top-down battlefield, two
   bases at opposite ends, roughly mirror-symmetric fairness, water/rock impassable, **one supply
   source beside each base**, **1–2 mineral veins out in the contested middle** (the richest ones
   farthest from either base), **a few scattered weapon tokens** (rarer ones deeper in contested
   ground), **2–4 lighthouses** (one near each base, plus up to two at strategic contested spots;
   see "Lighthouses"), and natural chokepoints — plus a short theme + lore — with an **avoid-list** of recent
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
  "supplySources": [ { "x": 1, "y": 3 }, { "x": 7, "y": 3 } ],     // exactly one adjacent to each base; grows into a 3-tile supply wall
  "veins":   [ { "x": 4, "y": 1, "richness": 1|2|3, "contested": true } ],  // 1-2 mineral veins to haul from
  "weapons": [ { "x": 4, "y": 5, "weaponId": "artillery|emp|airdrop|bombard|aegis" } ],  // ground pickups
  "lighthouses": [ { "x": 2, "y": 2 }, { "x": 6, "y": 4 }, { "x": 4, "y": 1 } ],  // 2-4: one near each base + up to 2 contested
  "chokepoints": [ { "x": 4, "y": 2 } ]
}
```

## The real-time simulation (`playing`)

The whole match runs in a single `playing` phase. The module runs a **simulation loop** per active
room: every `WF_TICK_MS` it advances the world, and every `WF_BROADCAST_MS` it pushes a **fogged
snapshot** to each socket, which the phone renders and tweens. No rounds, no commit, no reveal —
commands apply the instant they arrive and the sim plays them out.

The core is a **pure, seeded** engine function `stepSim(state, dtMs, { seed, tick })` in
the engine (`engine/sim.js`) that advances every system by `dtMs` and returns `{ state, events }`. `events`
is a list of discrete things that happened this step (`spawn` / `death` / `deposit` / `baseHit` /
`weapon` / `pickup` / `battlefieldEvent`) for client sound/FX **only** — the client renders the
authoritative `state` and never recomputes anything. Because `stepSim` is pure and seeded, the full
simulation is deterministic and unit-testable (feed a state, tick N times, assert positions / HP /
economy), preserving the repo's pure-engine testing discipline even though the game is now live.

### Commands (client → server, applied instantly)

A player issues commands live; each is validated and applied the moment it arrives — no draft, no
commit, no debit-at-reveal. The single `wfCommand` event carries one of:

- **Move** `{ kind:'move', unitIds, toTileId }` — the selected unit(s) compute the fastest path
  (A*, weighted by each entered tile's move cost, so they go around a hill or forest when that's
  quicker) over passable terrain and **start walking immediately**. Re-issuing repaths at once; several
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
- **Hold** `{ kind:'hold', unitIds }` — the units stop where they are (path and haul loop cleared)
  and **stand their ground**: a holding unit never falls back on its own (see "Under attack"). A
  later move or haul order clears `holding`.
- **Craft** `{ kind:'craft', weaponId }` — with a finished **Workshop**, debits
  `workshopWeaponCost` 💎 now and makes that weapon in `workshopWeaponMs` (one at a time per player;
  see "Facilities").
- **Fire weapon** `{ kind:'weapon', weaponId, targetTileId }` — spends a weapon from the player's
  **arsenal**; the effect applies live (see "Special weapons").

All commands are validated server-side (ownership, race, affordability, unit cap, buildable tile, passability) and
ignored if invalid — a bad tap is a no-op, never an error that stalls the sim.

### Movement (grid-step, real time)

A unit occupies a tile and, when it has a path, walks to the next tile over
`stepMs = WF_STEP_MS_BASE ÷ ((1 + moveStat) ÷ 2) × terrainMoveCost(nextTile)`. When a step completes the unit
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
move order) **stays put and auto-attacks** enemies that enter range but does not chase — unless it
is hit by an enemy it can't hit back, in which case it **falls back** (see "Under attack"); a unit
with a move order pursues it and fires at anything in range along the way; a unit on **Hold**
never moves on its own. The enemy **base tile**
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

### Under attack (alerts, reveal, fall back)

Agreed 2026-11-11 so a player never loses units without knowing it, even to an unseen shooter
(an archer on a hill outranges your `WF_VISION`).

- **Alert.** Whenever one of a player's units or structures takes damage, the sim emits an
  `underAttack { tileId, owner }` event. The module turns it into a private **"Under attack!"**
  alert for that owner only (per-socket, never `roomEmit`): a banner, a phone buzz and a flashing
  ping on the tile and on the minimap. It is throttled per player: at most one alert every
  `WF_ALERT_COOLDOWN_MS`, except that a hit `WF_ALERT_AREA`+ tiles from the last alert's tile
  alerts at once. Damage to a **base** alerts every player on that team. The throttle is
  ephemeral module state (not persisted).
- **Reveal.** An enemy unit that damages a unit or structure becomes visible to the victim's whole
  team for `WF_REVEAL_MS` after each hit (`unit.revealedUntil[team]`), even outside their vision,
  so you can see where the attack is coming from.
- **Fall back.** An **idle** unit (no path, no haul loop, not on Hold, not a structure) that is hit
  by an enemy it **can't hit back** (out of its effective range, or across the cliff edge for
  melee) automatically walks to the nearest passable tile that is out of that attacker's effective
  reach, at most `fallBackMaxTiles` steps away (BFS, deterministic N/E/S/W tie-break). If no such
  tile exists it stays. Afterwards it is idle again. A unit that **can** hit the attacker fights
  instead; a unit on **Hold** stands its ground; a unit with an order keeps following it.

### Economy (accrues continuously)

- **🔩 Supply via the supply wall (2026-11-13):** there is **no free income**. Each base has a short
  **supply wall** of rock beside it: the map's supply source plus the free tiles either side of it,
  across the line from the base (up to 3 tiles; `map.supplyWalls`). A Worker sent to a tile of its own
  wall (a `haul` command onto that tile) carves `supplyCarveSec` Supply/sec (**Forge** ×(1 +
  `forgeCarveBonus`)) up to `supplyCarryCap`, walks the load into its **base** (the only Supply
  deposit), banks it, walks back and repeats until re-ordered. The starting Workers, and every Worker
  produced later, start carving on their own. A carver killed with a load loses it (no drop). The
  HUD's rate is the Supply delivered over the last `incomeWindowMs`. Nobody may carve the enemy wall.
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
  loses; both bases falling in the same step is a draw); at `WF_MATCH_CAP_MS` the **higher-HP base
  wins** (`winnerByBaseHp`; equal HP is a draw).

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

Agreed with David 2026-11-12 (Step 9):
- **Construction.** A build places a **construction site** at once: the structure unit, at full
  HP, owned by the builder, seen and attackable like any unit. It has no effect and doesn't attack
  until its build time is up. Destroying a site loses the Minerals. Facilities and towers count
  toward `WF_MAX_UNITS_PER_PLAYER`, so a build at the cap is refused.
- **Refinery bonus.** The owner's Workers load **+1 Mineral/sec** on that vein (on top of
  `mineLoadSec × richness`); enemies mining it get nothing, and several Refineries on one vein don't
  stack. Only a finished Refinery counts, as a bonus or as a deposit point.
- **Workshop.** `{ kind:'craft', weaponId }` (any `WEAPON_EFFECTS` id) needs at least one finished
  Workshop. Weapons are made **one at a time per player** in `armies[name].workshop` (a sequential
  queue, like a spawn point's); each finished weapon joins the arsenal.
- **Lost work.** When a facility is destroyed, its paid-for work in progress is **lost, no refund**:
  a Forward Barracks' unit queue goes with it, and the player's Workshop queue is lost when their
  last Workshop falls.

**Structures are no longer Forge-exclusive** — all races may build facilities and towers. Forge's
edge is the **Bastion** (Forge-only), the `forgeWorkerBonusSec` Supply bonus, and
`forgeStructureDiscount` 💎 off every facility and tower; it is still the turtle race, just not the
only one that can fortify.

## Towers (hold a place so your army can leave)

A **Tower** (`{ kind:'build', facility:'tower', tileId }`, **💎4**, HP 40, atk 3, builds in 6s) is
a `structure` that can't move, has high defense, and **auto-attacks enemy units within range `1`** (its own + adjacent
tiles) on its `attackMs` cooldown like any unit. Its whole purpose is the answer to *"if I push, my
base/vein is open"*:
a single Worker + a Tower can **hold a vein or a chokepoint** while your army operates elsewhere.
The AI map emits `chokepoints`, so a tower on a one-tile pass is geometry-strong and forces the
enemy to commit real force (or a weapon) to break through. Because towers cost Minerals, security
is always paid for out of your tech budget — never free.


**Garrison (agreed with David 2026-11-12).** A finished Tower is tall, with a flat roof that up to
`towerGarrison` (3) friendly units stand on, drawn on top of it. A unit climbs up when its move
ends on the Tower's tile (or it is sent there while standing beside it) and there's room; haulers
pass through. Any move order climbs it down.
- **Untargetable.** Nobody can hit a unit on the roof (AoE skips it too): the enemy has to knock
  the Tower down first.
- **Shooting from the top.** Ranged units and casters on the roof attack with
  `range + towerRangeBonus` (instead of the hill rule); melee and Workers on the roof just hide.
- **When it falls**, the garrison drops to the Tower's tile and loses `towerFallDmg` of its max HP
  (never killed by the fall).
- **Height.** A finished Tower sees `WF_VISION + towerVisionBonus` tiles.

## Lighthouses (capture the high watch)

Agreed with David 2026-11-11. **Lighthouses** are tall map features that give whoever controls
them a far wider view, so they're worth fighting over (StarCraft's Xel'Naga towers).

- **Placement (map gen).** At most `WF_MAX_LIGHTHOUSES` (4) per map, chosen for strategy: **exactly
  one near each base** (on that base's half, within 4 tiles of it, not on the base tile), plus **0–2
  more at contested spots** — high ground, chokepoints or near the veins — placed fairly (each extra one
  roughly as far from one base as from the other, within 2 tiles, or as a mirrored pair). Passable
  tile, reachable, never sharing a tile with another feature. `validateMap` checks all of this;
  the procedural fallback map places one per base and a mirrored contested pair.
- **Starting owner.** Each home lighthouse starts owned by that base's team; the contested ones
  start **neutral**.
- **Capture.** A lighthouse belongs to the team whose units stand on its tile. When units of only
  one team stand on it, it flips to that team at once. If both teams stand on it, or nobody does,
  it keeps its current owner. It can't be destroyed and never goes back to neutral.
- **Vision.** A controlled lighthouse gives its team vision of every tile within
  `WF_LIGHTHOUSE_VISION` (5, Manhattan) of it, on top of the normal `WF_VISION` around units and the
  base. That's fog only: it gives no combat, range or economy bonus.
- **Visible to all.** Lighthouses are static map features like veins: every player sees where they
  are and which team (or nobody) controls each one; the lamp shows the owner's team colour.
- A flip emits a `lighthouse { tileId, team }` event (client FX and a line in the map's notice style).

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

Agreed with David 2026-11-13 (Step 10):
- **Aiming.** Artillery may land on **any** tile, fogged or not; on a tile with no enemy it whiffs
  and is still used up. It hits every enemy unit and structure on the tile, but not a Tower's roof
  garrison (like other area damage); a Tower it knocks down drops its garrison as in combat. An
  **EMP** must target an enemy facility or Tower on a tile your team **can see** (so it can't be
  used to probe the fog). **Bombard** targets the enemy base tile, **Aegis** your own base tile,
  and **Airdrop** a passable tile your team can see. A refused aim keeps the weapon.
- **EMP switches off everything** the building does for `empMs`: a Tower doesn't shoot, a Refinery
  gives no load bonus and isn't a deposit point, a Forward Barracks isn't a spawn point and its
  queue waits, a Workshop's crafting waits (while all of that player's Workshops are off), and a
  construction site stops building. Waiting timers shift by the time lost.
- **Aegis blocks everything**, a Bombard included (the Bombard is still used up).
- **Airdrop at the cap** lands as many of the `airdropCount` units as fit under
  `WF_MAX_UNITS_PER_PLAYER`, and is refused (kept) when none fit.
- **Stats.** Artillery kills count as **Kills** and Bombard damage as base **Dmg** (so toward MVP).
- **UI.** The console's **Weapons** tab shows one card per weapon id with how many you hold. Tap a
  card to arm it (the info well says where to tap, and the valid target tiles glow), tap the map
  to fire; tap the card again or press Escape to stand down. An EMP'd building turns grey with a
  blue spark, a shielded castle gets a gold dome, and each shot plays its effect for whoever can
  see the tile, with a notice line for the firer and the team it was aimed at.

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
  base, or within `WF_LIGHTHOUSE_VISION` of a lighthouse their team controls; enemy units outside vision are omitted entirely (so a push can be hidden until it's on top
  of you — the real-time replacement for the old secret-commit mind game). An enemy Worker's
  **loaded (💎) status** is only revealed when it's in vision — you can't tell from afar whether
  that distant hauler is worth ambushing, which keeps raiding a read, not a certainty. Mineral
  veins, supply sources, weapon tokens, dropped-load pickups and lighthouses (with their owner) are
  **static map features and always visible** (they're terrain, not hidden info). An enemy that just hit your team stays
  visible for `WF_REVEAL_MS` even outside vision (see "Under attack").
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
- **In-battle menu (☰ Menu, top-left of the battlefield):** **Restart battle** (captain or host,
  `restartWarfront`, `playing` only) abandons the running battle with no winner and **no points**, then
  regenerates a fresh map with the same teams and races, exactly like Play Again. **Back to lobby**
  (anyone, with a confirm) ends the battle for everyone. Both ask for confirmation first.

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
- `winner` — a side (`'red' | 'blue' | 'green' | 'gold'`) `| 'draw' | null`.
- `placings` — `[{ side, place }]`: sides as they are knocked out, then the survivors when the match
  ends (free for all; a team battle fills it too).
- `lighthouses` — `[{ tileId, team: 'red'|'blue'|null }]`, the map's lighthouses and who controls each.
- `map` — the battlefield (theme, lore, width, height, tiles, **supplySources**, **veins**, **lighthouses**,
  **weapons** (spawn list), bases, chokepoints).
- `bases` — `{ red:{hp,maxHp,tileId,shieldUntil}, blue:{...} }` (`shieldUntil` is an `aegis`
  expiry, 0 when none).
- `armies` — `{ [name]: { team, race, supply, minerals, arsenal:[weaponId],
  facilities:[{id,type,tileId}], queues:{ [spawnTileId]:[{unitType,doneAt}] },
  workshop:[{weaponId,doneAt}], stats:{kills,lost,baseDmg}, units:[Unit] } }`.
  A **Unit** = `{ id, type, class, tileId, hp, owner, carrying, path:[tileId…], stepEndsAt,
  atkReadyAt, haul:{veinTileId, stage:'toVein'|'loading'|'toDeposit', luck}|null, holding, revealedUntil:{red,blue} }`. `race` is fixed for the match; `carrying` is a loaded
  Worker's Minerals (0 otherwise); `path`/`stepEndsAt` drive movement; `atkReadyAt` gates the next
  auto-attack; `haul` marks a Worker in the auto-haul loop (`luck` is the contested-vein swing, rolled once per load). `facilities` are also mirrored as
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
- **Free for all is 3–4 players on their own** — no FFA teams (2v2v2), and no more than four sides.
- **No free-text team chat** — the private channel is pings + a fixed preset-phrase enum only.
- **No canvas rendering** — the map is DOM (a CSS grid of tiles + absolutely-positioned army
  stacks); units render as **one stack per occupied tile** (count badge), not one node per unit,
  to stay within phone DOM limits.
- **No per-unit free pathing around enemies** — movement is fastest-path (A*, terrain move-cost) over passable
  tiles; blocking is by terrain, not by enemy occupancy (enemies just trigger auto-attacks when in
  range).
