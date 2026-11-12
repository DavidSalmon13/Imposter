'use strict';

const { shuffle } = require('../lib/shuffle');
const { chatCompletionJson } = require('../lib/openai');

const CN_MIN_PLAYERS = 4;
const CN_MIN_TEAM_SIZE = 2;
const CN_WORD_COUNT = 25;
const CN_START_COUNT = 8;
const CN_OTHER_COUNT = 7;
const CN_ASSASSIN_COUNT = 1;
const CN_NEUTRAL_COUNT = CN_WORD_COUNT - CN_START_COUNT - CN_OTHER_COUNT - CN_ASSASSIN_COUNT;
const CN_TIMER_OPTIONS = [0, 60, 120]; // seconds; 0 = no timer
const CN_NAME_BANK_WORD_MAX_LEN = 30;
const CN_NAME_BANK_LIMIT = 200;
const CN_BANK_PICK_COUNT = 2; // default count of bank words mixed into a board
const CN_BANK_PICK_MAX = 10; // host-adjustable upper bound

// Keys within room.state.codenames to persist (see docs/plans/yes-sketch-a-low-risk-quiet-chipmunk.md).
const SAVED_FIELDS = [
  'usedWords',
  'board',
  'activeTeam',
  'startingTeam',
  'winner',
  'scores',
  'timerSeconds',
  'turnEndsAt',
  'nameBank',
  'bankPickCount',
];

/** Codenames' namespaced room state. Replaces the former flat room.cn* fields. */
function createState() {
  return {
    usedWords: [],
    board: null, // [{ word, color, revealed }]
    activeTeam: null,
    startingTeam: null,
    winner: null,
    scores: { red: 0, blue: 0 },
    timerSeconds: null, // null | 60 | 120
    turnEndsAt: null, // epoch ms the current turn's timer expires at, or null when not counting down
    nameBank: [], // room-curated words any player can add; a few are randomly mixed into each board
    bankPickCount: null, // null = default (CN_BANK_PICK_COUNT); host-adjustable count of bank words per board
  };
}

/** @type {Map<string, NodeJS.Timeout>} */
const cnTimerHandles = new Map();

function clearCnTimerHandle(roomCode) {
  const handle = cnTimerHandles.get(roomCode);
  if (handle) clearTimeout(handle);
  cnTimerHandles.delete(roomCode);
}

function clearState(room, roomCode) {
  if (roomCode) clearCnTimerHandle(roomCode);
  // Reset the board/scores but keep the room's rolling word avoid-list and its curated
  // name bank, which persist across games in the same room.
  const { usedWords, nameBank } = room.state.codenames;
  room.state.codenames = createState();
  Object.assign(room.state.codenames, { usedWords, nameBank });
}

function startCnTimer(ctx, roomCode, room) {
  clearCnTimerHandle(roomCode);
  if (!room.state.codenames.timerSeconds) {
    room.state.codenames.turnEndsAt = null;
    return;
  }
  room.state.codenames.turnEndsAt = Date.now() + room.state.codenames.timerSeconds * 1000;
  cnTimerHandles.set(
    roomCode,
    setTimeout(() => cnTimerExpired(ctx, roomCode), room.state.codenames.timerSeconds * 1000)
  );
}

function cnTimerExpired(ctx, roomCode) {
  const room = ctx.rooms.get(roomCode);
  if (!room || room.game !== 'codenames' || room.phase !== 'playing') return;
  room.state.codenames.activeTeam = room.state.codenames.activeTeam === 'red' ? 'blue' : 'red';
  startCnTimer(ctx, roomCode, room); // subsequent turns start automatically
  broadcastCodenamesState(ctx, roomCode, room);
}

function teamMembers(ctx, room, color) {
  return ctx.connectedNames(room).filter((n) => room.players.get(n).team === color);
}

function teamPlayersInfo(ctx, room, color) {
  return teamMembers(ctx, room, color).map((n) => ({
    name: n,
    leader: room.players.get(n).leader,
  }));
}

function broadcastTeamSelect(ctx, roomCode, room) {
  ctx.roomEmit(roomCode, 'teamSelectUpdate', {
    host: room.hostName,
    red: teamPlayersInfo(ctx, room, 'red'),
    blue: teamPlayersInfo(ctx, room, 'blue'),
    unassigned: ctx.connectedNames(room).filter((n) => !room.players.get(n).team),
    timerSeconds: room.state.codenames.timerSeconds || 0,
    wordTheme: room.wordTheme || '',
    nameBank: room.state.codenames.nameBank || [],
    bankPickCount: resolveBankPickCount(room),
    bankPickMax: CN_BANK_PICK_MAX,
  });
}

