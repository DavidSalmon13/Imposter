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
    // (intra-hand sub-state lives in room.aiofHand.stage, not room.phase — the client stays on
    // the same table screen for the whole 'playing' phase; only aiofHand.stage changes the UI.)
    // Bluff phases: 'seating' | 'playing' | 'gameover'
    hostName: null,
    players: new Map(), // name -> { socketId, connected, role, word, hint, vote, team, leader, eliminatedReport }
    wordLanguage: 'english', // 'english' | 'hebrew' - language for ChatGPT-generated words/hints
    wordTheme: '', // optional free-text theme/topic injected into ChatGPT word-generation prompts
    currentLevel: null,
    lastImposterNames: [],
    usedWords: [],
    // Codenames fields moved to state.codenames (see server/games/codenames.js createState).
    // 10 Seconds fields moved to state.tenseconds (see server/games/tenseconds.js createState).
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
    // Music Timeline
    // Music Timeline phases: 'teamSelect' | 'ready' | 'generating' | 'placing' | 'locked' | 'revealed' | 'gameover'
    mtMode: null, // 'team' | 'solo'
    mtDifficulty: null, // 'easy' | 'pro' | 'expert'
    mtTeams: {}, // team id -> { name, timeline: [{ title, artist, releaseYear }, ...], tokens }
    mtActiveTeamIndex: 0,
    mtCurrentSong: null, // { title, artist, releaseYear } | null - pending song for the active team
    mtPendingPlacement: null, // { slotIndex } | null - active team's locked-but-not-revealed slot pick
    mtRevealResult: null, // { teamId, correct } | null - set at reveal, cleared at next turn/start
    mtIdConfirmed: false, // honor-system artist/title checkbox for the current reveal
    mtCurrentChallenge: null, // { team, placement } | null
    mtUsedSongs: [], // rolling avoid-list sent to ChatGPT
    mtRoundNumber: 0,
    mtMatchWinners: [],
    // Mind Meld
    // Mind Meld phases: 'ready' | 'pickingSubject' | 'generating' | 'answering' | 'revealed' | 'gameover'
    mmRotationOrder: [], // frozen shuffled array of player names, set once at match start
    mmRotationIndex: 0, // pointer into mmRotationOrder; current Subject is mmRotationOrder[mmRotationIndex]
    mmRoundNumber: 0, // increments each round that actually resolves
    mmCurrentQuestion: null, // current round's question text, or null between rounds
    mmAnswerDeadline: null, // epoch ms deadline for non-Subject players, or null
    mmAnswers: {}, // name -> submitted number for the current round (includes the Subject's)
    mmUsedQuestions: [], // rolling avoid-list sent to ChatGPT, windowed at MM_USED_QUESTIONS_AVOID_WINDOW
    mmScores: {}, // name -> cumulative points across the current match
    mmRotationsCompleted: 0, // increments each time mmRotationIndex wraps to 0
    // All-In or Fold
    aiofSeats: [null, null, null, null, null, null], // seatIndex -> name | null
    aiofStacks: {}, // name -> current chip stack, present once they've ever sat this match
    aiofBuyIns: {}, // name -> total buy-in count this match (starts at 1 on first sit)
    aiofSittingOut: {}, // name -> true if busted and declined rebuy (seat stays theirs)
    aiofDealerSeat: -1, // seat index; -1 until the first hand deals (starts at the host's seat)
    aiofEverSeated: [], // every name that has ever occupied a seat this match, for final ranking
    aiofHand: null, // { stage, deck, holeCards, board, revealedCount, contributions, folded,
                    //   actionOrder, actingIndex } while a hand is in progress; null between hands
    aiofResults: null, // last hand's brief outcome, shown during the auto-advance pause
    // Bluff + its betting state live under state.bluff / state.betting (migrated to namespaces;
    // see server/games/bluff.js createState and server/betting.js createState).
    // Shared scoreboard: name -> total points (survives disconnect/rejoin by name)
    scoreboard: {},
    // Imposter reporting/results (ephemeral for the round being scored)
    imposterRoundResults: null, // [{ name, role, eliminated, points }]
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
