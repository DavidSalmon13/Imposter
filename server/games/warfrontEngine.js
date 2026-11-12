'use strict';

// Warfront engine: pure, deterministic game logic. No sockets, timers, OpenAI,
// Date.now() or Math.random() — time arrives as `now`, randomness from
// rngFor(seed, tick) in server/lib/rng.js. Rules: docs/specs/warfront-specs.md.
// Build order: docs/implementation/warfront-plan.md (Step 1 = the data tables below).

const { rngFor } = require('../lib/rng');

// ---------------------------------------------------------------------------
// Engine-side constants (spec "Configurable constants"). Socket/loop timing
// (WF_TICK_MS, WF_BROADCAST_MS, roster limits) lives in the module, warfront.js.
// ---------------------------------------------------------------------------

// One plains tile at Move 1 (D16, sped up ×1.5 on 2026-11-11): a Warrior crosses a medium map in ~40 s.
const WF_STEP_MS_BASE = 2867;
const WF_MATCH_CAP_MS = 720000;
const WF_EVENT_MS = 60000;
const WF_VISION = 2;
const WF_MAX_UNITS_PER_PLAYER = 30;
const WF_MAX_DT_MS = 1000;
// How long an attacker stays visible to the team it just hit (spec "Under attack").
const WF_REVEAL_MS = 3000;
// Lighthouses (spec "Lighthouses", D15): at most this many per map, and the
// vision radius (Manhattan) around each one a team controls.
const MAX_LIGHTHOUSES = 4;
const WF_LIGHTHOUSE_VISION = 5;
// A home lighthouse stands within this many tiles of its base.
const LIGHTHOUSE_HOME_RANGE = 4;
// An extra (contested) lighthouse is fair if its distances to the two bases differ by at most this.
const LIGHTHOUSE_FAIRNESS = 2;

const TUNING = Object.freeze({
  baseHp: 120,
  baseAtk: 2,
  baseRange: 1,
  baseAttackMs: 1500,
  startSupply: 6,
  startMinerals: 0,
  startWorkers: 2,
  baseTrickleSec: 0.3,
  supplyPerWorkerSec: 0.5,
  forgeWorkerBonusSec: 0.25,
  forgeStructureDiscount: 1,
  mineLoadSec: 0.5,
  carryCap: 4,
  buildMsPerCost: 1200,
  attackMs: 1000,
  luckMagnitude: 0.35,
  structureDefense: 1.5,
  veinLuckMagnitude: 0.4,
  artilleryDmg: 8,
  bombardDmg: 15,
  empMs: 15000,
  aegisMs: 10000,
  airdropCount: 3,
  workshopWeaponCost: 6,
  workshopWeaponMs: 10000,
  supplyDropAmount: 5,
  sandstormLuck: 2,
  // Combat modifiers named in the spec's Combat section.
  rpsCounter: 1.5,
  rpsCountered: 0.67,
  hordeAtkMult: 1.15,
  hordeLuckMult: 0.6,
  archmageOwnLuckMult: 0.5,
  archmageEnemyLuckMult: 1.5,
  luckBendRadius: 2,
  dominantClassRadius: 2,
  siegeVsStructureMult: 3,
  // High ground (D13) and falling back out of reach (D14).
  hillRangeBonus: 1,
  uphillRangePenalty: 1,
  fallBackMaxTiles: 3,
  // Economy modifiers named in the spec's Facilities / Events sections.
  refineryVeinBonus: 1,
  mineralRushMult: 2,
  // AI variety windows.
  mapHistoryWindow: 8,
  eventHistoryWindow: 8,
});

// ---------------------------------------------------------------------------
// Races & units
// ---------------------------------------------------------------------------

const RACES = Object.freeze({
  forge: {
    id: 'forge',
    name: 'Forge',
    specialty: 'Defense + economy: Workers earn bonus Supply, structures cost 1 Mineral less, only Forge fields the Bastion.',
    workerType: 'laborer',
    airdropUnit: 'militiaman',
  },
  horde: {
    id: 'horde',
    name: 'Horde',
    specialty: 'Raw combat: ×1.15 attack and a narrower luck swing.',
    workerType: 'peon',
    airdropUnit: 'warrior',
  },
  arcane: {
    id: 'arcane',
    name: 'Arcane',
    specialty: 'Area magic + luck manipulation: fragile, expensive, high-impact.',
    workerType: 'acolyte',
    airdropUnit: 'apprentice',
  },
});

// Combat classes. The RPS triangle is melee > mounted > ranged > melee; the
// other four sit outside it (flat ×1).
const RPS_CLASSES = Object.freeze(['melee', 'mounted', 'ranged']);
const UNIT_CLASSES = Object.freeze([...RPS_CLASSES, 'worker', 'siege', 'caster', 'structure']);
const RPS_BEATS = Object.freeze({ melee: 'mounted', mounted: 'ranged', ranged: 'melee' });

// Flags: 'aoe' (Battlemage), 'luckBend' (Archmage), 'summonsGolem' (Summoner),
// 'summoned' (Golem: never produced directly). Siege/structure behaviour comes
// from `class`. `attackMs` defaults to TUNING.attackMs.
function unit(id, name, race, cls, hp, atk, supply, minerals, move, range, flags = []) {
  return Object.freeze({
    id,
    name,
    race,
    class: cls,
    hp,
    atk,
    supply,
    minerals,
    move,
    range,
    attackMs: TUNING.attackMs,
    basic: minerals === 0,
    producible: !flags.includes('summoned'),
    flags: Object.freeze(flags),
  });
}

const UNIT_TYPES = Object.freeze({
  // Workers (same stats, race flavour name)
  laborer: unit('laborer', 'Laborer', 'forge', 'worker', 5, 1, 3, 0, 1, 1),
  peon: unit('peon', 'Peon', 'horde', 'worker', 5, 1, 3, 0, 1, 1),
  acolyte: unit('acolyte', 'Acolyte', 'arcane', 'worker', 5, 1, 3, 0, 1, 1),
  // Forge
  militiaman: unit('militiaman', 'Militiaman', 'forge', 'melee', 11, 4, 3, 0, 1, 1),
  crossbow: unit('crossbow', 'Crossbow', 'forge', 'ranged', 7, 5, 4, 0, 1, 2),
  outrider: unit('outrider', 'Outrider', 'forge', 'mounted', 8, 4, 5, 2, 2, 1),
  bastion: unit('bastion', 'Bastion', 'forge', 'structure', 20, 3, 6, 3, 0, 0),
  ballista: unit('ballista', 'Ballista', 'forge', 'siege', 8, 4, 6, 4, 1, 2),
  // Horde
  warrior: unit('warrior', 'Warrior', 'horde', 'melee', 11, 5, 3, 0, 1, 1),
  skirmisher: unit('skirmisher', 'Skirmisher', 'horde', 'ranged', 7, 5, 4, 0, 1, 2),
  raider: unit('raider', 'Raider', 'horde', 'mounted', 9, 4, 5, 2, 3, 1),
  berserker: unit('berserker', 'Berserker', 'horde', 'melee', 6, 9, 5, 2, 1, 1),
  warchief: unit('warchief', 'Warchief', 'horde', 'melee', 16, 7, 8, 5, 1, 1),
  // Arcane
  apprentice: unit('apprentice', 'Apprentice', 'arcane', 'caster', 6, 4, 3, 0, 1, 2),
  mysticArcher: unit('mysticArcher', 'Mystic Archer', 'arcane', 'ranged', 6, 5, 4, 0, 1, 2),
  battlemage: unit('battlemage', 'Battlemage', 'arcane', 'caster', 8, 6, 6, 3, 1, 1, ['aoe']),
  summoner: unit('summoner', 'Summoner', 'arcane', 'caster', 7, 3, 6, 4, 1, 2, ['summonsGolem']),
  archmage: unit('archmage', 'Archmage', 'arcane', 'caster', 10, 7, 9, 6, 1, 2, ['luckBend']),
  golem: unit('golem', 'Golem', 'arcane', 'structure', 18, 5, 0, 0, 0, 1, ['summoned']),
});

/** Unit type ids a player of `race` may produce (summoned units excluded). */
function producibleTypes(race) {
  return Object.values(UNIT_TYPES)
    .filter((u) => u.race === race && u.producible)
    .map((u) => u.id);
}

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

const TERRAIN_TYPES = Object.freeze({
  plains: Object.freeze({ id: 'plains', passable: true, defense: 1.0, moveCost: 1 }),
  forest: Object.freeze({ id: 'forest', passable: true, defense: 1.25, moveCost: 2 }),
  hills: Object.freeze({ id: 'hills', passable: true, defense: 1.45, moveCost: 2 }),
  water: Object.freeze({ id: 'water', passable: false, defense: null, moveCost: null }),
  rock: Object.freeze({ id: 'rock', passable: false, defense: null, moveCost: null }),
});

// ---------------------------------------------------------------------------
// Facilities & towers (all 💎 Minerals; Forge pays forgeStructureDiscount less)
// ---------------------------------------------------------------------------

const FACILITIES = Object.freeze({
  refinery: Object.freeze({ id: 'refinery', name: 'Refinery', minerals: 5, hp: 15, buildMs: 8000, needsVein: true }),
  barracks: Object.freeze({ id: 'barracks', name: 'Forward Barracks', minerals: 7, hp: 20, buildMs: 10000, spawnPoint: true }),
  workshop: Object.freeze({ id: 'workshop', name: 'Workshop', minerals: 7, hp: 15, buildMs: 10000, buildsWeapons: true }),
  tower: Object.freeze({
    id: 'tower', name: 'Tower', minerals: 4, hp: 18, buildMs: 6000, atk: 3, range: 1, attackMs: TUNING.attackMs,
  }),
});

// Facilities and towers stand on the field as `structure` units (spec "Server state":
// facilities are mirrored as structure units for combat). Their unit-like stats:
// no race, can't move, and only the Tower attacks.
const FACILITY_UNITS = Object.freeze(Object.fromEntries(Object.values(FACILITIES).map((f) => [f.id, Object.freeze({
  id: f.id,
  name: f.name,
  race: null,
  class: 'structure',
  hp: f.hp,
  atk: f.atk || 0,
  supply: 0,
  minerals: f.minerals,
  move: 0,
  range: f.range || 0,
  attackMs: f.attackMs || TUNING.attackMs,
  basic: false,
  producible: false,
  flags: Object.freeze(['facility']),
})])));