function cnTeamValid(ctx, room, color) {
  const members = teamMembers(ctx, room, color);
  return members.length >= CN_MIN_TEAM_SIZE && members.some((n) => room.players.get(n).leader);
}

function pickFromNameBank(bank, count) {
  if (!bank || bank.length === 0) return [];
  return shuffle(bank).slice(0, Math.min(count, bank.length));
}

function clampBankPickCount(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return CN_BANK_PICK_COUNT;
  return Math.max(0, Math.min(CN_BANK_PICK_MAX, n));
}

function resolveBankPickCount(room) {
  return room.state.codenames.bankPickCount == null ? CN_BANK_PICK_COUNT : room.state.codenames.bankPickCount;
}

async function generateWordGrid(room, count, avoidExtra = []) {
  const avoid = [...room.state.codenames.usedWords.slice(-100), ...avoidExtra];
  const languageInstruction =
    room.wordLanguage === 'hebrew' ? ' Write every word in Hebrew.' : '';
  const theme = (room.wordTheme || '').trim();
  const themeInstruction = theme
    ? ` All words must be related or loosely related to this theme: "${theme}". Mix directly obvious words ` +
      `with more loosely-associated ones - not every word should be the single most obvious item for the theme.`
    : ` Covering a broad mix of categories (objects, animals, food, places, jobs, nature, sports, tools, ` +
      `clothing, etc).`;
  const prompt =
    `Generate exactly ${count} common, family-friendly, single-word nouns suitable for a word-guessing ` +
    `party game grid. Each must be ONE word (no phrases, no proper nouns), instantly recognizable to most ` +
    `adults.${themeInstruction} All ${count} words must be different from each other.${languageInstruction}` +
    (avoid.length
      ? ` These words were used recently - avoid all of them: ${avoid.join(', ')}.`
      : '') +
    ` Respond with ONLY compact JSON in the form {"words": ["...", ...]} with exactly ${count} items.`;

  const parsed = await chatCompletionJson(prompt, { temperature: 1.1 });
  const rawWords = Array.isArray(parsed.words) ? parsed.words : [];
  const words = rawWords.map((w) => String(w || '').trim()).filter(Boolean);

  const seen = new Set();
  const unique = [];
  for (const w of words) {
    const key = w.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(w);
  }

  if (unique.length < count) {
    throw new Error('Incomplete word grid from OpenAI');
  }

  return unique.slice(0, count);
}

function buildBoard(words, startingTeam) {
  const otherTeam = startingTeam === 'red' ? 'blue' : 'red';
  const colors = shuffle([
    ...Array(CN_START_COUNT).fill(startingTeam),
    ...Array(CN_OTHER_COUNT).fill(otherTeam),
    ...Array(CN_ASSASSIN_COUNT).fill('assassin'),
    ...Array(CN_NEUTRAL_COUNT).fill('neutral'),
  ]);
  return words.map((word, i) => ({ word, color: colors[i], revealed: false }));
}

// Counted server-side because non-leaders' boards hide unrevealed colors.
function cardsRemaining(room) {
  const remaining = { red: 0, blue: 0 };
  for (const cell of room.state.codenames.board) {
    if (!cell.revealed && (cell.color === 'red' || cell.color === 'blue')) remaining[cell.color] += 1;
  }
  return remaining;
}

function boardForViewer(room, p) {
  return room.state.codenames.board.map((cell) => {
    if (cell.revealed || p.leader) {
      return { word: cell.word, color: cell.color, revealed: cell.revealed };
    }
    return { word: cell.word, color: null, revealed: false };
  });
}

function broadcastCodenamesState(ctx, roomCode, room) {
  for (const [, p] of room.players) {
    if (!p.connected) continue;
    ctx.io.to(p.socketId).emit('codenamesState', {
      phase: room.phase,
      activeTeam: room.state.codenames.activeTeam,
      winner: room.state.codenames.winner,
      scores: room.state.codenames.scores,
      board: boardForViewer(room, p),
      remaining: cardsRemaining(room),
      isLeader: p.leader,
      myTeam: p.team,
      red: teamPlayersInfo(ctx, room, 'red'),
      blue: teamPlayersInfo(ctx, room, 'blue'),
      host: room.hostName,
      timerSeconds: room.state.codenames.timerSeconds || 0,
      turnEndsAt: room.state.codenames.turnEndsAt,
      scoreboard: room.phase === 'gameover' ? ctx.scoreboardEntries(room) : undefined,
    });
  }
}

