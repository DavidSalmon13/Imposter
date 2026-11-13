'use strict';

// Shared fixtures for the Warfront engine tests: hand-made maps, battles, sim runners and
// command shorthands. Must NOT contain: tests.

const assert = require('node:assert/strict');
const E = require('../../../server/games/warfront/engine');

// A small hand-made valid map: 9x5 plains, bases at the ends of the middle row.
function rawMap(overrides = {}) {
  const width = 9;
  const height = 5;
  return {
    theme: 'Test Field',
    lore: 'A test.',
    width,
    height,
    tiles: Array.from({ length: width * height }, () => ({ terrain: 'plains' })),
    bases: [{ team: 'red', x: 0, y: 2 }, { team: 'blue', x: 8, y: 2 }],
    supplySources: [{ x: 1, y: 2 }, { x: 7, y: 2 }],
    veins: [{ x: 4, y: 0, richness: 2, contested: true }],
    weapons: [{ x: 4, y: 4, weaponId: 'artillery' }],
    // One home lighthouse per base, one contested in the middle.
    lighthouses: [{ x: 2, y: 1 }, { x: 6, y: 1 }, { x: 4, y: 3 }],
    chokepoints: [{ x: 4, y: 2 }],
    ...overrides,
  };
}

const SIZE = { width: 9, height: 5 };

function setTerrain(raw, x, y, terrain) {
  raw.tiles[y * raw.width + x] = { terrain };
}

function assertRejects(raw, pattern) {
  assert.throws(() => E.validateMap(raw, SIZE), pattern);
}

/**
 * A tiny hand-made battle. `rows` are strings, one char per tile:
 * . plains  f forest  h hills  ~ water  # rock  R red base  B blue base  G green base  Y gold base.
 * `units` = [{ owner, type, at: [x, y], hold }]; owners are 'Red' (red), 'Blue' (blue), and for
 * free-for-all battles 'Green' (green) and 'Gold' (gold) when their base is on the map;
 * `hold` puts the unit on Hold (it never falls back).
 * Returns { st, at(x, y) -> tileId, unit(owner, i) }.
 */
function makeBattle({ rows, units = [], weapons = [], sources = [], veins = [], races = {} }) {
  const height = rows.length;
  const width = rows[0].length;
  const terrain = { '.': 'plains', f: 'forest', h: 'hills', '~': 'water', '#': 'rock', R: 'plains', B: 'plains', G: 'plains', Y: 'plains' };
  const baseChars = { R: 'red', B: 'blue', G: 'green', Y: 'gold' };
  const tiles = [];
  const bases = {};
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    tiles.push(terrain[ch]);
    if (baseChars[ch]) bases[baseChars[ch]] = E.tileId(x, y, width);
  }));
  const sides = E.SIDES.filter((side) => bases[side] != null);
  const ownerOf = (side) => side[0].toUpperCase() + side.slice(1);
  const map = {
    theme: 'Test', lore: '', width, height, tiles,
    bases: sides.map((team) => ({ team, tileId: bases[team] })),
    supplySources: sources.map(([x, y, team]) => ({ x, y, tileId: E.tileId(x, y, width), team })),
    veins: veins.map(([x, y, richness, contested]) => ({ x, y, tileId: E.tileId(x, y, width), richness, contested: Boolean(contested) })),
    chokepoints: [],
    weapons: weapons.map(([x, y, weaponId]) => ({ x, y, tileId: E.tileId(x, y, width), weaponId })),
  };
  const defaultRace = { Red: 'horde', Blue: 'forge', Green: 'arcane', Gold: 'horde' };
  const st = E.createBattleState(map, sides.map((team) => {
    const name = ownerOf(team);
    return { name, team, race: races[name] || defaultRace[name] };
  }), { seed: 7, now: 0 });
  for (const army of Object.values(st.armies)) army.units = [];
  for (const { owner, type, at, hold } of units) {
    const u = E.makeUnit(st.nextUnitId++, type, owner, E.tileId(at[0], at[1], width));
    if (hold) u.holding = true;
    st.armies[owner].units.push(u);
  }
  return {
    st,
    at: (x, y) => E.tileId(x, y, width),
    unit: (owner, i = 0) => st.armies[owner].units[i],
  };
}

/** Steps the sim from `from` to `to` (ms) in 200 ms ticks. */
function run(st, from, to, dt = 200) {
  let last = from;
  for (let now = from + dt; now <= to; now += dt) {
    E.stepSim(st, dt, { now });
    last = now;
  }
  // Land exactly on `to` even when it isn't on the dt grid (WF_STEP_MS_BASE isn't).
  if (last < to) E.stepSim(st, to - last, { now: to });
}

const move = (st, owner, ids, toTileId, now) => E.applyCommand(st, owner, { kind: 'move', unitIds: ids, toTileId }, now);

/** Runs the sim from `from` to `to` ms in 200 ms steps and returns every event. */
function fight(b, to, from = 0, dt = 200) {
  const events = [];
  for (let now = from + dt; now <= to; now += dt) events.push(...E.stepSim(b.st, dt, { now }).events);
  return events;
}

/** The damage of the first hit landing on `victimOwner`'s units, for each seed. */
function firstHitDamage(build, seeds, victimOwner = 'Blue') {
  return seeds.map((seed) => {
    const b = build();
    b.st.seed = seed;
    const hit = E.stepSim(b.st, 200, { now: 200 }).events.find((e) => e.type === 'underAttack' && e.owner === victimOwner);
    return hit.dmg;
  });
}

const SEEDS = Array.from({ length: 80 }, (_, i) => i * 7919 + 13);

const spread = (xs) => {
  const mean = xs.reduce((a, x) => a + x, 0) / xs.length;
  return (Math.max(...xs) - Math.min(...xs)) / mean;
};

const produce = (st, owner, unitType, now, atTileId) => E.applyCommand(st, owner, { kind: 'produce', unitType, atTileId }, now);

const haul = (st, owner, ids, veinTileId, now) => E.applyCommand(st, owner, { kind: 'haul', workerIds: ids, veinTileId }, now);

/** A battle with lighthouses: `lights` = [[x, y, team|null]]. */
function lightBattle({ rows, units = [], lights }) {
  const b = makeBattle({ rows, units });
  b.st.lighthouses = lights.map(([x, y, team]) => ({ tileId: b.at(x, y), team }));
  return b;
}

const build = (st, owner, facility, tileId, now = 0) => E.applyCommand(st, owner, { kind: 'build', facility, tileId }, now);

const craft = (st, owner, weaponId, now = 0) => E.applyCommand(st, owner, { kind: 'craft', weaponId }, now);

/** A finished structure standing on (x, y), as if it had been built long ago. */
function plantBuilt(b, owner, type, x, y) {
  const u = E.makeUnit(b.st.nextUnitId++, type, owner, b.at(x, y));
  b.st.armies[owner].units.push(u);
  b.st.armies[owner].facilities.push({ id: u.id, type, tileId: u.tileId });
  return u;
}

module.exports = {
  rawMap,
  SIZE,
  setTerrain,
  assertRejects,
  makeBattle,
  run,
  move,
  fight,
  firstHitDamage,
  SEEDS,
  spread,
  produce,
  haul,
  lightBattle,
  build,
  craft,
  plantBuilt,
};
