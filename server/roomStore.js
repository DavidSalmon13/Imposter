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
    game: null, // null | 'imposter' | 'codenames' | 'tenseconds' | 'menifot'
    phase: 'lobby',
    // Imposter phases: 'voting' | 'generating' | 'playing' | 'reporting' | 'roundResults'
    // Codenames phases: 'teamSelect' | 'generating' | 'playing' | 'gameover'
    // 10 Seconds phases: 'ready' | 'running' | 'roundResults' | 'gameover'
    // Menifot phases: 'ready' | 'allocating' | 'roundResults' | 'gameover'
    hostName: null,
    players: new Map(), // name -> { socketId, connected, role, word, hint, vote, team, leader, eliminatedReport }
    wordLanguage: 'english', // 'english' | 'hebrew' - language for ChatGPT-generated words/hints
    wordTheme: '', // optional free-text theme/topic injected into ChatGPT word-generation prompts
    currentLevel: null,
    lastImposterNames: [],
    usedWords: [],
    cnUsedWords: [],
    cnBoard: null, // [{ word, color, revealed }]
    cnActiveTeam: null,
    cnStartingTeam: null,
    cnWinner: null,
    cnScores: { red: 0, blue: 0 },
    cnTimerSeconds: null, // null | 60 | 120
    cnTurnEndsAt: null, // epoch ms the current turn's timer expires at, or null when not counting down
    // 10 Seconds
    tsActivePlayers: [], // names still in the bracket
    tsContenders: [], // names racing the current round (subset during sudden death)
    tsEliminatedOrder: [], // elimination order (reversed for final standings)
    tsRoundStartAt: null, // epoch ms when stopwatches start (after 3s countdown)
    tsRoundResults: {}, // name -> { elapsedMs, distanceMs, dnf }
    tsRoundNumber: 0,
    tsSuddenDeath: false,
    tsEliminationWaves: [], // each entry = names eliminated together in one resolution step
    // Menifot
    mfPlayers: [], // frozen match roster
    mfBoardCount: 0, // 2 or 3, frozen at Start
    mfBoards: [], // [{ flop, turn, river, revealed }]
    mfHands: {}, // name -> { cards, allocation: { [boardIndex]: cards[] }, locked }
    mfBurned: [],
    mfScores: {}, // name -> cumulative board-win points this match
    mfRoundNumber: 0,
    mfRoundResults: null, // populated at reveal
    mfMatchWinners: [],
    // Shared scoreboard: name -> total points (survives disconnect/rejoin by name)
    scoreboard: {},
    // Imposter reporting/results (ephemeral for the round being scored)
    imposterRoundResults: null, // [{ name, role, eliminated, points }]
    backgroundImage: null,
  };
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
  normalizeRoomCode,
  generateRoomCode,
  getRoom,
  roomEmit,
  ROOM_CODE_LENGTH,
};