/** Stats of anything that stands on the field: a unit type or a facility/tower. */
function unitStats(type) {
  return UNIT_TYPES[type] || FACILITY_UNITS[type];
}

/** 💎 a player of `race` pays for a facility or tower (Forge pays forgeStructureDiscount less). */
function facilityCost(race, facility) {
  const f = FACILITIES[facility];
  const discount = race === 'forge' ? TUNING.forgeStructureDiscount : 0;
  return Math.max(0, f.minerals - discount);
}

// ---------------------------------------------------------------------------
// Special weapons, battlefield events, team phrases (closed menus)
// ---------------------------------------------------------------------------

// `target` says what the tapped tile must be (enforced in Step 10).
const WEAPON_EFFECTS = Object.freeze({
  artillery: Object.freeze({ id: 'artillery', name: 'Artillery', target: 'anyTile' }),
  emp: Object.freeze({ id: 'emp', name: 'EMP', target: 'enemyStructure' }),
  airdrop: Object.freeze({ id: 'airdrop', name: 'Airdrop', target: 'friendlyVisiblePassable' }),
  bombard: Object.freeze({ id: 'bombard', name: 'Bombard', target: 'enemyBase' }),
  aegis: Object.freeze({ id: 'aegis', name: 'Aegis', target: 'ownBase' }),
});

// `durationMs` 0 = instant (or no effect). `title`/`text` are the generic
// fallback flavor used until (or instead of) the AI flavor.
const EVENT_EFFECTS = Object.freeze({
  supplyDrop: Object.freeze({ id: 'supplyDrop', durationMs: 0, title: 'Supply Drop', text: 'Every commander receives fresh Supply.' }),
  mineralRush: Object.freeze({ id: 'mineralRush', durationMs: WF_EVENT_MS, title: 'Mineral Rush', text: 'Every vein yields double while it lasts.' }),
  sandstorm: Object.freeze({ id: 'sandstorm', durationMs: WF_EVENT_MS, title: 'Sandstorm', text: 'Blinding winds make every blow a gamble.' }),
  reinforcements: Object.freeze({ id: 'reinforcements', durationMs: 0, title: 'Reinforcements', text: 'A fresh Worker arrives at each base.' }),
  calm: Object.freeze({ id: 'calm', durationMs: 0, title: 'Calm', text: 'An uneasy quiet settles over the field.' }),
});

// Preset phrases for the private team channel (ids match the mockup's buttons).
const TEAM_PHRASES = Object.freeze({
  push: 'Push!',
  defend: 'Defend base',
  needResources: 'Need resources',
  hitBase: 'Hit their base',
});

// ---------------------------------------------------------------------------
// Host options
// ---------------------------------------------------------------------------

const MAP_SIZES = Object.freeze({
  small: Object.freeze({ id: 'small', label: 'Small', width: 12, height: 8 }),
  medium: Object.freeze({ id: 'medium', label: 'Medium', width: 16, height: 11 }),
  large: Object.freeze({ id: 'large', label: 'Large', width: 20, height: 13 }),
});
const DEFAULT_MAP_SIZE = 'medium';

const MATCH_LENGTHS = Object.freeze({
  short: Object.freeze({ id: 'short', label: '8 min', ms: 8 * 60000 }),
  standard: Object.freeze({ id: 'standard', label: '12 min', ms: WF_MATCH_CAP_MS }),
  long: Object.freeze({ id: 'long', label: '16 min', ms: 16 * 60000 }),
});
const DEFAULT_MATCH_LENGTH = 'standard';

// ---------------------------------------------------------------------------
// Rock-paper-scissors
// ---------------------------------------------------------------------------

function classOf(classOrType) {
  if (UNIT_TYPES[classOrType]) return UNIT_TYPES[classOrType].class;
  return classOrType;
}

/**
 * Attack multiplier for an attacker hitting a defender, by combat class (or unit
 * type id). ×1.5 when the attacker's class beats the defender's, ×0.67 when it's
 * beaten, ×1 otherwise (same class, or either side outside the triangle).
 */
function rpsMultiplier(attacker, defender) {
  const a = classOf(attacker);
  const d = classOf(defender);
  if (!RPS_BEATS[a] || !RPS_BEATS[d] || a === d) return 1;
  if (RPS_BEATS[a] === d) return TUNING.rpsCounter;
  return TUNING.rpsCountered;
}

// ---------------------------------------------------------------------------
// Grid helpers (tile ids are row-major: id = y * width + x)
// ---------------------------------------------------------------------------

function tileId(x, y, width) {
  return y * width + x;
}

function tileXY(id, width) {
  return { x: id % width, y: Math.floor(id / width) };
}

/** Manhattan distance between two tile ids on a grid of `width`. */
function manhattan(a, b, width) {
  const p = tileXY(a, width);
  const q = tileXY(b, width);
  return Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
}

/** Orthogonal neighbours of a tile, in fixed order N, E, S, W (deterministic). */
function neighbors(id, width, height) {
  const { x, y } = tileXY(id, width);
  const out = [];
  if (y > 0) out.push(id - width);
  if (x < width - 1) out.push(id + 1);
  if (y < height - 1) out.push(id + width);
  if (x > 0) out.push(id - 1);
  return out;
}

function terrainAt(map, id) {
  const t = map.tiles[id];
  return typeof t === 'string' ? t : t && t.terrain;
}

function isPassable(map, id) {
  if (!Number.isInteger(id) || id < 0 || id >= map.width * map.height) return false;
  const t = TERRAIN_TYPES[terrainAt(map, id)];
  return Boolean(t && t.passable);
}

/** Every passable tile reachable from `from` (Set of ids). */
function floodFill(map, from) {
  const seen = new Set();
  if (!isPassable(map, from)) return seen;
  seen.add(from);
  const queue = [from];
  for (let i = 0; i < queue.length; i++) {
    for (const n of neighbors(queue[i], map.width, map.height)) {
      if (!seen.has(n) && isPassable(map, n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return seen;
}

/**
 * Shortest path over passable tiles (unweighted BFS, N/E/S/W tie-break).
 * Returns the tile ids to walk, excluding `from` and ending at `to`; [] when
 * already there, when `to` is impassable, or when it can't be reached.
 */
function bfsPath(map, from, to) {
  if (from === to || !isPassable(map, to)) return [];
  const prev = new Map([[from, -1]]);
  const queue = [from];
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    for (const n of neighbors(cur, map.width, map.height)) {
      if (prev.has(n) || !isPassable(map, n)) continue;
      prev.set(n, cur);
      if (n === to) {
        const path = [];
        for (let t = to; t !== from; t = prev.get(t)) path.push(t);
        return path.reverse();
      }
      queue.push(n);
    }
  }
  return [];
}

/** Time cost of walking onto a tile (its terrain's moveCost; plains 1, forest/hills 2). */
function moveCostAt(map, id) {
  return TERRAIN_TYPES[terrainAt(map, id)].moveCost;
}

/**
 * Fastest path over passable tiles: A* weighted by the move cost of every tile
 * entered (so a unit walks around a hill when that's quicker than climbing it),
 * with a Manhattan heuristic (admissible: no tile costs less than 1). Among
 * equally fast paths the choice is deterministic (lowest f, then lowest h, then
 * N/E/S/W discovery order). Same contract as bfsPath: the tile ids to walk,
 * excluding `from`, ending at `to`; [] when already there or unreachable.
 */
function findPath(map, from, to) {
  if (from === to || !isPassable(map, to) || !isPassable(map, from)) return [];
  const { width, height } = map;
  const h = (id) => manhattan(id, to, width);
  const g = new Map([[from, 0]]);
  const prev = new Map([[from, -1]]);
  const closed = new Set();
  // Binary min-heap of [f, h, seq, id].
  const heap = [];
  let seq = 0;
  const less = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const push = (item) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (less(heap[i], heap[p]) >= 0) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && less(heap[l], heap[m]) < 0) m = l;
        if (r < heap.length && less(heap[r], heap[m]) < 0) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    }
    return top;
  };
  push([h(from), h(from), seq++, from]);
  while (heap.length) {
    const cur = pop()[3];
    if (closed.has(cur)) continue;
    if (cur === to) {
      const path = [];
      for (let t = to; t !== from; t = prev.get(t)) path.push(t);
      return path.reverse();
    }
    closed.add(cur);
    const gc = g.get(cur);
    for (const n of neighbors(cur, width, height)) {
      if (closed.has(n) || !isPassable(map, n)) continue;
      const gn = gc + moveCostAt(map, n);
      if (g.has(n) && g.get(n) <= gn) continue;
      g.set(n, gn);
      prev.set(n, cur);
      const hn = h(n);
      push([gn + hn, hn, seq++, n]);
    }
  }
  return [];
}

/** Total move cost of walking `path` (0 for []). */
function pathCost(map, path) {
  let c = 0;
  for (const id of path) c += moveCostAt(map, id);
  return c;
}

// ---------------------------------------------------------------------------
// Map validation (spec "Map generation" step 2). The model's map is only a
// suggestion: anything off throws, and the caller falls back.
// ---------------------------------------------------------------------------

const MAX_WEAPON_TOKENS = 8;
const VEIN_FAIRNESS_TOLERANCE = 2;

function resolveSize(size) {
  if (typeof size === 'string') {
    if (!MAP_SIZES[size]) throw new Error(`unknown map size "${size}"`);
    return MAP_SIZES[size];
  }
  if (!size || !Number.isInteger(size.width) || !Number.isInteger(size.height)) {
    throw new Error('map size needs integer width and height');
  }
  return size;
}

function readPoint(p, what, width, height) {
  if (!p || !Number.isInteger(p.x) || !Number.isInteger(p.y)) {
    throw new Error(`${what} needs integer x and y`);
  }
  if (p.x < 0 || p.y < 0 || p.x >= width || p.y >= height) {
    throw new Error(`${what} at (${p.x},${p.y}) is off the map`);
  }
  return { x: p.x, y: p.y, tileId: tileId(p.x, p.y, width) };
}

