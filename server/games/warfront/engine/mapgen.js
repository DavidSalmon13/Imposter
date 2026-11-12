'use strict';

// Warfront engine, layer 5: battlefield validation (the AI's JSON → a normalized map) and the
// seeded fallback map generator. Must NOT contain: OpenAI calls (shell battlefield.js) or battle state.
// Spec: "Map generation", "Lighthouses" (placement rules).

const { MAX_LIGHTHOUSES, LIGHTHOUSE_HOME_RANGE, LIGHTHOUSE_FAIRNESS } = require('./constants');
const { TERRAIN_TYPES, WEAPON_EFFECTS, MAP_SIZES } = require('./data');
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

module.exports = {
  validateMap,
  buildFallbackMap,
};