function failCodenamesRound(ctx, roomCode, room, error) {
  room.phase = 'teamSelect';
  clearCnTimerHandle(roomCode);
  room.state.codenames.turnEndsAt = null;
  broadcastTeamSelect(ctx, roomCode, room);
  ctx.roomEmit(roomCode, 'codenamesStartFailed', { error });
}

function checkTeamWin(room) {
  for (const color of ['red', 'blue']) {
    const remaining = room.state.codenames.board.filter((c) => c.color === color && !c.revealed);
    if (remaining.length === 0) return color;
  }
  return null;
}

function awardCodenamesScores(ctx, room) {
  if (!room.state.codenames.winner) return;
  const participants = [];
  for (const [name, p] of room.players.entries()) {
    if (!p.team) continue;
    const won = p.team === room.state.codenames.winner;
    if (won) ctx.addScore(room, name, 2);
    // Losing team gets 0 — no scoreboard write needed.
    participants.push({
      name,
      role: p.leader ? 'spymaster' : 'operative',
      team: p.team,
      won,
      points: won ? 2 : 0,
    });
  }
  ctx.recordGameResult(room, 'codenames', participants);
}

function finishCodenamesGame(ctx, roomCode, room) {
  room.phase = 'gameover';
  if (room.state.codenames.winner) room.state.codenames.scores[room.state.codenames.winner] += 1;
  awardCodenamesScores(ctx, room);
  clearCnTimerHandle(roomCode);
  room.state.codenames.turnEndsAt = null;
  broadcastCodenamesState(ctx, roomCode, room);
}

async function generateCodenamesRound(ctx, roomCode, room) {
  room.phase = 'generating';
  ctx.roomEmit(roomCode, 'generating', { game: 'codenames' });

  const bankPicks = pickFromNameBank(room.state.codenames.nameBank, resolveBankPickCount(room));
  let aiWords;
  try {
    aiWords = await generateWordGrid(room, CN_WORD_COUNT - bankPicks.length, bankPicks);
  } catch (err) {
    console.error('generateWordGrid failed:', err.message);
    return failCodenamesRound(
      ctx,
      roomCode,
      room,
      'Could not reach ChatGPT to build the board. Please try starting again.'
    );
  }

  if (!ctx.rooms.has(roomCode) || ctx.rooms.get(roomCode) !== room) return;

  if (!cnTeamValid(ctx, room, 'red') || !cnTeamValid(ctx, room, 'blue')) {
    return failCodenamesRound(ctx, roomCode, room, 'Not enough players remained on a team.');
  }

  const words = shuffle([...aiWords, ...bankPicks]);
  for (const w of aiWords) room.state.codenames.usedWords.push(w);
  if (room.state.codenames.usedWords.length > 150) room.state.codenames.usedWords.splice(0, room.state.codenames.usedWords.length - 150);

  room.state.codenames.board = buildBoard(words, room.state.codenames.startingTeam);
  room.state.codenames.activeTeam = room.state.codenames.startingTeam;
  room.state.codenames.winner = null;
  room.phase = 'playing';
  // The first turn of a round waits for the active team to press "Start Timer" so
  // the leader has time to study the board before the clock starts.
  clearCnTimerHandle(roomCode);
  room.state.codenames.turnEndsAt = null;
  broadcastCodenamesState(ctx, roomCode, room);
}

function onChoose(ctx, roomCode, room) {
  room.phase = 'teamSelect';
  broadcastTeamSelect(ctx, roomCode, room);
}