/**
 * Validates a raw map object (OpenAI JSON or the fallback) against `size`
 * (a MAP_SIZES key or { width, height }) and returns the normalized map:
 * tiles become terrain strings, every feature gains a tileId, supply sources
 * gain the team of the base they serve. Throws with a specific message.
 */
function validateMap(raw, size) {
  const { width, height } = resolveSize(size);
  if (!raw || typeof raw !== 'object') throw new Error('map is not an object');
  if (raw.width !== width || raw.height !== height) {
    throw new Error(`map is ${raw.width}x${raw.height}, expected ${width}x${height}`);
  }
  if (!Array.isArray(raw.tiles) || raw.tiles.length !== width * height) {
    throw new Error(`map needs exactly ${width * height} tiles`);
  }
  const tiles = raw.tiles.map((t, i) => {
    const terrain = typeof t === 'string' ? t : t && t.terrain;
    if (!TERRAIN_TYPES[terrain]) throw new Error(`tile ${i} has unknown terrain "${terrain}"`);
    return terrain;
  });
  const map = { width, height, tiles };
  const used = new Set();
  const claim = (pt, what) => {
    if (!isPassable(map, pt.tileId)) throw new Error(`${what} at (${pt.x},${pt.y}) is on impassable terrain`);
    if (used.has(pt.tileId)) throw new Error(`${what} at (${pt.x},${pt.y}) shares a tile with another feature`);
    used.add(pt.tileId);
    return pt;
  };

  // Bases: exactly one per team, opposite halves, not adjacent.
  if (!Array.isArray(raw.bases) || raw.bases.length !== 2) throw new Error('map needs exactly two bases');
  const bases = {};
  for (const b of raw.bases) {
    const team = b && b.team;
    if (team !== 'red' && team !== 'blue') throw new Error(`base has unknown team "${team}"`);
    if (bases[team]) throw new Error(`map has two ${team} bases`);
    bases[team] = { team, ...claim(readPoint(b, `${team} base`, width, height), `${team} base`) };
  }
  if (!bases.red || !bases.blue) throw new Error('map needs one red and one blue base');
  const half = width / 2;
  const side = (b) => {
    if (width % 2 === 1 && b.x === (width - 1) / 2) return 'middle';
    return b.x < half ? 'left' : 'right';
  };
  const rs = side(bases.red);
  const bs = side(bases.blue);
  if (rs === 'middle' || bs === 'middle' || rs === bs) throw new Error('bases must sit on opposite halves of the map');
  if (manhattan(bases.red.tileId, bases.blue.tileId, width) <= 1) throw new Error('bases must not be adjacent');

  // Supply sources: exactly one orthogonally adjacent to each base.
  if (!Array.isArray(raw.supplySources) || raw.supplySources.length !== 2) {
    throw new Error('map needs exactly two supply sources');
  }
  const supplySources = raw.supplySources.map((s) => claim(readPoint(s, 'supply source', width, height), 'supply source'));
  for (const team of ['red', 'blue']) {
    const near = supplySources.filter((s) => manhattan(s.tileId, bases[team].tileId, width) === 1);
    if (near.length !== 1) throw new Error(`the ${team} base needs exactly one adjacent supply source`);
    if (near[0].team) throw new Error('one supply source cannot serve both bases');
    near[0].team = team;
  }

  // Veins: 1-2, passable, richness 1-3, roughly mirror-fair.
  if (!Array.isArray(raw.veins) || raw.veins.length < 1 || raw.veins.length > 2) {
    throw new Error('map needs one or two mineral veins');
  }
  const veins = raw.veins.map((v) => {
    const pt = claim(readPoint(v, 'vein', width, height), 'vein');
    if (![1, 2, 3].includes(v.richness)) throw new Error(`vein at (${pt.x},${pt.y}) has bad richness "${v.richness}"`);
    return { ...pt, richness: v.richness, contested: v.contested !== false };
  });
  const veinReach = (team) => {
    let total = 0;
    let weight = 0;
    for (const v of veins) {
      total += v.richness * manhattan(v.tileId, bases[team].tileId, width);
      weight += v.richness;
    }
    return total / weight;
  };
  if (Math.abs(veinReach('red') - veinReach('blue')) > VEIN_FAIRNESS_TOLERANCE) {
    throw new Error('veins are not mirror-fair between the two bases');
  }

  // Weapon tokens: known ids, passable, distinct tiles.
  const rawWeapons = raw.weapons == null ? [] : raw.weapons;
  if (!Array.isArray(rawWeapons) || rawWeapons.length > MAX_WEAPON_TOKENS) {
    throw new Error(`map may have at most ${MAX_WEAPON_TOKENS} weapon tokens`);
  }
  const weapons = rawWeapons.map((w) => {
    const pt = claim(readPoint(w, 'weapon token', width, height), 'weapon token');
    if (!WEAPON_EFFECTS[w.weaponId]) throw new Error(`weapon token at (${pt.x},${pt.y}) has unknown id "${w.weaponId}"`);
    return { ...pt, weaponId: w.weaponId };
  });

  // Lighthouses (D15): 2-4; exactly one home lighthouse on each base's half within
  // LIGHTHOUSE_HOME_RANGE of it (owned by that team at the start); any extras are
  // fair (about as far from both bases) or a mirrored pair, and start neutral.
  const rawLighthouses = raw.lighthouses;
  if (!Array.isArray(rawLighthouses) || rawLighthouses.length < 2 || rawLighthouses.length > MAX_LIGHTHOUSES) {
    throw new Error(`map needs 2 to ${MAX_LIGHTHOUSES} lighthouses`);
  }
  const lighthouses = rawLighthouses.map((l) => ({ ...claim(readPoint(l, 'lighthouse', width, height), 'lighthouse'), team: null }));
  const halfOf = (pt) => side(pt);
  for (const team of ['red', 'blue']) {
    const home = lighthouses.filter((l) => halfOf(l) === side(bases[team])
      && manhattan(l.tileId, bases[team].tileId, width) <= LIGHTHOUSE_HOME_RANGE);
    if (home.length === 0) throw new Error(`the ${team} base needs a lighthouse within ${LIGHTHOUSE_HOME_RANGE} tiles on its half`);
    if (home.length > 1) throw new Error(`the ${team} base has more than one lighthouse within ${LIGHTHOUSE_HOME_RANGE} tiles`);
    home[0].team = team;
  }
  const extras = lighthouses.filter((l) => !l.team);
  const fair = (l) => Math.abs(manhattan(l.tileId, bases.red.tileId, width) - manhattan(l.tileId, bases.blue.tileId, width)) <= LIGHTHOUSE_FAIRNESS;
  const mirrored = (a, b) => a.x === width - 1 - b.x && (a.y === b.y || a.y === height - 1 - b.y);
  const pairOk = extras.length === 2 && mirrored(extras[0], extras[1]);
  for (const l of extras) {
    if (!fair(l) && !pairOk) throw new Error(`lighthouse at (${l.x},${l.y}) is not fair to both bases`);
  }

  // Connectivity: the red base reaches the blue base and every feature.
  const reach = floodFill(map, bases.red.tileId);
  if (!reach.has(bases.blue.tileId)) throw new Error('the two bases are not connected');
  for (const [what, list] of [['supply source', supplySources], ['vein', veins], ['weapon token', weapons], ['lighthouse', lighthouses]]) {
    for (const f of list) {
      if (!reach.has(f.tileId)) throw new Error(`${what} at (${f.x},${f.y}) is unreachable`);
    }
  }

  // Chokepoints are hints only: keep the valid ones, drop the rest quietly.
  const chokepoints = (Array.isArray(raw.chokepoints) ? raw.chokepoints : [])
    .filter((c) => c && Number.isInteger(c.x) && Number.isInteger(c.y)
      && c.x >= 0 && c.y >= 0 && c.x < width && c.y < height)
    .map((c) => ({ x: c.x, y: c.y, tileId: tileId(c.x, c.y, width) }))
    .filter((c) => isPassable(map, c.tileId));

  const theme = typeof raw.theme === 'string' && raw.theme.trim() ? raw.theme.trim().slice(0, 40) : 'Unnamed Battlefield';
  const lore = typeof raw.lore === 'string' ? raw.lore.trim().slice(0, 300) : '';

  return {
    theme,
    lore,
    width,
    height,
    tiles,
    bases: [bases.red, bases.blue],
    supplySources,
    veins,
    weapons,
    lighthouses,
    chokepoints,
  };
}

// ---------------------------------------------------------------------------
// Procedural fallback map (spec "Map generation" step 3): mirror-symmetric
// across the vertical axis, retried until it validates, with a plain-plains
// last resort that always passes.
// ---------------------------------------------------------------------------

const FALLBACK_THEMES = Object.freeze([
  ['Ashen Divide', 'Two warbands meet across a scorched valley, each eyeing the ore at its heart.'],
  ['Frostmarch Pass', 'Snow hides the old roads; whoever holds the middle holds the winter.'],
  ['Sunken Fields', 'Floodwater carved these meadows into lanes. The crystals glow brightest in the centre.'],
  ['Iron Hollow', 'A quarry fought over for generations, its veins still rich and unclaimed.'],
  ['Emberwood', 'Smouldering forests ring a clearing where the minerals surface.'],
  ['Highstone Ridge', 'Wind-cut hills split the field. The high ground decides everything.'],
]);
const FALLBACK_ATTEMPTS = 50;
const WEAPON_IDS = Object.freeze(Object.keys(WEAPON_EFFECTS));

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

