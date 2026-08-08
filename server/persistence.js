const fs = require('fs');
const path = require('path');
const { rooms, createRoomState } = require('./roomStore');
const menifot = require('./games/menifot');
const tenseconds = require('./games/tenseconds');
const codenames = require('./games/codenames');
const imposter = require('./games/imposter');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
const SAVE_INTERVAL_MS = 5000;

// Kept as a plain hardcoded array for now (see refactor_plan §6 point 1 / Step 4).
// Later derived from each game module's savedFields via the registry.
const ROOM_SAVED_FIELDS = [
  'game',
  'phase',
  'hostName',
  'currentLevel',
  'lastImposterNames',
  'usedWords',
  'cnUsedWords',
  'cnBoard',
  'cnActiveTeam',
  'cnStartingTeam',
  'cnWinner',
  'cnScores',
  'cnTimerSeconds',
  'cnTurnEndsAt',
  'tsActivePlayers',
  'tsContenders',
  'tsEliminatedOrder',
  'tsRoundStartAt',
  'tsRoundResults',
  'tsRoundNumber',
  'tsSuddenDeath',
  'tsEliminationWaves',
  'mfPlayers',
  'mfBoardCount',
  'mfBoards',
  'mfHands',
  'mfBurned',
  'mfScores',
  'mfRoundNumber',
  'mfRoundResults',
  'mfMatchWinners',
  'scoreboard',
  'imposterRoundResults',
  'backgroundImage',
];

function saveRoomsToDisk() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const serialized = {};
    for (const [code, room] of rooms) {
      const data = { players: Array.from(room.players.entries()) };
      for (const field of ROOM_SAVED_FIELDS) data[field] = room[field];
      serialized[code] = data;
    }
    const tmpFile = `${ROOMS_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(serialized));
    fs.renameSync(tmpFile, ROOMS_FILE);
  } catch (err) {
    console.error('Failed to save rooms to disk:', err);
  }
}

/**
 * Load rooms from disk. Per-game mid-round repair delegates to each module's
 * repairOnLoad (shared ctx supplies rooms/io helpers when needed).
 */
function loadRoomsFromDisk(hooks = {}) {
  const { ctx } = hooks;

  if (!fs.existsSync(ROOMS_FILE)) return;
  try {
    const raw = fs.readFileSync(ROOMS_FILE, 'utf8');
    const serialized = JSON.parse(raw);
    for (const [code, data] of Object.entries(serialized)) {
      const room = createRoomState();
      for (const field of ROOM_SAVED_FIELDS) {
        if (data[field] !== undefined) room[field] = data[field];
      }
      room.players = new Map(
        (data.players || []).map(([name, p]) => [name, { ...p, connected: false, socketId: null }])
      );
      if (!room.scoreboard || typeof room.scoreboard !== 'object') room.scoreboard = {};
      if (!Array.isArray(room.tsEliminationWaves)) room.tsEliminationWaves = [];
      rooms.set(code, room);
      if (room.game === 'imposter') {
        imposter.repairOnLoad(ctx || { rooms }, room);
      }
      if (room.game === 'codenames') {
        codenames.repairOnLoad(ctx || { rooms }, room);
      }
      if (room.game === 'tenseconds') {
        tenseconds.repairOnLoad(ctx || { rooms }, room);
      }
      if (room.game === 'menifot') {
        menifot.repairOnLoad(null, room);
      }
    }
    console.log(`Loaded ${rooms.size} room(s) from ${ROOMS_FILE}`);
  } catch (err) {
    console.error('Failed to load rooms from disk:', err);
  }
}

module.exports = {
  DATA_DIR,
  ROOMS_FILE,
  SAVE_INTERVAL_MS,
  ROOM_SAVED_FIELDS,
  saveRoomsToDisk,
  loadRoomsFromDisk,
};