function reconnectPayload(ctx, room, existingPlayer) {
  if (room.phase === 'teamSelect') {
    return {
      ok: true,
      game: room.game,
      phase: room.phase,
      host: room.hostName,
      red: teamPlayersInfo(ctx, room, 'red'),
      blue: teamPlayersInfo(ctx, room, 'blue'),
      unassigned: ctx.connectedNames(room).filter((n) => !room.players.get(n).team),
      timerSeconds: room.state.codenames.timerSeconds || 0,
      wordTheme: room.wordTheme || '',
      nameBank: room.state.codenames.nameBank || [],
      bankPickCount: resolveBankPickCount(room),
      bankPickMax: CN_BANK_PICK_MAX,
    };
  }
  if (room.phase === 'generating') {
    return { ok: true, game: room.game, phase: room.phase, host: room.hostName };
  }
  if (room.phase === 'playing' || room.phase === 'gameover') {
    return {
      ok: true,
      game: room.game,
      phase: room.phase,
      host: room.hostName,
      activeTeam: room.state.codenames.activeTeam,
      winner: room.state.codenames.winner,
      scores: room.state.codenames.scores,
      board: boardForViewer(room, existingPlayer),
      remaining: cardsRemaining(room),
      isLeader: existingPlayer.leader,
      myTeam: existingPlayer.team,
      red: teamPlayersInfo(ctx, room, 'red'),
      blue: teamPlayersInfo(ctx, room, 'blue'),
      timerSeconds: room.state.codenames.timerSeconds || 0,
      turnEndsAt: room.state.codenames.turnEndsAt,
      scoreboard: room.phase === 'gameover' ? ctx.scoreboardEntries(room) : undefined,
    };
  }
  return {
    ok: true,
    game: room.game,
    phase: room.phase,
    host: room.hostName,
  };
}

function onDisconnect(ctx, roomCode, room, _name) {
  if (room.phase === 'teamSelect') {
    broadcastTeamSelect(ctx, roomCode, room);
  } else if (room.phase === 'playing' || room.phase === 'gameover') {
    broadcastCodenamesState(ctx, roomCode, room);
  }
}

function onReconnectBroadcast(ctx, roomCode, room) {
  if (room.phase === 'teamSelect') {
    broadcastTeamSelect(ctx, roomCode, room);
  } else if (room.phase === 'playing' || room.phase === 'gameover') {
    broadcastCodenamesState(ctx, roomCode, room);
  }
}

function repairOnLoad(ctx, room) {
  if (room.phase === 'generating') {
    room.phase = 'teamSelect';
  }
  if (room.phase !== 'playing' || !room.state.codenames.timerSeconds || !room.state.codenames.turnEndsAt || !ctx || !ctx.rooms) {
    return;
  }

  let roomCode = null;
  for (const [code, r] of ctx.rooms.entries()) {
    if (r === room) {
      roomCode = code;
      break;
    }
  }
  if (!roomCode) return;

  const remaining = room.state.codenames.turnEndsAt - Date.now();
  if (remaining <= 0) {
    cnTimerExpired(ctx, roomCode);
  } else {
    cnTimerHandles.set(
      roomCode,
      setTimeout(() => cnTimerExpired(ctx, roomCode), remaining)
    );
  }
}

