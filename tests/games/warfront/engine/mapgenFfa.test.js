'use strict';

// Warfront engine tests: free-for-all maps (Step 26). validateMap with { sides: 3|4 } and the
// four-way mirrored fallback. Exercises server/games/warfront/engine/mapgen.js and fallbackFfa.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const E = require('../../../../server/games/warfront/engine');
const { rngFor } = require('../../../../server/lib/rng');

/** A normalized map back in the AI's raw shape, so a test can break one thing in it. */
function toRaw(m) {
  return {
    theme: m.theme,
    lore: m.lore,
    width: m.width,
    height: m.height,
    tiles: m.tiles.map((terrain) => ({ terrain })),
    bases: m.bases.map(({ team, x, y }) => ({ team, x, y })),
    supplySources: m.supplySources.map(({ x, y }) => ({ x, y })),
    veins: m.veins.map(({ x, y, richness, contested }) => ({ x, y, richness, contested })),
    weapons: m.weapons.map(({ x, y, weaponId }) => ({ x, y, weaponId })),
    lighthouses: m.lighthouses.map(({ x, y }) => ({ x, y })),
    chokepoints: [],
  };
}

// A plain medium 4-side map: bases inset in each corner, sources beside them, homes 2 tiles off.
function plainFfa() {
  const { width, height } = E.MAP_SIZES.medium;
  const mx = (x) => width - 1 - x;
  const my = (y) => height - 1 - y;
  const corner = [(x, y) => ({ x, y }), (x, y) => ({ x: mx(x), y }), (x, y) => ({ x, y: my(y) }), (x, y) => ({ x: mx(x), y: my(y) })];
  return {
    theme: 'Test Cross',
    lore: '',
    width,
    height,
    tiles: new Array(width * height).fill(null).map(() => ({ terrain: 'plains' })),
    bases: corner.map((f, i) => ({ team: E.SIDES[i], ...f(1, 1) })),
    supplySources: corner.map((f) => f(2, 1)),
    veins: [{ x: 7, y: 5, richness: 2 }, { x: 8, y: 5, richness: 2 }],
    weapons: [],
    lighthouses: corner.map((f) => f(1, 3)),
    chokepoints: [],
  };
}

const rejects = (raw, sides, pattern) => assert.throws(() => E.validateMap(raw, 'medium', { sides }), pattern);

test('validateMap (FFA): a plain 4-corner map validates; each side owns its home lighthouse', () => {
  const map = E.validateMap(plainFfa(), 'medium', { sides: 4 });
  assert.deepEqual(map.bases.map((b) => b.team), ['red', 'blue', 'green', 'gold']);
  assert.deepEqual(map.supplySources.map((s) => s.team), ['red', 'blue', 'green', 'gold']);
  assert.deepEqual(map.lighthouses.map((l) => l.team), ['red', 'blue', 'green', 'gold']);
  for (const team of E.SIDES) assert.equal(map.supplyWalls.filter((w) => w.team === team).length, 3);
});

test('validateMap (FFA): 3 sides use red, blue and green; a fourth base or a gold one is refused', () => {
  const raw = plainFfa();
  raw.bases = raw.bases.slice(0, 3);
  raw.supplySources = raw.supplySources.slice(0, 3);
  raw.lighthouses = raw.lighthouses.slice(0, 3);
  assert.equal(E.validateMap(raw, 'medium', { sides: 3 }).bases.length, 3);
  rejects(plainFfa(), 3, /exactly three bases/);
  const gold = plainFfa();
  gold.bases[2].team = 'gold';
  gold.bases = gold.bases.slice(0, 3);
  rejects(gold, 3, /unknown team "gold"/);
  // A team battle still only knows red and blue.
  assert.throws(() => E.validateMap(plainFfa(), 'medium'), /exactly two bases/);
});

test('validateMap (FFA): base placement rules', () => {
  const twoInOne = plainFfa();
  twoInOne.bases[1] = { team: 'blue', x: 4, y: 1 };
  twoInOne.supplySources[1] = { x: 5, y: 1 };
  rejects(twoInOne, 4, /its own corner quarter/);
  const middle = plainFfa();
  middle.bases[0] = { team: 'red', x: 1, y: 5 };
  middle.supplySources[0] = { x: 2, y: 5 };
  rejects(middle, 4, /its own corner quarter/);
  rejects({ ...plainFfa(), supplySources: plainFfa().supplySources.slice(0, 3) }, 4, /exactly four supply sources/);
});