function randInt(rng, lo, hi) {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function randomTerrain(rng) {
  const r = rng();
  if (r < 0.6) return 'plains';
  if (r < 0.75) return 'forest';
  if (r < 0.86) return 'hills';
  if (r < 0.95) return 'water';
  return 'rock';
}

/** One candidate fallback map (raw shape), or the all-plains map when `plain`. */
function fallbackCandidate(width, height, rng, plain) {
  const halfW = Math.ceil(width / 2);
  const mirrorX = (x) => width - 1 - x;
  const grid = Array.from({ length: height }, () => new Array(width).fill('plains'));
  if (!plain) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < halfW; x++) grid[y][x] = randomTerrain(rng);
    }
  }
  const features = [];
  const setPlain = (x, y) => {
    grid[y][x] = 'plains';
    grid[y][mirrorX(x)] = 'plains';
  };
  const free = (x, y) => !features.some((f) => (f.x === x || f.x === mirrorX(x)) && f.y === y);

  const by = randInt(rng, 2, height - 3);
  const bx = 1;
  setPlain(bx, by);
  for (const [dx, dy] of [[0, -1], [1, 0], [0, 1]]) setPlain(bx + dx, by + dy);
  features.push({ x: bx, y: by });

  const [sx, sy] = pick(rng, [[bx + 1, by], [bx, by - 1], [bx, by + 1]]);
  setPlain(sx, sy);
  features.push({ x: sx, y: sy });

  // Veins: contested centre. Two mirrored, or one just off the centre line.
  const veins = [];
  const centreLeft = Math.floor((width - 1) / 2);
  const richness = randInt(rng, 2, 3);
  if (rng() < 0.5) {
    const vx = centreLeft - randInt(rng, 0, 1);
    const vy = randInt(rng, 1, height - 2);
    setPlain(vx, vy);
    features.push({ x: vx, y: vy });
    veins.push({ x: vx, y: vy, richness, contested: true });
    if (mirrorX(vx) !== vx) veins.push({ x: mirrorX(vx), y: vy, richness, contested: true });
  } else {
    const vx = pick(rng, [centreLeft, mirrorX(centreLeft)]);
    const vy = randInt(rng, 1, height - 2);
    setPlain(vx, vy);
    features.push({ x: vx, y: vy });
    veins.push({ x: vx, y: vy, richness, contested: true });
  }

  // Lighthouses: one near each base (mirrored), plus a mirrored contested pair toward
  // the centre, on hills when there are any there, else wherever fits.
  const lighthouses = [];
  const near = [];
  for (let dy = -LIGHTHOUSE_HOME_RANGE; dy <= LIGHTHOUSE_HOME_RANGE; dy++) {
    for (let dx = -LIGHTHOUSE_HOME_RANGE; dx <= LIGHTHOUSE_HOME_RANGE; dx++) {
      const x = bx + dx;
      const y = by + dy;
      const d = Math.abs(dx) + Math.abs(dy);
      // Not in the top row: the tall tower would be cut off by the top edge of the camera.
      if (d < 2 || d > 3 || x < 0 || y < 1 || y >= height || x >= halfW || mirrorX(x) === x) continue;
      if (free(x, y)) near.push([x, y]);
    }
  }
  if (near.length) {
    const [lx, ly] = pick(rng, near);
    setPlain(lx, ly);
    features.push({ x: lx, y: ly });
    lighthouses.push({ x: lx, y: ly }, { x: mirrorX(lx), y: ly });
  }
  const contested = [];
  for (let y = 1; y < height; y++) {
    for (let x = bx + 1; x < halfW; x++) {
      if (mirrorX(x) === x || !free(x, y)) continue;
      if (Math.abs(x - bx) + Math.abs(y - by) <= LIGHTHOUSE_HOME_RANGE) continue;
      contested.push([x, y]);
    }
  }
  if (contested.length) {
    // Near the centre, but the two of a pair at least 3 tiles apart (never side by side).
    const centred = contested.filter(([x]) => x >= centreLeft - 3 && mirrorX(x) - x >= 3);
    const apart = contested.filter(([x]) => mirrorX(x) - x >= 3);
    const pool = centred.length ? centred : apart.length ? apart : contested;
    const hills = pool.filter(([x, y]) => grid[y][x] === 'hills');
    const [cx, cy] = pick(rng, hills.length ? hills : pool);
    if (grid[cy][cx] !== 'hills') setPlain(cx, cy);
    features.push({ x: cx, y: cy });
    lighthouses.push({ x: cx, y: cy }, { x: mirrorX(cx), y: cy });
  }

  // Weapon tokens: 1-2 mirrored pairs between the base and the centre.
  const weapons = [];
  const pairs = randInt(rng, 1, 2);
  for (let i = 0, tries = 0; i < pairs && tries < 20; tries++) {
    const wx = randInt(rng, bx + 2, Math.max(bx + 2, centreLeft - 1));
    const wy = randInt(rng, 0, height - 1);
    if (!free(wx, wy) || mirrorX(wx) === wx) continue;
    setPlain(wx, wy);
    features.push({ x: wx, y: wy });
    const weaponId = pick(rng, WEAPON_IDS);
    weapons.push({ x: wx, y: wy, weaponId }, { x: mirrorX(wx), y: wy, weaponId });
    i++;
  }

  // Reflect the left half onto the right.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < halfW; x++) grid[y][mirrorX(x)] = grid[y][x];
  }
  const [theme, lore] = pick(rng, FALLBACK_THEMES);
  return {
    theme,
    lore,
    width,
    height,
    tiles: grid.flat().map((terrain) => ({ terrain })),
    bases: [{ team: 'red', x: bx, y: by }, { team: 'blue', x: mirrorX(bx), y: by }],
    supplySources: [{ x: sx, y: sy }, { x: mirrorX(sx), y: sy }],
    veins,
    weapons,
    lighthouses,
    chokepoints: [],
  };
}

/** A procedural, always-valid map of `size` (MAP_SIZES key or {width,height}). */
function buildFallbackMap(size, rng) {
  const { width, height } = resolveSize(size);
  for (let i = 0; i < FALLBACK_ATTEMPTS; i++) {
    try {
      return validateMap(fallbackCandidate(width, height, rng, false), { width, height });
    } catch (_) {
      // try again
    }
  }
  return validateMap(fallbackCandidate(width, height, rng, true), { width, height });
}

// ---------------------------------------------------------------------------
// Battle state (spec "Map generation" step 4)
// ---------------------------------------------------------------------------

/** A fresh unit of `type` owned by `owner`, standing on `tileId`. */
function makeUnit(id, type, owner, tileId) {
  const t = unitStats(type);
  return {
    id,
    type,
    class: t.class,
    tileId,
    hp: t.hp,
    owner,
    carrying: 0,
    path: [],
    stepStartedAt: 0,
    stepEndsAt: 0,
    atkReadyAt: 0,
    haul: null,
    holding: false,
    revealedUntil: { red: 0, blue: 0 },
  };
}

/**
 * The full live-match state for a validated `map`. `roster` is
 * [{ name, team: 'red'|'blue', race }]; opts = { seed, now, matchCapMs }.
 * Returns the fields the module stores under room.state.warfront.
 */
