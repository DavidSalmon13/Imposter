'use strict';

// Warfront engine, layer 5: battlefield validation (the AI's JSON → a normalized map) for a team
// battle (2 sides) or free for all (3-4). Must NOT contain: the fallback generators (fallbackMap.js,
// fallbackFfa.js), OpenAI calls (shell battlefield.js) or battle state.
// Spec: "Map generation", "Free-for-all mode" (Map), "Lighthouses" (placement rules).

const { MAX_LIGHTHOUSES, LIGHTHOUSE_HOME_RANGE, LIGHTHOUSE_FAIRNESS } = require('./constants');
const { TERRAIN_TYPES, WEAPON_EFFECTS, MAP_SIZES, SIDES } = require('./data');
const { tileId, manhattan, isPassable } = require('./grid');
const { floodFill } = require('./pathing');

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

// Where a base sits: its half in a team battle ('left'/'right'), its corner quarter in free for all
// ('nw'/'ne'/'sw'/'se'). A tile on the odd middle column (or, in FFA, the odd middle row) is 'middle'.
function zoneOf(pt, width, height, sides) {
  const midX = width % 2 === 1 && pt.x === (width - 1) / 2;
  const h = pt.x < width / 2 ? 'w' : 'e';
  if (sides === 2) return midX ? 'middle' : h === 'w' ? 'left' : 'right';
  const midY = height % 2 === 1 && pt.y === (height - 1) / 2;
  if (midX || midY) return 'middle';
  return (pt.y < height / 2 ? 'n' : 's') + h;
}

const COUNT_WORDS = Object.freeze({ 2: 'two', 3: 'three', 4: 'four' });
const spread = (values) => Math.max(...values) - Math.min(...values);

/**
 * Validates a raw map object (OpenAI JSON or the fallback) against `size`
 * (a MAP_SIZES key or { width, height }) and returns the normalized map:
 * tiles become terrain strings, every feature gains a tileId, supply sources
 * gain the team of the base they serve. Throws with a specific message.
 * `sides` is 2 (a team battle: red and blue on opposite halves) or 3-4 (free for all: the first
 * `sides` of SIDES, one base per corner quarter, Medium or Large only).
 */
