'use strict';

// Warfront engine: pure, deterministic game logic. No sockets, timers, OpenAI,
// Date.now() or Math.random() — time arrives as `now`, randomness from
// rngFor(seed, tick) in server/lib/rng.js. Rules: specs/warfront-specs.md.
// Build order: implementation/warfront-plan.md (Step 1 = the data tables below).

// ---------------------------------------------------------------------------
// Engine-side constants (spec "Configurable constants"). Socket/loop timing
// (WF_TICK_MS, WF_BROADCAST_MS, roster limits) lives in the module, warfront.js.
// ---------------------------------------------------------------------------

const WF_STEP_MS_BASE = 900;
const WF_MATCH_CAP_MS = 720000;
const WF_EVENT_MS = 60000;
const WF_VISION = 2;
const WF_MAX_UNITS_PER_PLAYER = 30;
const WF_MAX_DT_MS = 1000;

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

  // Connectivity: the red base reaches the blue base and every feature.
  const reach = floodFill(map, bases.red.tileId);
  if (!reach.has(bases.blue.tileId)) throw new Error('the two bases are not connected');
  for (const [what, list] of [['supply source', supplySources], ['vein', veins], ['weapon token', weapons]]) {
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
  const t = UNIT_TYPES[type];
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
    red: { hp: TUNING.baseHp, maxHp: TUNING.baseHp, tileId: baseOf.red, shieldUntil: 0 },
    blue: { hp: TUNING.baseHp, maxHp: TUNING.baseHp, tileId: baseOf.blue, shieldUntil: 0 },
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

/** Time to walk onto `toTileId`: WF_STEP_MS_BASE ÷ Move × the entered tile's move cost. */
function stepMs(map, unitType, toTileId) {
  const move = UNIT_TYPES[unitType].move;
  const cost = TERRAIN_TYPES[terrainAt(map, toTileId)].moveCost;
  return Math.round((WF_STEP_MS_BASE / move) * cost);
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
    if (next !== to && !bfsPath(map, next, to).length) return false;
    unit.path = next === to ? [next] : [next, ...bfsPath(map, next, to)];
  } else {
    const path = bfsPath(map, unit.tileId, to);
    if (!path.length) return false;
    unit.path = path;
    unit.stepStartedAt = now;
    unit.stepEndsAt = now + stepMs(map, unit.type, path[0]);
  }
  unit.haul = null;
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
    const units = army.units.filter((u) => wanted.has(u.id) && UNIT_TYPES[u.type].move > 0);
    if (!units.length) return { ok: false, error: 'Those units are not yours to move' };
    let moved = 0;
    for (const u of units) if (orderMove(state, u, toTileId, now)) moved++;
    if (!moved) return { ok: false, error: 'Already there' };
    return { ok: true, moved };
  }
  return { ok: false, error: 'Unknown command' };
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

/**
 * Advances the world by one sim step ending at `now` (`dtMs` long, already
 * clamped by the caller). Mutates and returns `state` with this step's events.
 * Systems arrive step by step: movement (Step 5); combat, economy, events and
 * the win check come later.
 */
function stepSim(state, dtMs, { now }) {
  const events = [];
  const dt = Math.max(0, Math.min(dtMs, WF_MAX_DT_MS));
  stepMovement(state, dt, now, events);
  state.tick += 1;
  state.clock.lastTickAt = now;
  return { state, events };
}

// ---------------------------------------------------------------------------
// Fog of war + per-viewer view (spec "Fog of war")
// ---------------------------------------------------------------------------

/** Tiles a team can see: Manhattan WF_VISION around its units and its base. */
function visionFor(state, team) {
  const { width, height } = state.map;
  const seen = new Set();
  if (!team) return seen;
  const sources = new Set([state.bases[team].tileId]);
  for (const { unit, team: t } of allUnits(state)) if (t === team) sources.add(unit.tileId);
  for (const src of sources) {
    const { x, y } = tileXY(src, width);
    for (let dy = -WF_VISION; dy <= WF_VISION; dy++) {
      const span = WF_VISION - Math.abs(dy);
      for (let dx = -span; dx <= span; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < width && ny < height) seen.add(tileId(nx, ny, width));
      }
    }
  }
  return seen;
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
  const units = [];
  for (const { unit: u, owner, team: t } of allUnits(state)) {
    if (!team) break;
    const v = { id: u.id, type: u.type, tileId: u.tileId, hp: u.hp, owner, team: t };
    if (t === team) {
      v.path = u.path.slice();
      v.stepStartedAt = u.stepStartedAt;
      v.stepEndsAt = u.stepEndsAt;
      v.carrying = u.carrying;
      v.haul = u.haul;
    } else {
      if (!vision.has(u.tileId)) continue;
      if (u.path.length) {
        v.nextTileId = u.path[0];
        v.stepStartedAt = u.stepStartedAt;
        v.stepEndsAt = u.stepEndsAt;
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
    me: army ? { supply: army.supply, minerals: army.minerals, arsenal: army.arsenal.slice() } : null,
    units,
    visible,
    pickups: {
      weapons: state.pickups.weapons.map((w) => ({ tileId: w.tileId, weaponId: w.weaponId })),
      mineralDrops: { ...state.pickups.mineralDrops },
    },
  };
}

/** The events of one step that `name` may hear about (own team's, or on a tile they can see). */
function eventsForPlayer(state, name, events) {
  const team = teamOf(state, name);
  if (!team || !events.length) return [];
  const vision = visionFor(state, team);
  return events.filter((e) => e.team === team || vision.has(e.tileId));
}

module.exports = {
  WF_STEP_MS_BASE,
  WF_MATCH_CAP_MS,
  WF_EVENT_MS,
  WF_VISION,
  WF_MAX_UNITS_PER_PLAYER,
  WF_MAX_DT_MS,
  TUNING,
  RACES,
  RPS_CLASSES,
  UNIT_CLASSES,
  RPS_BEATS,
  UNIT_TYPES,
  TERRAIN_TYPES,
  FACILITIES,
  WEAPON_EFFECTS,
  EVENT_EFFECTS,
  TEAM_PHRASES,
  MAP_SIZES,
  DEFAULT_MAP_SIZE,
  MATCH_LENGTHS,
  DEFAULT_MATCH_LENGTH,
  producibleTypes,
  rpsMultiplier,
  tileId,
  tileXY,
  manhattan,
  neighbors,
  isPassable,
  floodFill,
  bfsPath,
  validateMap,
  buildFallbackMap,
  makeUnit,
  createBattleState,
  stepMs,
  applyCommand,
  stepSim,
  visionFor,
  viewForPlayer,
  eventsForPlayer,
};