function createBattleState(map, roster, { seed, now, matchCapMs = WF_MATCH_CAP_MS }) {
  let nextUnitId = 1;
  const baseOf = {};
  for (const b of map.bases) baseOf[b.team] = b.tileId;
  const bases = {
    red: { hp: TUNING.baseHp, maxHp: TUNING.baseHp, tileId: baseOf.red, shieldUntil: 0, atkReadyAt: 0 },
    blue: { hp: TUNING.baseHp, maxHp: TUNING.baseHp, tileId: baseOf.blue, shieldUntil: 0, atkReadyAt: 0 },
  };
  const armies = {};
  for (const { name, team, race } of roster) {
    if (!RACES[race]) throw new Error(`unknown race "${race}" for ${name}`);
    if (team !== 'red' && team !== 'blue') throw new Error(`unknown team "${team}" for ${name}`);
    const units = [];
    for (let i = 0; i < TUNING.startWorkers; i++) {
      units.push(makeUnit(nextUnitId++, RACES[race].workerType, name, baseOf[team]));
    }
    armies[name] = {
      team,
      race,
      supply: TUNING.startSupply,
      minerals: TUNING.startMinerals,
      arsenal: [],
      facilities: [],
      queues: {},
      workshop: [],
      stats: { kills: 0, lost: 0, baseDmg: 0 },
      units,
    };
  }
  return {
    seed: seed >>> 0,
    tick: 0,
    nextUnitId,
    winner: null,
    map,
    bases,
    armies,
    pickups: {
      mineralDrops: {},
      weapons: map.weapons.map((w) => ({ tileId: w.tileId, weaponId: w.weaponId })),
    },
    // Home lighthouses start with their base's team, contested ones neutral (D15).
    lighthouses: (map.lighthouses || []).map((l) => ({ tileId: l.tileId, team: l.team || null })),
    clock: { startedAt: now, matchEndsAt: now + matchCapMs, lastTickAt: now },
    event: null,
    nextEventAt: now + WF_EVENT_MS,
  };
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

function teamOf(state, name) {
  const a = state.armies[name];
  return a ? a.team : null;
}

/** Every unit on the field, with its army's team: [{ unit, owner, team }]. */
function allUnits(state) {
  const out = [];
  for (const [owner, a] of Object.entries(state.armies)) {
    for (const u of a.units) out.push({ unit: u, owner, team: a.team });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Movement (spec "Movement (grid-step, real time)")
// ---------------------------------------------------------------------------

/** Move 1 / 2 / 3 walk at ×1 / ×1.5 / ×2 the base speed (D16). */
function speedFactor(move) {
  return (1 + move) / 2;
}

/** Time to walk onto `toTileId`: WF_STEP_MS_BASE ÷ the speed factor × the entered tile's move cost. */
function stepMs(map, unitType, toTileId) {
  const move = unitStats(unitType).move;
  const cost = TERRAIN_TYPES[terrainAt(map, toTileId)].moveCost;
  return Math.round((WF_STEP_MS_BASE / speedFactor(move)) * cost);
}

const MAX_UNITS_PER_COMMAND = WF_MAX_UNITS_PER_PLAYER;

/**
 * Sends one unit toward `to`. A unit already mid-step finishes that step first
 * (its next tile is kept and the new path continues from there), so a re-issued
 * order never snaps a unit backwards. Returns false when there's nowhere to go.
 */
function orderMove(state, unit, to, now) {
  const { map } = state;
  // Mid-step (or a finished step the next sim step hasn't applied yet): keep it.
  if (unit.path.length) {
    const next = unit.path[0];
    const rest = next === to ? [] : findPath(map, next, to);
    if (next !== to && !rest.length) return false;
    unit.path = [next, ...rest];
  } else {
    const path = findPath(map, unit.tileId, to);
    if (!path.length) return false;
    unit.path = path;
    unit.stepStartedAt = now;
    unit.stepEndsAt = now + stepMs(map, unit.type, path[0]);
  }
  unit.haul = null;
  unit.holding = false;
  return true;
}

/**
 * Applies one player command instantly (spec "Commands"). Pure apart from
 * mutating `state`; returns { ok: true } or { ok: false, error }. An invalid
 * command changes nothing.
 */
function applyCommand(state, name, cmd, now) {
  const army = state.armies[name];
  if (!army) return { ok: false, error: 'You have no army in this battle' };
  if (!cmd || typeof cmd !== 'object') return { ok: false, error: 'Invalid command' };
  if (cmd.kind === 'move') {
    const { unitIds, toTileId } = cmd;
    if (!Array.isArray(unitIds) || !unitIds.length || unitIds.length > MAX_UNITS_PER_COMMAND) {
      return { ok: false, error: 'Pick some units first' };
    }
    if (!isPassable(state.map, toTileId)) return { ok: false, error: "Units can't go there" };
    const wanted = new Set(unitIds);
    const units = army.units.filter((u) => wanted.has(u.id) && unitStats(u.type).move > 0);
    if (!units.length) return { ok: false, error: 'Those units are not yours to move' };
    let moved = 0;
    for (const u of units) if (orderMove(state, u, toTileId, now)) moved++;
    if (!moved) return { ok: false, error: 'Already there' };
    return { ok: true, moved };
  }
  if (cmd.kind === 'produce') return orderProduce(state, name, army, cmd, now);
  if (cmd.kind === 'haul') return orderHaul(state, army, cmd, now);
  if (cmd.kind === 'build') return orderBuild(state, name, army, cmd, now);
  if (cmd.kind === 'craft') return orderCraft(state, army, cmd, now);
  if (cmd.kind === 'hold') {
    const { unitIds } = cmd;
    if (!Array.isArray(unitIds) || !unitIds.length || unitIds.length > MAX_UNITS_PER_COMMAND) {
      return { ok: false, error: 'Pick some units first' };
    }
    const wanted = new Set(unitIds);
    const units = army.units.filter((u) => wanted.has(u.id) && unitStats(u.type).move > 0);
    if (!units.length) return { ok: false, error: 'Those units are not yours to command' };
    for (const u of units) {
      // Stop where it stands: a step in progress finishes (no snapping back), then nothing.
      if (u.path.length > 1) u.path = [u.path[0]];
      u.haul = null;
      u.holding = true;
    }
    return { ok: true, held: units.length };
  }
  return { ok: false, error: 'Unknown command' };
}

// ---------------------------------------------------------------------------
// Economy: production and hauling (spec "Commands", "Economy")
// ---------------------------------------------------------------------------

/** Build/spawn time of a unit type: buildMsPerCost × its 🔩 Supply cost. */
function buildMs(unitType) {
  return TUNING.buildMsPerCost * UNIT_TYPES[unitType].supply;
}

/** Unit slots a produce order takes: a Summoner brings its Golem along. */
function slotsFor(unitType) {
  return UNIT_TYPES[unitType].flags.includes('summonsGolem') ? 2 : 1;
}

/** Unit slots an army uses toward WF_MAX_UNITS_PER_PLAYER: units on the field plus everything queued (D12). */
function unitSlotsUsed(army) {
  let n = army.units.length;
  for (const q of Object.values(army.queues)) for (const item of q) n += slotsFor(item.unitType);
  return n;
}

/** `army`'s finished facilities of `type` (construction sites don't count). */
function builtFacilities(army, type) {
  return army.units.filter((u) => u.type === type && !u.buildDoneAt && u.hp > 0);
}

/** Tiles where `army` may produce: its base, then every finished Forward Barracks. */
function spawnPoints(state, army) {
  return [state.bases[army.team].tileId, ...builtFacilities(army, 'barracks').map((u) => u.tileId)];
}

/** Tiles where `army`'s haulers may unload: its base, then every finished Refinery. */
function depositTiles(state, army) {
  return [state.bases[army.team].tileId, ...builtFacilities(army, 'refinery').map((u) => u.tileId)];
}

/**
 * Produce (D2, D10, D12): own race, under the unit cap, affordable in 🔩 (and 💎 for
 * advanced units). Pays now; the unit joins the spawn point's sequential queue and
 * appears buildMs later than the one ahead of it.
 */
function orderProduce(state, name, army, cmd, now) {
  const t = UNIT_TYPES[cmd.unitType];
  if (!t || !t.producible) return { ok: false, error: 'Unknown unit' };
  if (t.race !== army.race) return { ok: false, error: `Only ${RACES[t.race].name} can produce that` };
  const points = spawnPoints(state, army);
  const at = cmd.atTileId == null ? points[0] : cmd.atTileId;
  if (!points.includes(at)) return { ok: false, error: 'Units can only be produced at your base or a Forward Barracks' };
  if (unitSlotsUsed(army) + slotsFor(t.id) > WF_MAX_UNITS_PER_PLAYER) {
    return { ok: false, error: `Army is at the ${WF_MAX_UNITS_PER_PLAYER}-unit cap` };
  }
  if (army.supply < t.supply) return { ok: false, error: 'Not enough Supply' };
  if (army.minerals < t.minerals) return { ok: false, error: 'Not enough Minerals' };
  army.supply = round3(army.supply - t.supply);
  army.minerals = round3(army.minerals - t.minerals);
  const queue = army.queues[at] || (army.queues[at] = []);
  const startsAt = queue.length ? Math.max(queue[queue.length - 1].doneAt, now) : now;
  queue.push({ unitType: t.id, doneAt: startsAt + buildMs(t.id) });
  return { ok: true };
}

/**
 * Haul: Workers enter the auto-haul loop on a vein. One already loaded heads
 * straight for a deposit; the rest walk to the vein (a step in progress finishes first).
 */
function orderHaul(state, army, cmd, now) {
  const { workerIds, veinTileId } = cmd;
  if (!Array.isArray(workerIds) || !workerIds.length || workerIds.length > MAX_UNITS_PER_COMMAND) {
    return { ok: false, error: 'Pick some Workers first' };
  }
  if (!state.map.veins.some((v) => v.tileId === veinTileId)) return { ok: false, error: 'Haul from a mineral vein' };
  const wanted = new Set(workerIds);
  const workers = army.units.filter((u) => wanted.has(u.id) && u.class === 'worker');
  if (!workers.length) return { ok: false, error: 'Only Workers can haul' };
  for (const u of workers) {
    if (u.carrying >= TUNING.carryCap) {
      u.haul = { veinTileId, stage: 'toDeposit', luck: 0 };
      headFor(state, army, u, nearestTile(state, u, depositTiles(state, army)), now);
    } else {
      u.haul = { veinTileId, stage: 'toVein', luck: 0 };
      headFor(state, army, u, veinTileId, now);
    }
  }
  return { ok: true, hauling: workers.length };
}

// ---------------------------------------------------------------------------
// Facilities and towers (spec "Facilities", "Towers"; D4, D17)
// ---------------------------------------------------------------------------

/**
 * Why `army` can't build `facility` on `tileId` right now, or null when it can (D4):
 * a passable tile in the team's vision, not a base, with no enemy unit and no
 * structure on it; a Refinery also needs a vein on or beside the tile.
 */
function buildBlocker(state, army, facility, tileId) {
  const { map } = state;
  if (!isPassable(map, tileId)) return "Can't build there";
  if (!visionFor(state, army.team).has(tileId)) return 'Build only where your team can see';
  if (tileId === state.bases.red.tileId || tileId === state.bases.blue.tileId) return "Can't build on a base";
  for (const { unit, team } of allUnits(state)) {
    if (unit.tileId !== tileId || unit.hp <= 0) continue;
    if (unit.class === 'structure') return 'There is already a structure there';
    if (team !== army.team) return 'An enemy is standing there';
  }
  if (FACILITIES[facility].needsVein && !map.veins.some((v) => manhattan(v.tileId, tileId, map.width) <= 1)) {
    return 'A Refinery goes on or next to a mineral vein';
  }
  return null;
}

/**
 * Build (D17): pays the 💎 now and places a construction site, a structure unit
 * that is attackable at once but does nothing until buildDoneAt. Counts toward the
 * unit cap like everything else on the field.
 */
function orderBuild(state, name, army, cmd, now) {
  const f = FACILITIES[cmd.facility];
  if (!f) return { ok: false, error: 'Unknown building' };
  const blocker = buildBlocker(state, army, f.id, cmd.tileId);
  if (blocker) return { ok: false, error: blocker };
  if (unitSlotsUsed(army) + 1 > WF_MAX_UNITS_PER_PLAYER) {
    return { ok: false, error: `Army is at the ${WF_MAX_UNITS_PER_PLAYER}-unit cap` };
  }
  const cost = facilityCost(army.race, f.id);
  if (army.minerals < cost) return { ok: false, error: 'Not enough Minerals' };
  army.minerals = round3(army.minerals - cost);
  const u = makeUnit(state.nextUnitId++, f.id, name, cmd.tileId);
  u.buildDoneAt = now + f.buildMs;
  army.units.push(u);
  army.facilities.push({ id: u.id, type: f.id, tileId: u.tileId });
  return { ok: true, unitId: u.id };
}

/**
 * Craft (D17): with a finished Workshop, pays workshopWeaponCost 💎 now and adds the
 * weapon to the player's sequential Workshop queue (one at a time per player).
 */
function orderCraft(state, army, cmd, now) {
  if (!WEAPON_EFFECTS[cmd.weaponId]) return { ok: false, error: 'Unknown weapon' };
  if (!builtFacilities(army, 'workshop').length) return { ok: false, error: 'Build a Workshop first' };
  if (army.minerals < TUNING.workshopWeaponCost) return { ok: false, error: 'Not enough Minerals' };
  army.minerals = round3(army.minerals - TUNING.workshopWeaponCost);
  const queue = army.workshop;
  const startsAt = queue.length ? Math.max(queue[queue.length - 1].doneAt, now) : now;
  queue.push({ weaponId: cmd.weaponId, doneAt: startsAt + TUNING.workshopWeaponMs });
  return { ok: true };
}

/** Construction sites whose time is up become working structures. */
function stepConstruction(state, now, events) {
  for (const [owner, army] of Object.entries(state.armies)) {
    for (const u of army.units) {
      if (!u.buildDoneAt || u.buildDoneAt > now || u.hp <= 0) continue;
      u.buildDoneAt = 0;
      events.push({ type: 'built', tileId: u.tileId, owner, team: army.team, unitId: u.id, unitType: u.type });
    }
  }
}

/** Finished Workshop weapons join the arsenal, one at a time. */
function stepWorkshop(state, now, events) {
  for (const [owner, army] of Object.entries(state.armies)) {
    const queue = army.workshop;
    if (!queue || !queue.length) continue;
    const shop = builtFacilities(army, 'workshop')[0];
    while (queue.length && queue[0].doneAt <= now) {
      const { weaponId } = queue.shift();
      army.arsenal.push(weaponId);
      events.push({ type: 'crafted', tileId: shop ? shop.tileId : state.bases[army.team].tileId, owner, team: army.team, weaponId });
    }
  }
}

/**
 * A facility just fell (D17): its work in progress is lost, no refund. A Forward
 * Barracks takes its spawn queue with it; the Workshop queue goes with the last Workshop.
 */
function loseFacility(army, u) {
  army.facilities = army.facilities.filter((f) => f.id !== u.id);
  if (u.type === 'barracks') delete army.queues[u.tileId];
  if (u.type === 'workshop' && !builtFacilities(army, 'workshop').some((w) => w.id !== u.id)) army.workshop = [];
}

/** Points a hauler at `to` without dropping its haul loop (orderMove clears it). */
function headFor(state, army, u, to, now) {
  const haul = u.haul;
  if (u.tileId !== to || u.path.length) orderMove(state, u, to, now);
  u.haul = haul;
  u.holding = false;
}

/** Of `tiles`, the one with the quickest walk from where `u` stands (or is stepping to); ties keep list order. */
function nearestTile(state, u, tiles) {
  const from = u.path.length ? u.path[0] : u.tileId;
  let best = tiles[0];
  let bestLen = Infinity;
  for (const t of tiles) {
    const len = t === from ? 0 : pathCost(state.map, findPath(state.map, from, t)) || Infinity;
    if (len < bestLen) {
      best = t;
      bestLen = len;
    }
  }
  return best;
}

const round3 = (n) => Math.round(n * 1000) / 1000;

/** 🔩 Supply per second for one army: trickle + Workers on/beside a friendly supply source (+Forge bonus). */
function supplyRate(state, army) {
  const { width } = state.map;
  const sources = state.map.supplySources.filter((s) => s.team === army.team).map((s) => s.tileId);
  let rate = TUNING.baseTrickleSec;
  if (!sources.length) return rate;
  const perWorker = TUNING.supplyPerWorkerSec + (army.race === 'forge' ? TUNING.forgeWorkerBonusSec : 0);
  for (const u of army.units) {
    if (u.class === 'worker' && sources.some((s) => manhattan(s, u.tileId, width) <= 1)) rate += perWorker;
  }
  return rate;
}

/**
 * Extra 💎/sec `army`'s Workers load on a vein (D17): refineryVeinBonus when the
 * army has a finished Refinery on or beside it. Several Refineries don't stack,
 * and an enemy's Refinery gives nothing.
 */
function refineryBonus(state, army, veinTileId) {
  const { width } = state.map;
  return builtFacilities(army, 'refinery').some((r) => manhattan(r.tileId, veinTileId, width) <= 1) ? TUNING.refineryVeinBonus : 0;
}

/** Finished queue items step onto their spawn tile; a Summoner brings a Golem to the base. */
function stepProduction(state, now, events) {
  for (const [owner, army] of Object.entries(state.armies)) {
    for (const [key, queue] of Object.entries(army.queues)) {
      const tile = Number(key);
      while (queue.length && queue[0].doneAt <= now) {
        const { unitType } = queue.shift();
        const spawned = [[unitType, tile]];
        if (UNIT_TYPES[unitType].flags.includes('summonsGolem')) spawned.push(['golem', state.bases[army.team].tileId]);
        for (const [type, at] of spawned) {
          const u = makeUnit(state.nextUnitId++, type, owner, at);
          army.units.push(u);
          events.push({ type: 'spawn', tileId: at, owner, team: army.team, unitId: u.id, unitType: type });
        }
      }
      if (!queue.length) delete army.queues[key];
    }
  }
}

/**
 * Supply accrual, then every hauler's loop: walk to the vein, load at
 * mineLoadSec × richness (a contested vein swings ±veinLuckMagnitude, rolled once
 * per load), carry carryCap to the nearest deposit, unload, go back.
 */
function stepEconomy(state, dtMs, now, events) {
  const rng = rngFor((state.seed ^ 0x5bd1e995) >>> 0, state.tick); // its own stream, apart from combat's
  const secs = dtMs / 1000;
  for (const [owner, army] of Object.entries(state.armies)) {
    army.supply = round3(army.supply + supplyRate(state, army) * secs);
    for (const u of army.units) {
      const h = u.haul;
      if (!h || u.hp <= 0) continue;
      const vein = state.map.veins.find((v) => v.tileId === h.veinTileId);
      if (!vein) {
        u.haul = null;
        continue;
      }
      if (u.path.length) continue; // still walking this leg
      if (h.stage === 'toVein') {
        if (u.tileId !== vein.tileId) {
          headFor(state, army, u, vein.tileId, now);
          continue;
        }
        h.stage = 'loading';
        h.luck = vein.contested ? (rng() * 2 - 1) * TUNING.veinLuckMagnitude : 0;
      }
      if (h.stage === 'loading') {
        const rate = TUNING.mineLoadSec * vein.richness * (1 + (h.luck || 0)) + refineryBonus(state, army, vein.tileId);
        u.carrying = Math.min(TUNING.carryCap, round3(u.carrying + rate * secs));
        if (u.carrying < TUNING.carryCap) continue;
        h.stage = 'toDeposit';
        headFor(state, army, u, nearestTile(state, u, depositTiles(state, army)), now);
        continue;
      }
      if (h.stage === 'toDeposit') {
        const deposits = depositTiles(state, army);
        if (!deposits.includes(u.tileId)) {
          headFor(state, army, u, nearestTile(state, u, deposits), now);
          continue;
        }
        if (u.carrying > 0) {
          army.minerals = round3(army.minerals + u.carrying);
          events.push({ type: 'deposit', tileId: u.tileId, owner, team: army.team, unitId: u.id, minerals: u.carrying });
          u.carrying = 0;
        }
        h.stage = 'toVein';
        headFor(state, army, u, vein.tileId, now);
      }
    }
  }
}

/** Collects whatever lies on the tile a unit just walked onto. */
function arriveAt(state, owner, unit, events) {
  const army = state.armies[owner];
  const { pickups } = state;
  const wi = pickups.weapons.findIndex((w) => w.tileId === unit.tileId);
  if (wi >= 0) {
    const [w] = pickups.weapons.splice(wi, 1);
    army.arsenal.push(w.weaponId);
    events.push({ type: 'pickup', tileId: unit.tileId, owner, team: army.team, weaponId: w.weaponId });
  }
  const drop = pickups.mineralDrops[unit.tileId];
  if (drop) {
    delete pickups.mineralDrops[unit.tileId];
    army.minerals += drop;
    events.push({ type: 'pickup', tileId: unit.tileId, owner, team: army.team, minerals: drop });
  }
}

/**
 * Walks every unit with a path through each step that finishes by `now`. A
 * new step starts when the last one ended, but never earlier than this sim
 * step began (`now - dtMs`), so a stalled loop or a restart can't fast-forward
 * a unit through a long backlog of steps.
 */
function stepMovement(state, dtMs, now, events) {
  const floor = now - dtMs;
  for (const { unit, owner } of allUnits(state)) {
    while (unit.path.length && unit.stepEndsAt <= now) {
      unit.tileId = unit.path.shift();
      arriveAt(state, owner, unit, events);
      if (unit.path.length) {
        unit.stepStartedAt = Math.max(unit.stepEndsAt, floor);
        unit.stepEndsAt = unit.stepStartedAt + stepMs(state.map, unit.type, unit.path[0]);
      } else {
        unit.stepStartedAt = 0;
        unit.stepEndsAt = 0;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Combat (spec "Combat", "High ground", "Under attack")
// ---------------------------------------------------------------------------

/** Hills are high ground; every other tile is low. */
function isHigh(map, id) {
  return terrainAt(map, id) === 'hills';
}

/**
 * How far `attacker` ({ tileId, range }) reaches toward `targetTileId` (D13). Ranged
 * units (base range ≥ 2) gain hillRangeBonus shooting down from a hill and lose
 * uphillRangePenalty shooting up at one; same level = plain range. Melee range is fixed.
 */
function effectiveRange(map, attacker, targetTileId) {
  const r = attacker.range;
  if (r < 2) return r;
  const high = isHigh(map, attacker.tileId);
  const targetHigh = isHigh(map, targetTileId);
  if (high && !targetHigh) return r + TUNING.hillRangeBonus;
  if (!high && targetHigh) return Math.max(0, r - TUNING.uphillRangePenalty);
  return r;
}

/** Whether `attacker` can hit a target on `targetTileId`: in range, and melee only on its own level. */
function canReach(map, attacker, targetTileId) {
  const d = manhattan(attacker.tileId, targetTileId, map.width);
  if (attacker.range >= 2) return d <= effectiveRange(map, attacker, targetTileId);
  return d <= attacker.range && isHigh(map, attacker.tileId) === isHigh(map, targetTileId);
}

/** Every fighter on the field this step: units (by id) and then both bases. */
function combatants(state) {
  const out = [];
  for (const { unit, owner, team } of allUnits(state)) {
    if (unit.hp <= 0) continue;
    const t = unitStats(unit.type);
    out.push({
      kind: 'unit', id: unit.id, unit, owner, team, race: t.race, cls: t.class, flags: t.flags,
      tileId: unit.tileId, range: t.range, atk: t.atk, attackMs: t.attackMs,
    });
  }
  out.sort((a, b) => a.id - b.id);
  for (const team of ['red', 'blue']) {
    const base = state.bases[team];
    out.push({
      kind: 'base', id: Infinity, base, owner: null, team, race: null, cls: 'structure', flags: [],
      tileId: base.tileId, range: TUNING.baseRange, atk: TUNING.baseAtk, attackMs: TUNING.baseAttackMs,
    });
  }
  return out;
}

/** A base can be damaged when it stands, isn't shielded, and no defender stands on it (D9). */
function baseDamageable(state, team, fighters, now) {
  const base = state.bases[team];
  if (base.hp <= 0 || base.shieldUntil > now) return false;
  return !fighters.some((f) => f.kind === 'unit' && f.team === team && f.tileId === base.tileId);
}

/** Whether `target` (a fighter) is something `attacker` may pick right now. */
function isValidTarget(state, attacker, target, fighters, now) {
  if (target.team === attacker.team) return false;
  if (target.kind === 'unit' && target.unit.hp <= 0) return false;
  if (target.kind === 'base' && (attacker.kind === 'base' || !baseDamageable(state, target.team, fighters, now))) return false;
  return canReach(state.map, attacker, target.tileId);
}

/** Nearest enemy `attacker` can hit; ties break by unit id, a base after units. */
function pickTarget(state, attacker, fighters, now) {
  let best = null;
  let bestD = Infinity;
  for (const f of fighters) {
    if (!isValidTarget(state, attacker, f, fighters, now)) continue;
    const d = manhattan(attacker.tileId, f.tileId, state.map.width);
    if (d < bestD || (d === bestD && f.id < best.id)) {
      best = f;
      bestD = d;
    }
  }
  return best;
}

/**
 * strategyEdge (D5): the enemy's dominant RPS class near the attacker, and the
 * fraction of the attacker's team's RPS units near it that counter that class.
 */
function strategyEdge(state, attacker, fighters) {
  const { width } = state.map;
  const near = (f) => f.kind === 'unit' && RPS_BEATS[f.cls] && manhattan(attacker.tileId, f.tileId, width) <= TUNING.dominantClassRadius;
  const counts = {};
  for (const f of fighters) if (f.team !== attacker.team && near(f)) counts[f.cls] = (counts[f.cls] || 0) + 1;
  let dominant = null;
  let top = 0;
  let tie = false;
  for (const cls of RPS_CLASSES) {
    const n = counts[cls] || 0;
    if (n > top) {
      dominant = cls;
      top = n;
      tie = false;
    } else if (n && n === top) {
      tie = true;
    }
  }
  if (!dominant || tie) return 0;
  const mine = fighters.filter((f) => f.team === attacker.team && near(f));
  if (!mine.length) return 0;
  return mine.filter((f) => RPS_BEATS[f.cls] === dominant).length / mine.length;
}

/** Whether a luckBend Archmage of `team` stands within luckBendRadius of `tileId` (D6). */
function archmageNear(state, team, tileId, fighters) {
  return fighters.some((f) => f.kind === 'unit' && f.team === team && f.flags.includes('luckBend')
    && manhattan(f.tileId, tileId, state.map.width) <= TUNING.luckBendRadius);
}

/** One hit's damage, per the spec's formula. Draws exactly one number from `rng`. */
function hitDamage(state, attacker, target, fighters, rng, now) {
  let atk = attacker.atk * rpsMultiplier(attacker.cls, target.cls);
  if (attacker.race === 'horde') atk *= TUNING.hordeAtkMult;
  if (attacker.cls === 'siege' && target.cls === 'structure') atk *= TUNING.siegeVsStructureMult;
  let defense = TERRAIN_TYPES[terrainAt(state.map, target.tileId)].defense || 1;
  if (target.cls === 'structure') defense *= TUNING.structureDefense;
  let luck = TUNING.luckMagnitude;
  if (attacker.race === 'horde') luck *= TUNING.hordeLuckMult;
  if (archmageNear(state, attacker.team, attacker.tileId, fighters)) luck *= TUNING.archmageOwnLuckMult;
  if (archmageNear(state, target.team, target.tileId, fighters)) luck *= TUNING.archmageEnemyLuckMult;
  const ev = state.event;
  if (ev && ev.effectId === 'sandstorm' && ev.endsAt > now) luck *= TUNING.sandstormLuck;
  const swing = (rng() * 2 - 1) * luck * (1 - strategyEdge(state, attacker, fighters));
  const dmg = (atk / defense) * (1 + swing);
  return Math.max(0, Math.round(dmg * 100) / 100);
}

/**
 * The nearest passable tile, at most fallBackMaxTiles steps away, out of
 * `attacker`'s reach (BFS, N/E/S/W tie-break), or null if there is none.
 */
function fallBackTile(state, unit, attacker) {
  const { map } = state;
  const depth = new Map([[unit.tileId, 0]]);
  const queue = [unit.tileId];
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    const d = depth.get(cur);
    if (d > 0 && !canReach(map, attacker, cur)) return cur;
    if (d >= TUNING.fallBackMaxTiles) continue;
    for (const n of neighbors(cur, map.width, map.height)) {
      if (depth.has(n) || !isPassable(map, n)) continue;
      depth.set(n, d + 1);
      queue.push(n);
    }
  }
  return null;
}

/**
 * Everyone whose cooldown is up hits the nearest enemy they can reach. Targets are
 * picked from the field as it stood at the start of the step and damage lands
 * together, so the order units are listed in never decides a fight.
 */
function stepCombat(state, now, events) {
  const rng = rngFor(state.seed, state.tick);
  const fighters = combatants(state);
  const hits = [];
  for (const attacker of fighters) {
    const holder = attacker.kind === 'unit' ? attacker.unit : attacker.base;
    if (holder.atkReadyAt > now) continue;
    // Facilities other than the Tower never attack, and a construction site waits until it's done.
    if (attacker.atk <= 0 || (attacker.kind === 'unit' && attacker.unit.buildDoneAt)) continue;
    if (attacker.kind === 'base' && attacker.base.hp <= 0) continue;
    const target = pickTarget(state, attacker, fighters, now);
    if (!target) continue;
    holder.atkReadyAt = now + attacker.attackMs;
    const victims = attacker.flags.includes('aoe') && target.kind === 'unit'
      ? fighters.filter((f) => f.kind === 'unit' && f.team !== attacker.team && f.tileId === target.tileId)
      : [target];
    for (const victim of victims) hits.push({ attacker, victim, dmg: hitDamage(state, attacker, victim, fighters, rng, now) });
  }

  const hitBy = new Map(); // unit id -> attackers that hit it this step
  for (const { attacker, victim, dmg } of hits) {
    const base = {
      tileId: victim.tileId, fromTileId: attacker.tileId, dmg,
      by: attacker.kind === 'unit' ? attacker.unit.type : 'base', ranged: attacker.range >= 2,
    };
    // Battle stats (display only): the hit that drops a unit gets the kill, and
    // base damage counts what the base actually lost.
    const stats = attacker.kind === 'unit' ? statsOf(state.armies[attacker.owner]) : null;
    if (victim.kind === 'base') {
      const before = victim.base.hp;
      victim.base.hp = Math.max(0, Math.round((victim.base.hp - dmg) * 100) / 100);
      if (stats) stats.baseDmg = Math.round((stats.baseDmg + before - victim.base.hp) * 100) / 100;
      events.push({ type: 'baseHit', team: victim.team, hp: victim.base.hp, ...base });
    } else {
      const before = victim.unit.hp;
      victim.unit.hp = Math.round((victim.unit.hp - dmg) * 100) / 100;
      if (stats && before > 0 && victim.unit.hp <= 0) stats.kills += 1;
      events.push({ type: 'underAttack', owner: victim.owner, team: victim.team, unitId: victim.id, ...base });
      if (!hitBy.has(victim.id)) hitBy.set(victim.id, []);
      hitBy.get(victim.id).push(attacker);
    }
    // The victim's team sees whoever just hit them for a moment (D14).
    if (attacker.kind === 'unit') {
      const u = attacker.unit;
      u.revealedUntil = { red: 0, blue: 0, ...u.revealedUntil, [victim.team]: now + WF_REVEAL_MS };
    }
  }

  // Deaths: a loaded Worker leaves its cargo on the tile.
  for (const [owner, army] of Object.entries(state.armies)) {
    army.units = army.units.filter((u) => {
      if (u.hp > 0) return true;
      if (u.carrying > 0) {
        state.pickups.mineralDrops[u.tileId] = (state.pickups.mineralDrops[u.tileId] || 0) + u.carrying;
      }
      statsOf(army).lost += 1;
      if (FACILITIES[u.type]) loseFacility(army, u);
      events.push({ type: 'death', tileId: u.tileId, owner, team: army.team, unitId: u.id, unitType: u.type });
      return false;
    });
  }

  // Fall back: an idle unit hit only by enemies it can't answer steps out of reach.
  for (const f of fighters) {
    const attackers = f.kind === 'unit' && hitBy.get(f.id);
    if (!attackers) continue;
    const u = f.unit;
    if (u.hp <= 0 || u.path.length || u.haul || u.holding || unitStats(u.type).move <= 0) continue;
    const live = attackers.filter((a) => a.kind === 'base' || a.unit.hp > 0);
    if (!live.length) continue;
    const me = { ...f, tileId: u.tileId };
    if (live.some((a) => isValidTarget(state, me, a, fighters, now))) continue;
    const to = fallBackTile(state, u, live[0]);
    if (to != null) orderMove(state, u, to, now);
  }
}

/**
 * Lighthouse capture (D15): a lighthouse flips to a team the moment only that
 * team's units stand on it. Both teams or nobody: it keeps its owner. Runs after
 * movement and combat, so the dead don't hold it.
 */
function stepLighthouses(state, events) {
  if (!state.lighthouses || !state.lighthouses.length) return;
  const present = new Map(); // tileId -> Set(team)
  for (const { unit, team } of allUnits(state)) {
    if (unit.hp <= 0) continue;
    if (!present.has(unit.tileId)) present.set(unit.tileId, new Set());
    present.get(unit.tileId).add(team);
  }
  for (const l of state.lighthouses) {
    const teams = present.get(l.tileId);
    if (!teams || teams.size !== 1) continue;
    const [team] = teams;
    if (l.team === team) continue;
    l.team = team;
    events.push({ type: 'lighthouse', tileId: l.tileId, team });
  }
}

/** An army's battle stats, created if an older saved match lacks them. */
function statsOf(army) {
  if (!army.stats) army.stats = { kills: 0, lost: 0, baseDmg: 0 };
  return army.stats;
}

// ---------------------------------------------------------------------------
// Win check (spec "Battlefield events, weapons, win check")
// ---------------------------------------------------------------------------

/** At the match cap: the team with more base HP wins; equal HP is a draw. */
function winnerByBaseHp(state) {
  const { red, blue } = state.bases;
  if (red.hp > blue.hp) return 'red';
  if (blue.hp > red.hp) return 'blue';
  return 'draw';
}

/**
 * The winner after this step, or null while the match goes on: a base at ≤0 HP
 * loses at once (both in the same step is a draw); at matchEndsAt the higher
 * base HP wins.
 */
function checkWinner(state, now) {
  const redDown = state.bases.red.hp <= 0;
  const blueDown = state.bases.blue.hp <= 0;
  if (redDown && blueDown) return { winner: 'draw', reason: 'base' };
  if (redDown) return { winner: 'blue', reason: 'base' };
  if (blueDown) return { winner: 'red', reason: 'base' };
  if (now >= state.clock.matchEndsAt) return { winner: winnerByBaseHp(state), reason: 'time' };
  return null;
}

/**
 * Advances the world by one sim step ending at `now` (`dtMs` long, already
 * clamped by the caller). Mutates and returns `state` with this step's events.
 * Systems arrive step by step: movement (Step 5), combat (Step 6), economy and
 * production (Step 7), the win check (Step 8), construction and the Workshop
 * (Step 9); battlefield events come later.
 * Once a winner is set the match is over and further steps do nothing.
 */
function stepSim(state, dtMs, { now }) {
  const events = [];
  if (state.winner) return { state, events };
  const dt = Math.max(0, Math.min(dtMs, WF_MAX_DT_MS));
  stepMovement(state, dt, now, events);
  stepConstruction(state, now, events);
  stepCombat(state, now, events);
  stepLighthouses(state, events);
  stepEconomy(state, dt, now, events);
  stepProduction(state, now, events);
  stepWorkshop(state, now, events);
  state.tick += 1;
  state.clock.lastTickAt = now;
  const result = checkWinner(state, now);
  if (result) {
    state.winner = result.winner;
    state.clock.endedAt = Math.min(now, state.clock.matchEndsAt);
    events.push({ type: 'gameOver', winner: result.winner, reason: result.reason });
  }
  return { state, events };
}

// ---------------------------------------------------------------------------
// Fog of war + per-viewer view (spec "Fog of war")
// ---------------------------------------------------------------------------

/**
 * Tiles a team can see: Manhattan WF_VISION around its units and its base, plus
 * WF_LIGHTHOUSE_VISION around every lighthouse it controls.
 */
function visionFor(state, team) {
  const { width, height } = state.map;
  const seen = new Set();
  if (!team) return seen;
  const diamond = (src, r) => {
    const { x, y } = tileXY(src, width);
    for (let dy = -r; dy <= r; dy++) {
      const span = r - Math.abs(dy);
      for (let dx = -span; dx <= span; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < width && ny < height) seen.add(tileId(nx, ny, width));
      }
    }
  };
  const sources = new Set([state.bases[team].tileId]);
  for (const { unit, team: t } of allUnits(state)) if (t === team) sources.add(unit.tileId);
  for (const src of sources) diamond(src, WF_VISION);
  for (const l of state.lighthouses || []) if (l.team === team) diamond(l.tileId, WF_LIGHTHOUSE_VISION);
  return seen;
}

/** Every lighthouse and who holds it (static features: everyone sees the owners). */
function lighthouseView(state) {
  return (state.lighthouses || []).map((l) => ({ tileId: l.tileId, team: l.team }));
}

/**
 * The live (dynamic) part of the battle as `name` may see it. Own team: every
 * unit with its full path. Enemies: only units on a tile in the team's vision,
 * with just the tile they're stepping onto (never their destination), and a
 * Worker's `carrying` only then. Spectators (no army) see no units at all.
 * `visible` is a '0'/'1' string per tile (row-major). Static map features are
 * in the wfState payload, not here.
 */
function viewForPlayer(state, name) {
  const army = state.armies[name] || null;
  const team = army ? army.team : null;
  const vision = visionFor(state, team);
  const now = state.clock.lastTickAt;
  const units = [];
  for (const { unit: u, owner, team: t } of allUnits(state)) {
    if (!team) break;
    const v = { id: u.id, type: u.type, tileId: u.tileId, hp: u.hp, owner, team: t };
    if (u.buildDoneAt) v.buildDoneAt = u.buildDoneAt;
    if (t === team) {
      v.path = u.path.slice();
      v.stepStartedAt = u.stepStartedAt;
      v.stepEndsAt = u.stepEndsAt;
      v.carrying = u.carrying;
      v.haul = u.haul;
      v.holding = Boolean(u.holding);
      // How long the step after this one takes, so the client can keep the unit
      // gliding past the tile edge until the next snapshot lands (no stop-start).
      if (u.path.length > 1) v.afterStepMs = stepMs(state.map, u.type, u.path[1]);
    } else {
      if (!vision.has(u.tileId)) {
        // An attacker that just hit this team stays in sight for WF_REVEAL_MS (D14).
        if (!(u.revealedUntil && u.revealedUntil[team] > now)) continue;
        v.revealed = true;
      }
      if (u.path.length) {
        v.nextTileId = u.path[0];
        v.stepStartedAt = u.stepStartedAt;
        v.stepEndsAt = u.stepEndsAt;
        // The step after, only onto a tile this team can already see (never leaks the route into fog).
        if (u.path.length > 1 && vision.has(u.path[1])) {
          v.afterTileId = u.path[1];
          v.afterStepMs = stepMs(state.map, u.type, u.path[1]);
        }
      }
      if (u.class === 'worker') v.carrying = u.carrying;
    }
    units.push(v);
  }
  let visible = '';
  for (let i = 0; i < state.map.width * state.map.height; i++) visible += vision.has(i) ? '1' : '0';
  return {
    tick: state.tick,
    bases: state.bases,
    clock: state.clock,
    event: state.event,
    me: army ? ownEconomy(state, army) : null,
    units,
    visible,
    lighthouses: lighthouseView(state),
    pickups: {
      weapons: state.pickups.weapons.map((w) => ({ tileId: w.tileId, weaponId: w.weaponId })),
      mineralDrops: { ...state.pickups.mineralDrops },
    },
  };
}

/**
 * A player's own resources (never shown to anyone else): 🔩 with its rate per
 * second, 💎, arsenal, unit slots used toward the cap, and each spawn point's
 * queue with when the item being built started.
 */
function ownEconomy(state, army) {
  const queues = Object.entries(army.queues).map(([key, q]) => ({
    tileId: Number(key),
    items: q.map((item) => ({ unitType: item.unitType, startedAt: item.doneAt - buildMs(item.unitType), doneAt: item.doneAt })),
  }));
  return {
    supply: army.supply,
    supplyRate: round3(supplyRate(state, army)),
    minerals: army.minerals,
    arsenal: army.arsenal.slice(),
    units: unitSlotsUsed(army),
    unitCap: WF_MAX_UNITS_PER_PLAYER,
    queues,
    workshop: (army.workshop || []).map((w) => ({ weaponId: w.weaponId, startedAt: w.doneAt - TUNING.workshopWeaponMs, doneAt: w.doneAt })),
  };
}

/** The events of one step that `name` may hear about (own team's, or on a tile they can see). */
function eventsForPlayer(state, name, events) {
  const team = teamOf(state, name);
  if (!team || !events.length) return [];
  const vision = visionFor(state, team);
  // A lighthouse flip is news to everyone: its owner is never hidden (D15).
  return events.filter((e) => e.team === team || e.type === 'lighthouse' || vision.has(e.tileId));
}

/**
 * The finished battle with the fog lifted, for the game-over screen: every unit
 * where it stood (no orders), both bases, the pickups left on the map, the clock,
 * and each player's battle stats.
 */
function finalView(state) {
  const units = allUnits(state).map(({ unit: u, owner, team }) => ({
    id: u.id, type: u.type, tileId: u.tileId, hp: u.hp, owner, team, carrying: u.carrying || 0,
  }));
  const stats = Object.entries(state.armies).map(([name, a]) => ({
    name, team: a.team, race: a.race, kills: 0, lost: 0, baseDmg: 0, ...a.stats,
  }));
  return {
    winner: state.winner,
    bases: state.bases,
    clock: state.clock,
    units,
    visible: '1'.repeat(state.map.width * state.map.height),
    lighthouses: lighthouseView(state),
    pickups: {
      weapons: state.pickups.weapons.map((w) => ({ tileId: w.tileId, weaponId: w.weaponId })),
      mineralDrops: { ...state.pickups.mineralDrops },
    },
    stats,
  };
}

module.exports = {
  WF_STEP_MS_BASE,
  WF_MATCH_CAP_MS,
  WF_EVENT_MS,
  WF_VISION,
  WF_MAX_UNITS_PER_PLAYER,
  WF_MAX_DT_MS,
  WF_REVEAL_MS,
  WF_LIGHTHOUSE_VISION,
  MAX_LIGHTHOUSES,
  LIGHTHOUSE_HOME_RANGE,
  TUNING,
  RACES,
  RPS_CLASSES,
  UNIT_CLASSES,
  RPS_BEATS,
  UNIT_TYPES,
  TERRAIN_TYPES,
  FACILITIES,
  FACILITY_UNITS,
  WEAPON_EFFECTS,
  EVENT_EFFECTS,
  TEAM_PHRASES,
  MAP_SIZES,
  DEFAULT_MAP_SIZE,
  MATCH_LENGTHS,
  DEFAULT_MATCH_LENGTH,
  producibleTypes,
  unitStats,
  facilityCost,
  buildBlocker,
  rpsMultiplier,
  tileId,
  tileXY,
  manhattan,
  neighbors,
  isPassable,
  floodFill,
  bfsPath,
  findPath,
  pathCost,
  validateMap,
  buildFallbackMap,
  makeUnit,
  createBattleState,
  stepMs,
  buildMs,
  supplyRate,
  applyCommand,
  isHigh,
  effectiveRange,
  canReach,
  fallBackTile,
  stepSim,
  spawnPoints,
  depositTiles,
  winnerByBaseHp,
  checkWinner,
  visionFor,
  viewForPlayer,
  eventsForPlayer,
  finalView,
};
