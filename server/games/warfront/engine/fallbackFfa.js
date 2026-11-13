'use strict';

// Warfront engine, layer 5c: the seeded fallback map for free for all (3-4 sides). One quarter is
// generated and mirrored onto all four (both axes), so every corner gets the same land; a base sits
// in each used corner, inset one tile from the edges. Must NOT contain: validation rules (mapgen.js)
// or OpenAI calls (shell battlefield.js). Spec: "Free-for-all mode" (Map), "Map generation" step 3.

const { LIGHTHOUSE_HOME_RANGE, LIGHTHOUSE_FAIRNESS } = require('./constants');
const { SIDES } = require('./data');
const { validateMap, resolveSize } = require('./mapgen');
const { FALLBACK_ATTEMPTS, WEAPON_IDS, pick, randInt, randomTerrain } = require('./fallbackMap');

const FFA_THEMES = Object.freeze([
  ['Four Winds Crossing', 'Four warlords march from the corners of the world toward the ore at its heart.'],
  ['The Shattered Crown', 'The old kingdom split four ways. Each heir wants the crystals in the ruined capital.'],
  ['Quarry of Kings', 'Four camps ring a quarry so rich that no truce has ever lasted a season.'],
  ['Crossroads of Ash', 'Where four roads meet, the ground glows with minerals and nobody trusts anybody.'],
]);

