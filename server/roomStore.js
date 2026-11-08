/** @type {import('socket.io').Server | null} */
let io = null;

/** @type {Map<string, object>} */
const rooms = new Map();

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 4;

function initRoomStore(ioInstance) {
  io = ioInstance;
}

function createRoomState() {
  return {
    game: null, // null | 'imposter' | 'codenames' | 'tenseconds' | 'menifot' | 'bluff'
    phase: 'lobby',
    // Imposter phases: 'voting' | 'generating' | 'playing' | 'reporting' | 'roundResults'
    // Codenames phases: 'teamSelect' | 'generating' | 'playing' | 'gameover'
    // 10 Seconds phases: 'ready' | 'running' | 'roundResults' | 'gameover'
    // Menifot phases: 'ready' | 'allocating' | 'roundResults' | 'gameover'
    // All-In or Fold phases: 'seating' | 'playing' | 'gameover'
    // (intra-hand sub-state lives in room.state.allinorfold.hand.stage, not room.phase — the client stays on
    // the same table screen for the whole 'playing' phase; only that hand.stage changes the UI.)
    // Bluff phases: 'seating' | 'playing' | 'gameover'
    hostName: null,
    players: new Map(), // name -> { socketId, connected, role, word, hint, vote, team, leader, eliminatedReport }
    wordLanguage: 'english', // 'english' | 'hebrew' - language for ChatGPT-generated words/hints
    wordTheme: '', // optional free-text theme/topic injected into ChatGPT word-generation prompts
    // Imposter fields moved to state.imposter (see server/games/imposter.js createState).
    // Codenames fields moved to state.codenames (see server/games/codenames.js createState).
    // 10 Seconds fields moved to state.tenseconds (see server/games/tenseconds.js createState).
    // Menifot fields moved to state.menifot (see server/games/menifot.js createState).
    // Music Timeline phases: 'teamSelect' | 'ready' | 'generating' | 'placing' | 'locked' | 'revealed' | 'gameover'
    // Music Timeline fields moved to state.musictimeline (see server/games/musicTimeline.js createState).
    // Mind Meld phases: 'ready' | 'pickingSubject' | 'generating' | 'answering' | 'revealed' | 'gameover'
    // Mind Meld fields moved to state.mindmeld (see server/games/mindMeld.js createState).
    // All-In or Fold fields moved to state.allinorfold (see server/games/allInOrFold.js createState).
    // Bluff + its betting state live under state.bluff / state.betting (migrated to namespaces;
    // see server/games/bluff.js createState and server/betting.js createState).
    // Shared scoreboard: name -> total points (survives disconnect/rejoin by name)
    scoreboard: {},
    backgroundImage: null,
    // Per-game namespaced state. As each game migrates off its flat prefix, its fields
    // move under state[gameId] (populated by gameRegistry.initGameState); see
    // plans/yes-sketch-a-low-risk-quiet-chipmunk.md.
    state: {},
  };
}

/**
 * Lazily initialize a migrated game's state namespace. Idempotent: existing state (e.g.
 * assigned during a disk load) is left untouched, so this is safe to call on every room
 * creation path (lobby, persistence load, tests).
 */
function ensureGameState(room, gameId, createState) {
  if (!room.state) room.state = {};
  if (!room.state[gameId]) room.state[gameId] = createState();
  return room.state[gameId];
}

function normalizeRoomCode(code) {
  return String(code || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function generateRoomCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    }
    if (!rooms.has(code)) return code;
  }
  throw new Error('Could not allocate a room code');
}

function getRoom(socket) {
  const code = socket.data.roomCode;
  return code ? rooms.get(code) : null;
}

function roomEmit(roomCode, event, payload) {
  io.to(roomCode).emit(event, payload);
}

module.exports = {
  rooms,
  initRoomStore,
  createRoomState,
  ensureGameState,
  normalizeRoomCode,
  generateRoomCode,
  getRoom,
  roomEmit,
  ROOM_CODE_LENGTH,
};