function validateMap(raw, size, { sides = 2 } = {}) {
  if (!COUNT_WORDS[sides]) throw new Error(`a map has 2 to 4 sides, not ${sides}`);
  const { width, height } = resolveSize(size);
  const ffa = sides > 2;
  if (ffa && (width < MAP_SIZES.medium.width || height < MAP_SIZES.medium.height)) {
    throw new Error('free for all needs a Medium or Large map');
  }
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
  const teams = SIDES.slice(0, sides);
  const zone = (pt) => zoneOf(pt, width, height, sides);
  const zoneName = ffa ? 'corner quarter' : 'half';

  // Bases: exactly one per side, each in its own half (team battle) or corner quarter (FFA), none adjacent.
  if (!Array.isArray(raw.bases) || raw.bases.length !== sides) throw new Error(`map needs exactly ${COUNT_WORDS[sides]} bases`);
  const bases = {};
  for (const b of raw.bases) {
    const team = b && b.team;
    if (!teams.includes(team)) throw new Error(`base has unknown team "${team}"`);
    if (bases[team]) throw new Error(`map has two ${team} bases`);
    bases[team] = { team, ...claim(readPoint(b, `${team} base`, width, height), `${team} base`) };
  }
  const baseZones = teams.map((t) => zone(bases[t]));
  if (baseZones.includes('middle') || new Set(baseZones).size !== sides) {
    throw new Error(ffa ? 'each base must sit in its own corner quarter of the map' : 'bases must sit on opposite halves of the map');
  }
  for (let i = 0; i < sides; i++) {
    for (let j = i + 1; j < sides; j++) {
      if (manhattan(bases[teams[i]].tileId, bases[teams[j]].tileId, width) <= 1) throw new Error('bases must not be adjacent');
    }
  }

  // Supply sources: exactly one orthogonally adjacent to each base.
  if (!Array.isArray(raw.supplySources) || raw.supplySources.length !== sides) {
    throw new Error(`map needs exactly ${COUNT_WORDS[sides]} supply sources`);
  }
  const supplySources = raw.supplySources.map((s) => claim(readPoint(s, 'supply source', width, height), 'supply source'));
  for (const team of teams) {
    const near = supplySources.filter((s) => manhattan(s.tileId, bases[team].tileId, width) === 1);
    if (near.length !== 1) throw new Error(`the ${team} base needs exactly one adjacent supply source`);
    if (near[0].team) throw new Error('one supply source cannot serve two bases');
    near[0].team = team;
  }

  // Veins: 1-2, passable, richness 1-3, fair: the richness-weighted mean distance to each base
  // differs by at most VEIN_FAIRNESS_TOLERANCE between the nearest and farthest base.
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
  if (spread(teams.map(veinReach)) > VEIN_FAIRNESS_TOLERANCE) {
    throw new Error(ffa ? 'veins are not equally far from every base' : 'veins are not mirror-fair between the two bases');
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

  // Lighthouses (D15): one home lighthouse per base, in its half / corner quarter within
  // LIGHTHOUSE_HOME_RANGE of it (owned by that side at the start), up to MAX_LIGHTHOUSES in all. Any
  // extras start neutral and must be fair: about as far from every base (or, in a team battle, a
  // mirrored pair).
  const rawLighthouses = raw.lighthouses;
  if (!Array.isArray(rawLighthouses) || rawLighthouses.length < sides || rawLighthouses.length > MAX_LIGHTHOUSES) {
    throw new Error(`map needs ${sides} to ${MAX_LIGHTHOUSES} lighthouses`);
  }
  const lighthouses = rawLighthouses.map((l) => ({ ...claim(readPoint(l, 'lighthouse', width, height), 'lighthouse'), team: null }));
  for (const team of teams) {
    const home = lighthouses.filter((l) => zone(l) === zone(bases[team])
      && manhattan(l.tileId, bases[team].tileId, width) <= LIGHTHOUSE_HOME_RANGE);
    if (home.length === 0) throw new Error(`the ${team} base needs a lighthouse within ${LIGHTHOUSE_HOME_RANGE} tiles on its ${zoneName}`);
    if (home.length > 1) throw new Error(`the ${team} base has more than one lighthouse within ${LIGHTHOUSE_HOME_RANGE} tiles`);
    home[0].team = team;
  }
  const extras = lighthouses.filter((l) => !l.team);
  const fair = (l) => spread(teams.map((t) => manhattan(l.tileId, bases[t].tileId, width))) <= LIGHTHOUSE_FAIRNESS;
  const mirrored = (a, b) => a.x === width - 1 - b.x && (a.y === b.y || a.y === height - 1 - b.y);
  const pairOk = !ffa && extras.length === 2 && mirrored(extras[0], extras[1]);
  for (const l of extras) {
    if (!fair(l) && !pairOk) throw new Error(`lighthouse at (${l.x},${l.y}) is not fair to ${ffa ? 'every base' : 'both bases'}`);
  }

  // Connectivity: the first base reaches every other base and every feature.
  const reach = floodFill(map, bases[teams[0]].tileId);
  for (const team of teams.slice(1)) {
    if (!reach.has(bases[team].tileId)) {
      throw new Error(ffa ? `the ${team} base is not connected to the ${teams[0]} base` : 'the two bases are not connected');
    }
  }
  for (const [what, list] of [['supply source', supplySources], ['vein', veins], ['weapon token', weapons], ['lighthouse', lighthouses]]) {
    for (const f of list) {
      if (!reach.has(f.tileId)) throw new Error(`${what} at (${f.x},${f.y}) is unreachable`);
    }
  }

  // Supply walls (2026-11-13): the supply source plus the free tiles either side of it, across the
  // line from its base, form a short wall of rock Workers carve 🔩 from. Flank tiles that are off the
  // map, impassable or already a feature are simply left out (the source itself always stands).
  const supplyWalls = [];
  for (const src of supplySources) {
    const base = bases[src.team];
    const across = src.x === base.x ? [[-1, 0], [1, 0]] : [[0, -1], [0, 1]];
    supplyWalls.push({ x: src.x, y: src.y, tileId: src.tileId, team: src.team });
    for (const [dx, dy] of across) {
      const x = src.x + dx;
      const y = src.y + dy;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const id = tileId(x, y, width);
      if (used.has(id) || !isPassable(map, id) || !reach.has(id)) continue;
      used.add(id);
      supplyWalls.push({ x, y, tileId: id, team: src.team });
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
    bases: teams.map((t) => bases[t]),
    supplySources,
    supplyWalls,
    veins,
    weapons,
    lighthouses,
    chokepoints,
  };
}

module.exports = {
  validateMap,
  resolveSize,
};