/** One candidate FFA map (raw shape), or the all-plains one when `plain`. */
function ffaCandidate(width, height, rng, sides, plain) {
  const qw = Math.ceil(width / 2);
  const qh = Math.ceil(height / 2);
  const mx = (x) => width - 1 - x;
  const my = (y) => height - 1 - y;
  const grid = Array.from({ length: height }, () => new Array(width).fill('plains'));
  if (!plain) {
    for (let y = 0; y < qh; y++) {
      for (let x = 0; x < qw; x++) {
        const t = randomTerrain(rng);
        grid[y][x] = t;
        grid[y][mx(x)] = t;
        grid[my(y)][x] = t;
        grid[my(y)][mx(x)] = t;
      }
    }
  }
  // A tile and its three mirror images share one key, so a feature claims all four spots at once.
  const key = (x, y) => `${Math.min(x, mx(x))},${Math.min(y, my(y))}`;
  const taken = new Set();
  const free = (x, y) => !taken.has(key(x, y));
  const setPlain = (x, y) => {
    for (const [a, b] of [[x, y], [mx(x), y], [x, my(y)], [mx(x), my(y)]]) grid[b][a] = 'plains';
  };
  const take = (x, y) => {
    setPlain(x, y);
    taken.add(key(x, y));
  };
  const onCentreLine = (x, y) => x === mx(x) || y === my(y);

  // The north-west base, its supply source and its home lighthouse; the other corners mirror them.
  const bx = 1;
  const by = 1;
  take(bx, by);
  for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) setPlain(bx + dx, by + dy);
  const [sx, sy] = pick(rng, [[bx + 1, by], [bx, by + 1]]);
  take(sx, sy);
  const near = [];
  for (let y = 1; y < qh; y++) {
    for (let x = 0; x < qw; x++) {
      const d = Math.abs(x - bx) + Math.abs(y - by);
      // Not in the top row: the tall tower would be cut off by the top edge of the camera.
      if (d >= 2 && d <= 3 && !onCentreLine(x, y) && free(x, y)) near.push([x, y]);
    }
  }
  const home = near.length ? pick(rng, near) : null;
  if (home) take(home[0], home[1]);

  // Corners in a fixed order; with 3 sides the seed leaves one empty. Sides fill the rest in order.
  const corners = [(x, y) => [x, y], (x, y) => [mx(x), y], (x, y) => [x, my(y)], (x, y) => [mx(x), my(y)]];
  const used = corners.slice();
  if (sides === 3) used.splice(Math.floor(rng() * 4), 1);
  const at = (f, x, y) => {
    const [ax, ay] = f(x, y);
    return { x: ax, y: ay };
  };
  const bases = used.map((f, i) => ({ team: SIDES[i], ...at(f, bx, by) }));

  // Veins in the middle, the same distance from every corner: a pair mirrored on the odd middle
  // row (or column), or one on the centre tile.
  const veins = [];
  const cx = qw - 1;
  const cy = qh - 1;
  const richness = randInt(rng, 2, 3);
  const addVein = (x, y) => {
    take(x, y);
    veins.push({ x, y, richness, contested: true });
  };
  if (height % 2 === 1) {
    const vx = cx - randInt(rng, 0, 1);
    addVein(vx, cy);
    if (mx(vx) !== vx) addVein(mx(vx), cy);
  } else if (width % 2 === 1) {
    const vy = cy - randInt(rng, 0, 1);
    addVein(cx, vy);
    if (my(vy) !== vy) addVein(cx, my(vy));
  } else {
    addVein(cx, cy);
  }

  // Lighthouses: each used corner's home one, plus (3 sides only, as 4 homes use up the limit) one
  // contested lighthouse about as far from every base, more than LIGHTHOUSE_HOME_RANGE from each.
  const lighthouses = home ? used.map((f) => at(f, home[0], home[1])) : [];
  if (sides === 3) {
    const dist = (x, y, b) => Math.abs(x - b.x) + Math.abs(y - b.y);
    const pool = [];
    for (let y = 1; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!free(x, y)) continue;
        const ds = bases.map((b) => dist(x, y, b));
        if (Math.min(...ds) > LIGHTHOUSE_HOME_RANGE && Math.max(...ds) - Math.min(...ds) <= LIGHTHOUSE_FAIRNESS) pool.push([x, y]);
      }
    }
    if (pool.length) {
      const hills = pool.filter(([x, y]) => grid[y][x] === 'hills');
      const [lx, ly] = pick(rng, hills.length ? hills : pool);
      if (grid[ly][lx] !== 'hills') setPlain(lx, ly);
      taken.add(key(lx, ly));
      lighthouses.push({ x: lx, y: ly });
    }
  }

  // Weapon tokens: 1-2 sets of four, one in each corner's quarter between the base and the middle.
  const weapons = [];
  const sets = randInt(rng, 1, 2);
  for (let i = 0, tries = 0; i < sets && tries < 20; tries++) {
    const wx = randInt(rng, 0, cx);
    const wy = randInt(rng, 0, cy);
    if (!free(wx, wy) || onCentreLine(wx, wy) || Math.abs(wx - bx) + Math.abs(wy - by) < 2) continue;
    take(wx, wy);
    const weaponId = pick(rng, WEAPON_IDS);
    for (const f of corners) weapons.push({ ...at(f, wx, wy), weaponId });
    i++;
  }

  const [theme, lore] = pick(rng, FFA_THEMES);
  return {
    theme,
    lore,
    width,
    height,
    tiles: grid.flat().map((terrain) => ({ terrain })),
    bases,
    supplySources: used.map((f) => at(f, sx, sy)),
    veins,
    weapons,
    lighthouses,
    chokepoints: [],
  };
}

/**
 * A procedural, always-valid free-for-all map for `sides` (3 or 4) of `size` (MAP_SIZES key or
 * {width,height}; Medium or larger). Retried until it validates, with an all-plains last resort.
 */
function fallbackFfa(size, rng, sides) {
  const { width, height } = resolveSize(size);
  const opts = { sides };
  for (let i = 0; i < FALLBACK_ATTEMPTS; i++) {
    try {
      return validateMap(ffaCandidate(width, height, rng, sides, false), { width, height }, opts);
    } catch (_) {
      // try again
    }
  }
  return validateMap(ffaCandidate(width, height, rng, sides, true), { width, height }, opts);
}

module.exports = {
  fallbackFfa,
};
