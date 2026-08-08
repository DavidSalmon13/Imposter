const fs = require('fs');
const path = require('path');
const { rooms, createRoomState } = require('./roomStore');
const menifot = require('./games/menifot');
const tenseconds = require('./games/tenseconds');

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
 * Load rooms from disk. Game-specific mid-round repair still lives here for now
 * but calls into helpers that remain in server.js (injected as hooks) until each
 * game module owns repairOnLoad.
 */
function loadRoomsFromDisk(hooks = {}) {
  const {
    playersInImposterRound,
    finishImposterReporting,
    cnTimerExpired,
    cnTimerHandles,
    ctx,
  } = hooks;

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
      // A round that was mid-generation when the process stopped can't be resumed - drop back
      // to the nearest safe phase so reconnecting players land somewhere sane.
      if (room.phase === 'generating') {
        if (room.game === 'imposter') {
          room.phase = 'voting';
          room.currentLevel = null;
          for (const p of room.players.values()) p.vote = null;
        } else if (room.game === 'codenames') {
          room.phase = 'teamSelect';
        }
      }
      if (!room.scoreboard || typeof room.scoreboard !== 'object') room.scoreboard = {};
      if (!Array.isArray(room.tsEliminationWaves)) room.tsEliminationWaves = [];
      // After restart everyone is disconnected; default unanswered Imposter reports so
      // reporting can't hang forever waiting for answers that will never arrive.
      if (room.game === 'imposter' && room.phase === 'reporting') {
        for (const name of playersInImposterRound(room)) {
          const p = room.players.get(name);
          if (p && (p.eliminatedReport === null || p.eliminatedReport === undefined)) {
            p.eliminatedReport = true;
          }
        }
      }
      rooms.set(code, room);
      // Live setTimeout handles don't survive a restart. A saved deadline is an absolute
      // timestamp though, so we can just pick back up from it (or expire it immediately
      // if the process was down past the deadline).
      if (room.game === 'codenames' && room.phase === 'playing' && room.cnTimerSeconds && room.cnTurnEndsAt) {
        const remaining = room.cnTurnEndsAt - Date.now();
        if (remaining <= 0) {
          cnTimerExpired(code);
        } else {
          cnTimerHandles.set(code, setTimeout(() => cnTimerExpired(code), remaining));
        }
      }
      if (room.game === 'tenseconds') {
        tenseconds.repairOnLoad(ctx || { rooms }, room);
      }
      if (room.game === 'menifot') {
        menifot.repairOnLoad(null, room);
      }
      // If reporting was fully defaulted on restart, resolve it once everyone reconnects —
      // or immediately if all answers are already filled.
      if (room.game === 'imposter' && room.phase === 'reporting') {
        const names = playersInImposterRound(room);
        const allAnswered =
          names.length > 0 &&
          names.every((n) => {
            const p = room.players.get(n);
            return p && p.eliminatedReport !== null && p.eliminatedReport !== undefined;
          });
        if (allAnswered) finishImposterReporting(code, room);
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
