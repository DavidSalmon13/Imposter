const { ensureGameState } = require('./roomStore');

const imposter = require('./games/imposter');
const codenames = require('./games/codenames');
const tenseconds = require('./games/tenseconds');
const menifot = require('./games/menifot');
const musictimeline = require('./games/musicTimeline');
const allinorfold = require('./games/allInOrFold');
const mindmeld = require('./games/mindMeld');
const bluff = require('./games/bluff');
const warfront = require('./games/warfront');

const GAMES = {
  imposter,
  codenames,
  tenseconds,
  menifot,
  musictimeline,
  allinorfold,
  mindmeld,
  bluff,
  warfront,
};

/**
 * A game is "migrated" once it owns its state under room.state[id] via a createState() factory
 * (see docs/plans/yes-sketch-a-low-risk-quiet-chipmunk.md). Un-migrated games still keep their flat
 * room.<prefix>* fields. Both styles coexist during the rollout, so these lists are derived
 * rather than hardcoded.
 *
 * A migrated game exports `namespaces`: an array of { id, createState, savedFields } descriptors.
 * Most games declare exactly one; a game may declare more to own a cross-cutting namespace
 * (e.g. Bluff owns both 'bluff' and 'betting'). `savedFields` lists the keys within that
 * namespace to persist (omit for fully-ephemeral namespaces).
 */
const ALL_NAMESPACES = Object.values(GAMES).flatMap((g) =>
  Array.isArray(g.namespaces) ? g.namespaces : []
);

/** Shared room fields persisted alongside each game module's savedFields. */
const SHARED_SAVED_FIELDS = [
  'game',
  'phase',
  'hostName',
  'scoreboard',
  'backgroundImage',
  'wordLanguage',
  'wordTheme',
];

// Flat top-level fields to persist: shared fields plus the savedFields of games still using
// the flat layout. Migrated games persist through NAMESPACED_SAVED instead.
const ROOM_SAVED_FIELDS = [
  ...SHARED_SAVED_FIELDS,
  ...Object.values(GAMES).flatMap((g) => (Array.isArray(g.namespaces) ? [] : g.savedFields || [])),
];

// namespace id -> keys within room.state[id] to persist. Built from migrated games' descriptors.
const NAMESPACED_SAVED = Object.fromEntries(
  ALL_NAMESPACES.filter((ns) => Array.isArray(ns.savedFields)).map((ns) => [ns.id, ns.savedFields])
);

/** Populate every migrated game's state namespace on a freshly created or loaded room. */
function initGameState(room) {
  for (const ns of ALL_NAMESPACES) {
    ensureGameState(room, ns.id, ns.createState);
  }
  return room;
}

function getGame(id) {
  return (id && GAMES[id]) || null;
}

function registerAllHandlers(ctx, io, socket) {
  for (const game of Object.values(GAMES)) {
    game.registerHandlers(ctx, io, socket);
  }
}

function clearAllGameState(room, roomCode) {
  for (const game of Object.values(GAMES)) {
    if (typeof game.clearState === 'function') {
      game.clearState(room, roomCode);
    }
  }
}

function repairRoomOnLoad(ctx, room) {
  const game = getGame(room.game);
  if (game && typeof game.repairOnLoad === 'function') {
    game.repairOnLoad(ctx, room);
  }
}

module.exports = {
  GAMES,
  SHARED_SAVED_FIELDS,
  ROOM_SAVED_FIELDS,
  NAMESPACED_SAVED,
  initGameState,
  getGame,
  registerAllHandlers,
  clearAllGameState,
  repairRoomOnLoad,
};
