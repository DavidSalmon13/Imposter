'use strict';

// Shared fixtures for the Warfront shell tests: rooms in each phase, an AI map, emission filters,
// unit planting. Must NOT contain: tests.

const warfront = require('../../../server/games/warfront');
const { createTestCtx, createRoom, makeHandlerSocket, registerGame, emissionsFor, mockOpenAi } = require('../../helpers/harness');
const engine = require('../../../server/games/warfront/engine');
const { rngFor } = require('../../../server/lib/rng');

const NAMES = ['Host', 'Ann', 'Bob', 'Cat'];

function setup({ phase = 'teamSelect', game = 'warfront', names = NAMES } = {}) {
  const { ctx, io, recordedResults } = createTestCtx();
  const room = createRoom(ctx, 'WFWF', names, { game, phase });
  const sockets = Object.fromEntries(
    names.map((n) => [n, registerGame(warfront, ctx, makeHandlerSocket('WFWF', n))]),
  );
  return { ctx, io, room, sockets, recordedResults };
}

/** Host + Ann on red, Bob + Cat on blue, everyone with a race. */
function readyRoom() {
  const s = setup();
  const { room } = s;
  for (const [n, team, race] of [['Host', 'red', 'forge'], ['Ann', 'red', 'horde'], ['Bob', 'blue', 'arcane'], ['Cat', 'blue', 'forge']]) {
    room.players.get(n).team = team;
    room.state.warfront.lobbyRaces[n] = race;
  }
  return s;
}

function lastWfState(io, room, name) {
  const list = emissionsFor(io, room, name).filter((e) => e.event === 'wfState');
  return list.length ? list[list.length - 1].payload : null;
}

/** A valid medium map in the spec's JSON shape, as OpenAI would return it. */
function aiMap(theme = 'Glass Canyon') {
  const m = engine.buildFallbackMap('medium', rngFor(99, 0));
  return {
    theme,
    lore: 'Shards of old glass glitter in the ravine.',
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

async function startWith(mock) {
  const s = readyRoom();
  const restore = mock();
  try {
    await warfront.generateBattle(s.ctx, 'WFWF', s.room);
  } finally {
    restore();
  }
  return s;
}

const wfLives = (io, room, name) => emissionsFor(io, room, name).filter((e) => e.event === 'wfLive');

async function playingRoom(t) {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
  return startWith(() => mockOpenAi(aiMap()));
}

const wfAlerts = (io, room, name) => emissionsFor(io, room, name).filter((e) => e.event === 'wfAlert');

/** A Blue (Bob) unit of `type` placed `tileId`, holding. */
function plant(wf, owner, type, tileId) {
  const u = engine.makeUnit(wf.nextUnitId++, type, owner, tileId);
  u.holding = true;
  wf.armies[owner].units.push(u);
  return u;
}

/** Two passable tiles in a row on plains, far from both bases: [a, b]. */
function openPair(wf) {
  const { map } = wf;
  for (let id = 0; id < map.width * map.height; id++) {
    const right = id + 1;
    if (id % map.width === map.width - 1) continue;
    if (map.tiles[id] !== 'plains' || map.tiles[right] !== 'plains') continue;
    const far = (t) => engine.manhattan(t, wf.bases.red.tileId, map.width) > 4 && engine.manhattan(t, wf.bases.blue.tileId, map.width) > 4;
    if (far(id) && far(right)) return [id, right];
  }
  throw new Error('no open pair on this map');
}

/** A tile beside `team`'s base on the same level, so melee there can hit it. */
function besideBase(wf, team) {
  const baseTile = wf.bases[team].tileId;
  return engine.neighbors(baseTile, wf.map.width, wf.map.height)
    .find((n) => engine.isPassable(wf.map, n) && engine.isHigh(wf.map, n) === engine.isHigh(wf.map, baseTile));
}

module.exports = {
  NAMES,
  setup,
  readyRoom,
  lastWfState,
  aiMap,
  startWith,
  wfLives,
  playingRoom,
  wfAlerts,
  plant,
  openPair,
  besideBase,
};
