'use strict';

// Warfront engine, layer 5b: the seeded fallback map for a two-side (team) battle, and the random
// helpers the FFA fallback (fallbackFfa.js) shares. Must NOT contain: validation rules (mapgen.js)
// or OpenAI calls (shell battlefield.js). Spec: "Map generation" step 3, "Lighthouses" (placement).

const { LIGHTHOUSE_HOME_RANGE } = require('./constants');
const { WEAPON_EFFECTS } = require('./data');
const { validateMap, resolveSize } = require('./mapgen');

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
  buildFallbackMap,
  FALLBACK_THEMES,
  FALLBACK_ATTEMPTS,
  WEAPON_IDS,
  pick,
  randInt,
  randomTerrain,
};
