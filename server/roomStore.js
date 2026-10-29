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
    cnUsedWords: [],
    cnBoard: null, // [{ word, color, revealed }]
    cnActiveTeam: null,
    cnStartingTeam: null,
    cnWinner: null,
    cnScores: { red: 0, blue: 0 },
    cnTimerSeconds: null, // null | 60 | 120
    cnTurnEndsAt: null, // epoch ms the current turn's timer expires at, or null when not counting down
    cnNameBank: [], // room-curated words any player can add; a few are randomly mixed into each board
    cnBankPickCount: null, // null = default (CN_BANK_PICK_COUNT); host-adjustable count of bank words per board
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
    // Bluff
    bfPlayers: [], // frozen match roster, fixed order = round-table seat order
    bfCounts: {}, // name -> current card count, persists across rounds, 0 on elimination
    bfPendingStartCount: 0, // seating-phase slider value, chosen before Start Match freezes it
    bfRoundNumber: 0, // current round number, display-only
    bfEliminationOrder: [], // names in the order they hit 0 cards, oldest first
    bfHands: {}, // name -> this round's dealt cards (NOT persisted, see ROOM_SAVED_FIELDS below)
    bfLastResult: null, // { loserName, newCount, eliminated } during the highlight/deal pause (NOT persisted)
    bfCheck: null, // { id, ranks, label, revealAt, present } for the host's "are the called cards there?" check (NOT persisted)
    bfRevealed: [], // names who showed this round's hand to the whole table (NOT persisted)
    bfEditing: false, // host is adjusting card counts via Edit Game (NOT persisted)
    bfEditCounts: {}, // name -> draft count while bfEditing (NOT persisted)
    // Tokens & betting (Bluff only, see plans/betting-implementation-plan.md section 6) - both
    // match-scoped and NOT persisted; settled balances/bets live in Postgres instead.
    betGlobalWindows: {}, // trigger -> { eligible, offerTo, responded }
    betSideProposals: {}, // roundNumber -> [{ id, bettorName, userId, pick, stake, targetName }]
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