test('validateMap (FFA): every base needs its own home lighthouse; extras must be fair to every base', () => {
  const noHome = plainFfa();
  noHome.lighthouses[3] = { x: 8, y: 3 };
  rejects(noHome, 4, /gold base needs a lighthouse within 4 tiles on its corner quarter/);
  // 3 sides: one extra may sit in the middle if it is about as far from all three bases.
  const three = plainFfa();
  three.bases = three.bases.slice(0, 3);
  three.supplySources = three.supplySources.slice(0, 3);
  three.lighthouses = [...three.lighthouses.slice(0, 3), { x: 7, y: 6 }];
  rejects(three, 3, /lighthouse at \(7,6\) is not fair to every base/);
  three.lighthouses[3] = { x: 7, y: 4 };
  assert.equal(E.validateMap(three, 'medium', { sides: 3 }).lighthouses[3].team, null);
});

test('validateMap (FFA): veins must be equally far from every base; bases must connect', () => {
  const unfair = plainFfa();
  unfair.veins = [{ x: 4, y: 3, richness: 2 }];
  rejects(unfair, 4, /veins are not equally far from every base/);
  const cut = plainFfa();
  // Wall off the gold (south-east) corner: water along x=11 and y=6 within its quarter.
  for (let y = 6; y < 11; y++) cut.tiles[y * 16 + 11] = { terrain: 'water' };
  for (let x = 11; x < 16; x++) cut.tiles[6 * 16 + x] = { terrain: 'water' };
  rejects(cut, 4, /gold base is not connected to the red base/);
});

test('validateMap (FFA): needs a Medium or Large map, and 2-4 sides', () => {
  assert.throws(() => E.validateMap(plainFfa(), 'small', { sides: 4 }), /Medium or Large/);
  assert.throws(() => E.validateMap(plainFfa(), 'medium', { sides: 5 }), /2 to 4 sides/);
  assert.throws(() => E.fallbackFfa('small', rngFor(1, 0), 3), /Medium or Large/);
});

test('fallbackFfa: 3 and 4 sides on Medium and Large validate across seeds, connect, and mirror every corner', () => {
  for (const size of ['medium', 'large']) {
    const { width, height } = E.MAP_SIZES[size];
    for (const sides of [3, 4]) {
      const corners = new Set();
      for (let seed = 0; seed < 120; seed++) {
        const map = E.fallbackFfa(size, rngFor(seed, 0), sides);
        const where = `${size} ${sides} sides seed ${seed}`;
        assert.doesNotThrow(() => E.validateMap(toRaw(map), size, { sides }), where);
        assert.deepEqual(map.bases.map((b) => b.team), E.SIDES.slice(0, sides), where);
        // Inset one tile from the edges, in a corner.
        for (const b of map.bases) {
          assert.ok([1, width - 2].includes(b.x) && [1, height - 2].includes(b.y), where);
        }
        if (sides === 3) corners.add(map.bases.map((b) => `${b.x},${b.y}`).join(' '));
        // Every base reaches every other.
        const reach = E.floodFill(map, map.bases[0].tileId);
        for (const b of map.bases) assert.ok(reach.has(b.tileId), where);
        // Four-way mirror: every corner gets the same land.
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const t = map.tiles[E.tileId(x, y, width)];
            assert.equal(map.tiles[E.tileId(width - 1 - x, y, width)], t, where);
            assert.equal(map.tiles[E.tileId(x, height - 1 - y, width)], t, where);
          }
        }
        // Each side owns one home lighthouse; at most MAX_LIGHTHOUSES in all.
        assert.deepEqual(map.lighthouses.filter((l) => l.team).map((l) => l.team), E.SIDES.slice(0, sides), where);
        assert.ok(map.lighthouses.length <= E.MAX_LIGHTHOUSES, where);
      }
      // With 3 sides the seed picks which corner stays empty.
      if (sides === 3) assert.ok(corners.size > 1, `${size}: the empty corner varies with the seed`);
    }
  }
});

test('fallbackFfa is deterministic for a given rng, and a 4-side map starts a 4-side battle', () => {
  assert.deepEqual(E.fallbackFfa('medium', rngFor(7, 0), 4), E.fallbackFfa('medium', rngFor(7, 0), 4));
  const map = E.fallbackFfa('large', rngFor(3, 0), 4);
  const roster = E.SIDES.map((team, i) => ({ name: `P${i}`, team, race: 'forge' }));
  const st = E.createBattleState(map, roster, { seed: 1, now: 0, matchCapMs: 60000 });
  assert.deepEqual(Object.keys(st.bases).sort(), [...E.SIDES].sort());
  assert.deepEqual(st.lighthouses.map((l) => l.team).filter(Boolean), E.SIDES.slice());
});

test('fallbackFfa falls back to the plain map when every attempt fails', () => {
  const map = E.fallbackFfa('medium', () => 0.999999, 4);
  assert.ok(map.tiles.every((t) => t === 'plains'));
  assert.equal(map.bases.length, 4);
});
