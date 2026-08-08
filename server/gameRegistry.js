const imposter = require('./games/imposter');
const codenames = require('./games/codenames');
const tenseconds = require('./games/tenseconds');
const menifot = require('./games/menifot');

const GAMES = {
  imposter,
  codenames,
  tenseconds,
  menifot,
};

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

const ROOM_SAVED_FIELDS = [
  ...SHARED_SAVED_FIELDS,
  ...Object.values(GAMES).flatMap((g) => g.savedFields || []),
];

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
  getGame,
  registerAllHandlers,
  clearAllGameState,
  repairRoomOnLoad,
};