function registerHandlers(ctx, io, socket) {
  socket.on('joinTeam', (color, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'codenames' || room.phase !== 'teamSelect') {
      return callback({ ok: false, error: 'Not choosing teams right now' });
    }
    if (color !== 'red' && color !== 'blue') return callback({ ok: false, error: 'Invalid team' });

    const name = socket.data.name;
    const p = room.players.get(name);
    if (!p) return callback({ ok: false, error: 'Not joined' });

    if (p.team !== color) {
      p.team = color;
      p.leader = false;
    }
    callback({ ok: true });
    broadcastTeamSelect(ctx, roomCode, room);
  });

  socket.on('claimLeader', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'codenames' || room.phase !== 'teamSelect') {
      return callback({ ok: false, error: 'Not choosing teams right now' });
    }

    const name = socket.data.name;
    const p = room.players.get(name);
    if (!p || !p.team) return callback({ ok: false, error: 'Join a team first' });

    const currentLeader = teamMembers(ctx, room, p.team).find((n) => room.players.get(n).leader);
    if (currentLeader && currentLeader !== name) {
      return callback({ ok: false, error: 'This team already has a leader' });
    }

    p.leader = true;
    callback({ ok: true });
    broadcastTeamSelect(ctx, roomCode, room);
  });

  socket.on('randomizeCnTeams', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'codenames' || room.phase !== 'teamSelect') {
      return callback({ ok: false, error: 'Not choosing teams right now' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can randomize teams' });
    }

    // Alternate over a shuffled roster so sizes differ by at most one; which
    // team gets the odd player out is itself random. Leaders are cleared since
    // the teams they led no longer exist.
    const first = Math.random() < 0.5 ? 'red' : 'blue';
    const second = first === 'red' ? 'blue' : 'red';
    shuffle(ctx.connectedNames(room)).forEach((name, i) => {
      const p = room.players.get(name);
      p.team = i % 2 === 0 ? first : second;
      p.leader = false;
    });
    callback({ ok: true });
    broadcastTeamSelect(ctx, roomCode, room);
  });

  socket.on('setCnTimer', (seconds, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'codenames' || room.phase !== 'teamSelect') {
      return callback({ ok: false, error: 'Not choosing teams right now' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can set the timer' });
    }
    const value = Number(seconds);
    if (!CN_TIMER_OPTIONS.includes(value)) return callback({ ok: false, error: 'Invalid timer option' });

    room.state.codenames.timerSeconds = value || null;
    callback({ ok: true });
    broadcastTeamSelect(ctx, roomCode, room);
  });

  socket.on('setCnBankPickCount', (count, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'codenames' || room.phase !== 'teamSelect') {
      return callback({ ok: false, error: 'Not choosing teams right now' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can set the bank word count' });
    }

    room.state.codenames.bankPickCount = clampBankPickCount(count);
    callback({ ok: true });
    broadcastTeamSelect(ctx, roomCode, room);
  });

  socket.on('setWordTheme', (theme, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'codenames' || room.phase !== 'teamSelect') {
      return callback({ ok: false, error: 'Not choosing teams right now' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can set the word theme' });
    }
    if (typeof theme !== 'string') return callback({ ok: false, error: 'Invalid theme' });

    room.wordTheme = theme.replace(/\s+/g, ' ').trim().slice(0, 100);
    callback({ ok: true });
    broadcastTeamSelect(ctx, roomCode, room);
  });

  socket.on('addCnNameBankWord', (word, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (typeof word !== 'string') return callback({ ok: false, error: 'Invalid word' });

    const cleaned = word.replace(/\s+/g, ' ').trim().slice(0, CN_NAME_BANK_WORD_MAX_LEN);
    if (!cleaned) return callback({ ok: false, error: 'Enter a word' });
    if (room.state.codenames.nameBank.some((w) => w.toLowerCase() === cleaned.toLowerCase())) {
      return callback({ ok: false, error: 'Already in the list' });
    }
    if (room.state.codenames.nameBank.length >= CN_NAME_BANK_LIMIT) {
      return callback({ ok: false, error: `List is full (max ${CN_NAME_BANK_LIMIT})` });
    }

    room.state.codenames.nameBank.push(cleaned);
    callback({ ok: true });
    if (room.phase === 'teamSelect') broadcastTeamSelect(ctx, roomCode, room);
  });

  socket.on('startCodenames', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'codenames' || room.phase !== 'teamSelect') {
      return callback({ ok: false, error: 'Not ready to start' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can start the game' });
    }
    if (!cnTeamValid(ctx, room, 'red')) {
      return callback({ ok: false, error: 'Red team needs at least 2 players including a leader' });
    }
    if (!cnTeamValid(ctx, room, 'blue')) {
      return callback({ ok: false, error: 'Blue team needs at least 2 players including a leader' });
    }

    room.state.codenames.startingTeam = Math.random() < 0.5 ? 'red' : 'blue';
    callback({ ok: true });
    generateCodenamesRound(ctx, roomCode, room);
  });

  socket.on('startCnTurnTimer', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'codenames' || room.phase !== 'playing') {
      return callback({ ok: false, error: 'Not playing right now' });
    }
    if (!room.state.codenames.timerSeconds) return callback({ ok: false, error: 'No timer set for this game' });
    if (room.state.codenames.turnEndsAt) return callback({ ok: false, error: 'Timer already running' });

    const name = socket.data.name;
    const p = room.players.get(name);
    if (!p || p.team !== room.state.codenames.activeTeam) {
      return callback({ ok: false, error: 'Only the active team can start the timer' });
    }

    startCnTimer(ctx, roomCode, room);
    callback({ ok: true });
    broadcastCodenamesState(ctx, roomCode, room);
  });

  socket.on('guessWord', (index, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'codenames' || room.phase !== 'playing') {
      return callback({ ok: false, error: 'Not playing right now' });
    }
    if (room.state.codenames.timerSeconds && !room.state.codenames.turnEndsAt) {
      return callback({ ok: false, error: 'Waiting for the timer to start' });
    }

    const name = socket.data.name;
    const p = room.players.get(name);
    if (!p) return callback({ ok: false, error: 'Not joined' });
    if (p.team !== room.state.codenames.activeTeam) return callback({ ok: false, error: "Not your team's turn" });
    if (p.leader) return callback({ ok: false, error: 'Leaders cannot guess' });
    if (!Number.isInteger(index) || index < 0 || index >= CN_WORD_COUNT) {
      return callback({ ok: false, error: 'Invalid card' });
    }

    const cell = room.state.codenames.board[index];
    if (!cell || cell.revealed) return callback({ ok: false, error: 'Already revealed' });

    cell.revealed = true;
    callback({ ok: true });

    if (cell.color === 'assassin') {
      room.state.codenames.winner = room.state.codenames.activeTeam === 'red' ? 'blue' : 'red';
      return finishCodenamesGame(ctx, roomCode, room);
    }

    if (cell.color !== room.state.codenames.activeTeam) {
      room.state.codenames.activeTeam = room.state.codenames.activeTeam === 'red' ? 'blue' : 'red';
      startCnTimer(ctx, roomCode, room);
    }

    const winner = checkTeamWin(room);
    if (winner) {
      room.state.codenames.winner = winner;
      return finishCodenamesGame(ctx, roomCode, room);
    }

    broadcastCodenamesState(ctx, roomCode, room);
  });

  socket.on('endTurn', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'codenames' || room.phase !== 'playing') {
      return callback({ ok: false, error: 'Not playing right now' });
    }
    if (room.state.codenames.timerSeconds && !room.state.codenames.turnEndsAt) {
      return callback({ ok: false, error: 'Waiting for the timer to start' });
    }

    const name = socket.data.name;
    const p = room.players.get(name);
    if (!p) return callback({ ok: false, error: 'Not joined' });
    if (p.team !== room.state.codenames.activeTeam || p.leader) {
      return callback({ ok: false, error: 'Only active team guessers can end the turn' });
    }

    room.state.codenames.activeTeam = room.state.codenames.activeTeam === 'red' ? 'blue' : 'red';
    startCnTimer(ctx, roomCode, room);
    callback({ ok: true });
    broadcastCodenamesState(ctx, roomCode, room);
  });

  socket.on('playAgainCodenames', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'codenames' || room.phase !== 'gameover') {
      return callback({ ok: false, error: 'Game is not over yet' });
    }
    const player = room.players.get(socket.data.name);
    if (!player || !player.leader) {
      return callback({ ok: false, error: 'Only a team leader can play again' });
    }
    if (!cnTeamValid(ctx, room, 'red') || !cnTeamValid(ctx, room, 'blue')) {
      return callback({ ok: false, error: 'Both teams need at least 2 players including a leader' });
    }

    room.state.codenames.startingTeam = room.state.codenames.startingTeam === 'red' ? 'blue' : 'red';
    callback({ ok: true });
    generateCodenamesRound(ctx, roomCode, room);
  });

  // Host-only: abandon the current board mid-round and deal a fresh one to the same
  // teams/leaders, e.g. after a mis-tap or a dispute. Unlike Play Again, the starting
  // team does NOT alternate - the round never properly finished, so nobody "used" a
  // starting-team turn. No score change either (no winner was ever decided).
  socket.on('restartCodenamesRound', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'codenames' || room.phase !== 'playing') {
      return callback({ ok: false, error: 'Not playing right now' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can restart the round' });
    }
    if (!cnTeamValid(ctx, room, 'red') || !cnTeamValid(ctx, room, 'blue')) {
      return callback({ ok: false, error: 'Both teams need at least 2 players including a leader' });
    }

    callback({ ok: true });
    generateCodenamesRound(ctx, roomCode, room);
  });
}

module.exports = {
  id: 'codenames',
  minPlayers: CN_MIN_PLAYERS,
  maxPlayers: null,
  onChoose,
  registerHandlers,
  reconnectPayload,
  onDisconnect,
  onReconnectBroadcast,
  namespaces: [{ id: 'codenames', createState, savedFields: SAVED_FIELDS }],
  repairOnLoad,
  clearState,
};
