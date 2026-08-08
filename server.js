require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const { shuffle } = require('./server/lib/shuffle');
const { chatCompletionJson } = require('./server/lib/openai');
const {
  rooms,
  initRoomStore,
  getRoom,
  roomEmit,
} = require('./server/roomStore');
const {
  DATA_DIR,
  SAVE_INTERVAL_MS,
  saveRoomsToDisk,
  loadRoomsFromDisk,
} = require('./server/persistence');
const {
  initLobby,
  connectedNames,
  scoreboardEntries,
  addScore,
  broadcastLobby,
  attachToRoom,
  registerBackgroundRoutes,
  registerLobbyHandlers,
} = require('./server/lobby');
const menifot = require('./server/games/menifot');
const tenseconds = require('./server/games/tenseconds');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
initRoomStore(io);

app.use(express.static(path.join(__dirname, 'public')));

const BACKGROUND_MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const MIN_PLAYERS = 3;
const TWO_IMPOSTER_THRESHOLD = 5;
const LEVELS = ['easy', 'medium', 'hard'];

const CN_MIN_PLAYERS = 4;
const CN_MIN_TEAM_SIZE = 2;
const CN_WORD_COUNT = 25;
const CN_START_COUNT = 7;
const CN_OTHER_COUNT = 6;
const CN_ASSASSIN_COUNT = 1;
const CN_NEUTRAL_COUNT = CN_WORD_COUNT - CN_START_COUNT - CN_OTHER_COUNT - CN_ASSASSIN_COUNT;
const CN_TIMER_OPTIONS = [0, 60, 120]; // seconds; 0 = no timer


const BACKGROUNDS_DIR = path.join(DATA_DIR, 'backgrounds');

fs.mkdirSync(BACKGROUNDS_DIR, { recursive: true });
app.use('/backgrounds', express.static(BACKGROUNDS_DIR));
registerBackgroundRoutes(app, { BACKGROUNDS_DIR, BACKGROUND_MIME_EXT });

const LEVEL_SPEC = {
  easy: {
    instruction:
      'Write a VERY revealing hint: describe the word\'s single most obvious, well-known use or defining ' +
      'feature so directly that almost anyone would guess it within a few seconds. It should feel like a ' +
      'giveaway, short of literally saying the word or an obvious rhyme of it.',
    example: 'Word: guitar -> Hint: "It has six strings and you strum it to play music."',
  },
  medium: {
    instruction:
      'Write a MODERATELY challenging hint: give one true clue, but make it partial or indirect - do not ' +
      'state the word\'s single most obvious defining feature or its most common use. It should take real ' +
      'thought, not be instant, and not be a giveaway.',
    example: 'Word: guitar -> Hint: "This needs regular tuning or it will sound wrong."',
  },
  hard: {
    instruction:
      'Write a DELIBERATELY HARD, vague, or metaphorical hint: reference only one subtle, non-obvious ' +
      'property, and NEVER name or imply the word\'s broad category (e.g. do not say or hint whether it is ' +
      'an animal, food, instrument, sport, object, place, job, etc.). It must require real lateral thinking ' +
      '- it should NOT be quickly guessable.',
    example: 'Word: guitar -> Hint: "Its hollow body has never once held anything."',
  },
};

const WORD_CATEGORIES = [
  'an everyday household object',
  'an animal',
  'a food or drink',
  'a fruit or vegetable',
  'a sport or hobby',
  'a job or profession',
  'a place or type of location',
  'a piece of clothing',
  'a vehicle or mode of transport',
  'a tool or piece of technology',
  'something found in nature',
  'a musical instrument',
  'a body part',
  'a piece of furniture',
  'a weather phenomenon',
  'a school subject',
  'a kitchen item',
  'an outdoor activity',
  'a toy or game',
  'a building or structure',
];

/** @type {Map<string, NodeJS.Timeout>} */
const cnTimerHandles = new Map();

function clearCnTimerHandle(roomCode) {
  const handle = cnTimerHandles.get(roomCode);
  if (handle) clearTimeout(handle);
  cnTimerHandles.delete(roomCode);
}

// Starts (or restarts) the countdown for the room's current turn. Call this whenever the
// active team changes. If no timer is configured, this just makes sure nothing is running.
function startCnTimer(roomCode, room) {
  clearCnTimerHandle(roomCode);
  if (!room.cnTimerSeconds) {
    room.cnTurnEndsAt = null;
    return;
  }
  room.cnTurnEndsAt = Date.now() + room.cnTimerSeconds * 1000;
  cnTimerHandles.set(roomCode, setTimeout(() => cnTimerExpired(roomCode), room.cnTimerSeconds * 1000));
}

function cnTimerExpired(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || room.game !== 'codenames' || room.phase !== 'playing') return;
  room.cnActiveTeam = room.cnActiveTeam === 'red' ? 'blue' : 'red';
  startCnTimer(roomCode, room); // subsequent turns start automatically
  broadcastCodenamesState(roomCode, room);
}

// ---------- Imposter ----------

function broadcastVoting(roomCode, room) {
  const names = connectedNames(room);
  const voted = names.filter((n) => room.players.get(n).vote).length;
  roomEmit(roomCode, 'votingUpdate', { total: names.length, voted, host: room.hostName });
}

function tallyLevel(room) {
  const counts = { easy: 0, medium: 0, hard: 0 };
  for (const name of connectedNames(room)) {
    const vote = room.players.get(name).vote;
    if (vote) counts[vote] += 1;
  }
  const maxCount = Math.max(...LEVELS.map((l) => counts[l]));
  return LEVELS.find((l) => counts[l] === maxCount);
}

async function generateWordAndHint(room, level) {
  const avoid = room.usedWords.slice(-40);
  const category = WORD_CATEGORIES[Math.floor(Math.random() * WORD_CATEGORIES.length)];
  const spec = LEVEL_SPEC[level];
  const prompt =
    `Pick one common, family-friendly word or short phrase (1-2 words) for ${category} that most adults ` +
    `would instantly recognize. Pick something specific and a little unexpected within that category, not ` +
    `just the single most stereotypical example of it. Then write ONE short hint sentence (max ~15 words) ` +
    `about it for a party game, calibrated for a "${level.toUpperCase()}" difficulty level.\n\n` +
    `${spec.instruction}\n\n` +
    `Example showing the STYLE and DIFFICULTY to match (pick your own unrelated word, do not reuse this ` +
    `example's word or hint): ${spec.example}\n\n` +
    `The hint must never contain the word itself, a rhyme of it, or any part of it.` +
    (avoid.length
      ? ` These words were already used recently - you MUST pick something different from all of them: ${avoid.join(', ')}.`
      : '') +
    ` Respond with ONLY compact JSON in the form {"word": "...", "hint": "..."}.`;

  const parsed = await chatCompletionJson(prompt, { temperature: 1.2 });
  const word = String(parsed.word || '').trim();
  const hint = String(parsed.hint || '').trim();

  if (!word || !hint) {
    throw new Error('Incomplete response from OpenAI');
  }
  if (hint.toLowerCase().includes(word.toLowerCase())) {
    throw new Error('Hint leaked the word');
  }

  return { word, hint };
}

function failImposterRound(roomCode, room, error) {
  room.phase = 'voting';
  room.currentLevel = null;
  for (const p of room.players.values()) p.vote = null;
  roomEmit(roomCode, 'votingStarted', { players: connectedNames(room), host: room.hostName });
  roomEmit(roomCode, 'startFailed', { error });
}

async function finishVoting(roomCode, room) {
  const level = tallyLevel(room);
  room.currentLevel = level;
  room.phase = 'generating';
  roomEmit(roomCode, 'generating', { game: 'imposter', level });

  let word, hint;
  try {
    ({ word, hint } = await generateWordAndHint(room, level));
  } catch (err) {
    console.error('generateWordAndHint failed:', err.message);
    return failImposterRound(roomCode, room, 'Could not reach ChatGPT to pick a word. Please try starting again.');
  }

  // Room may have been deleted while awaiting OpenAI.
  if (!rooms.has(roomCode) || rooms.get(roomCode) !== room) return;

  const names = connectedNames(room);
  if (names.length < MIN_PLAYERS) {
    return failImposterRound(roomCode, room, `Not enough players remained connected (need ${MIN_PLAYERS}).`);
  }

  room.usedWords.push(word);
  if (room.usedWords.length > 80) room.usedWords.splice(0, room.usedWords.length - 80);

  const imposterCount = names.length >= TWO_IMPOSTER_THRESHOLD ? 2 : 1;
  const fresh = names.filter((n) => !room.lastImposterNames.includes(n));
  const candidates = fresh.length >= imposterCount ? fresh : names;
  const imposterNames = shuffle(candidates).slice(0, imposterCount);
  room.lastImposterNames = imposterNames;
  for (const [name, p] of room.players) {
    if (imposterNames.includes(name)) {
      p.role = 'imposter';
      p.word = null;
      p.hint = hint;
    } else {
      p.role = 'crew';
      p.word = word;
      p.hint = null;
    }
    p.eliminatedReport = null;
  }

  room.imposterRoundResults = null;
  room.phase = 'playing';
  roomEmit(roomCode, 'gameStarted', { level });
  for (const [, p] of room.players) {
    if (p.connected) {
      io.to(p.socketId).emit('role', { role: p.role, word: p.word, hint: p.hint });
    }
  }
}

function maybeFinishVoting(roomCode, room) {
  const names = connectedNames(room);
  if (names.length === 0) return;
  const allVoted = names.every((n) => room.players.get(n).vote);
  if (allVoted) finishVoting(roomCode, room);
}

function imposterPointsFor(role, eliminated) {
  if (role === 'imposter') return eliminated ? 0 : 3;
  return eliminated ? -1 : 1;
}

function playersInImposterRound(room) {
  // Everyone who was dealt a role at game start — includes disconnected players still on the roster.
  return Array.from(room.players.entries())
    .filter(([, p]) => p.role === 'imposter' || p.role === 'crew')
    .map(([name]) => name);
}

function broadcastImposterReporting(roomCode, room) {
  const names = playersInImposterRound(room);
  const answered = names.filter((n) => {
    const p = room.players.get(n);
    return p && p.eliminatedReport !== null && p.eliminatedReport !== undefined;
  }).length;
  for (const [name, p] of room.players.entries()) {
    if (!p.connected || !p.socketId) continue;
    io.to(p.socketId).emit('imposterReporting', {
      host: room.hostName,
      total: names.length,
      answered,
      myAnswer:
        p.eliminatedReport === null || p.eliminatedReport === undefined
          ? null
          : !!p.eliminatedReport,
    });
  }
}

function broadcastImposterResults(roomCode, room) {
  roomEmit(roomCode, 'imposterResults', {
    host: room.hostName,
    results: room.imposterRoundResults || [],
    scoreboard: scoreboardEntries(room),
  });
}

function finishImposterReporting(roomCode, room) {
  const names = playersInImposterRound(room);
  const results = [];
  for (const name of names) {
    const p = room.players.get(name);
    if (!p) continue;
    // Disconnect before answering defaults to eliminated.
    const eliminated =
      p.eliminatedReport === null || p.eliminatedReport === undefined
        ? true
        : !!p.eliminatedReport;
    const points = imposterPointsFor(p.role, eliminated);
    addScore(room, name, points);
    results.push({
      name,
      role: p.role,
      eliminated,
      points,
    });
  }
  room.imposterRoundResults = results;
  room.phase = 'roundResults';
  broadcastImposterResults(roomCode, room);
}

function maybeFinishImposterReporting(roomCode, room) {
  if (room.game !== 'imposter' || room.phase !== 'reporting') return;
  const names = playersInImposterRound(room);
  if (names.length === 0) return;
  const allAnswered = names.every((n) => {
    const p = room.players.get(n);
    return p && p.eliminatedReport !== null && p.eliminatedReport !== undefined;
  });
  if (allAnswered) finishImposterReporting(roomCode, room);
}

// ---------- Codenames ----------

function teamMembers(room, color) {
  return connectedNames(room).filter((n) => room.players.get(n).team === color);
}

function teamPlayersInfo(room, color) {
  return teamMembers(room, color).map((n) => ({ name: n, leader: room.players.get(n).leader }));
}

function broadcastTeamSelect(roomCode, room) {
  roomEmit(roomCode, 'teamSelectUpdate', {
    host: room.hostName,
    red: teamPlayersInfo(room, 'red'),
    blue: teamPlayersInfo(room, 'blue'),
    unassigned: connectedNames(room).filter((n) => !room.players.get(n).team),
    timerSeconds: room.cnTimerSeconds || 0,
  });
}

function cnTeamValid(room, color) {
  const members = teamMembers(room, color);
  return members.length >= CN_MIN_TEAM_SIZE && members.some((n) => room.players.get(n).leader);
}

async function generateWordGrid(room) {
  const avoid = room.cnUsedWords.slice(-100);
  const prompt =
    `Generate exactly ${CN_WORD_COUNT} common, family-friendly, single-word nouns suitable for a word-guessing ` +
    `party game grid. Each must be ONE word (no phrases, no proper nouns), instantly recognizable to most ` +
    `adults, covering a broad mix of categories (objects, animals, food, places, jobs, nature, sports, tools, ` +
    `clothing, etc). All ${CN_WORD_COUNT} words must be different from each other.` +
    (avoid.length
      ? ` These words were used recently - avoid all of them: ${avoid.join(', ')}.`
      : '') +
    ` Respond with ONLY compact JSON in the form {"words": ["...", ...]} with exactly ${CN_WORD_COUNT} items.`;

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

  if (unique.length < CN_WORD_COUNT) {
    throw new Error('Incomplete word grid from OpenAI');
  }

  return unique.slice(0, CN_WORD_COUNT);
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

function boardForViewer(room, p) {
  return room.cnBoard.map((cell) => {
    if (cell.revealed || p.leader) {
      return { word: cell.word, color: cell.color, revealed: cell.revealed };
    }
    return { word: cell.word, color: null, revealed: false };
  });
}

function broadcastCodenamesState(roomCode, room) {
  for (const [, p] of room.players) {
    if (!p.connected) continue;
    io.to(p.socketId).emit('codenamesState', {
      phase: room.phase,
      activeTeam: room.cnActiveTeam,
      winner: room.cnWinner,
      scores: room.cnScores,
      board: boardForViewer(room, p),
      isLeader: p.leader,
      myTeam: p.team,
      red: teamPlayersInfo(room, 'red'),
      blue: teamPlayersInfo(room, 'blue'),
      host: room.hostName,
      timerSeconds: room.cnTimerSeconds || 0,
      turnEndsAt: room.cnTurnEndsAt,
      scoreboard: room.phase === 'gameover' ? scoreboardEntries(room) : undefined,
    });
  }
}

function failCodenamesRound(roomCode, room, error) {
  room.phase = 'teamSelect';
  clearCnTimerHandle(roomCode);
  room.cnTurnEndsAt = null;
  broadcastTeamSelect(roomCode, room);
  roomEmit(roomCode, 'codenamesStartFailed', { error });
}

function checkTeamWin(room) {
  for (const color of ['red', 'blue']) {
    const remaining = room.cnBoard.filter((c) => c.color === color && !c.revealed);
    if (remaining.length === 0) return color;
  }
  return null;
}

function awardCodenamesScores(room) {
  if (!room.cnWinner) return;
  for (const [name, p] of room.players.entries()) {
    if (!p.team) continue;
    if (p.team === room.cnWinner) addScore(room, name, 2);
    // Losing team gets 0 — no scoreboard write needed.
  }
}

function finishCodenamesGame(roomCode, room) {
  room.phase = 'gameover';
  if (room.cnWinner) room.cnScores[room.cnWinner] += 1;
  awardCodenamesScores(room);
  clearCnTimerHandle(roomCode);
  room.cnTurnEndsAt = null;
  broadcastCodenamesState(roomCode, room);
}

async function generateCodenamesRound(roomCode, room) {
  room.phase = 'generating';
  roomEmit(roomCode, 'generating', { game: 'codenames' });

  let words;
  try {
    words = await generateWordGrid(room);
  } catch (err) {
    console.error('generateWordGrid failed:', err.message);
    return failCodenamesRound(roomCode, room, 'Could not reach ChatGPT to build the board. Please try starting again.');
  }

  if (!rooms.has(roomCode) || rooms.get(roomCode) !== room) return;

  if (!cnTeamValid(room, 'red') || !cnTeamValid(room, 'blue')) {
    return failCodenamesRound(roomCode, room, 'Not enough players remained on a team.');
  }

  for (const w of words) room.cnUsedWords.push(w);
  if (room.cnUsedWords.length > 150) room.cnUsedWords.splice(0, room.cnUsedWords.length - 150);

  room.cnBoard = buildBoard(words, room.cnStartingTeam);
  room.cnActiveTeam = room.cnStartingTeam;
  room.cnWinner = null;
  room.phase = 'playing';
  // The first turn of a round waits for the active team to press "Start Timer" so
  // the leader has time to study the board before the clock starts.
  clearCnTimerHandle(roomCode);
  room.cnTurnEndsAt = null;
  broadcastCodenamesState(roomCode, room);
}

const ctx = {
  rooms,
  roomEmit,
  io,
  getRoom,
  connectedNames,
  scoreboardEntries,
  addScore,
  broadcastLobby,
  attachToRoom,
  saveRoomsToDisk,
};

initLobby({
  ctx,
  MIN_PLAYERS,
  CN_MIN_PLAYERS,
  BACKGROUNDS_DIR,
  clearCnTimerHandle,
  playersInImposterRound,
  teamPlayersInfo,
  boardForViewer,
  broadcastVoting,
  maybeFinishVoting,
  broadcastImposterReporting,
  maybeFinishImposterReporting,
  broadcastImposterResults,
  broadcastTeamSelect,
  broadcastCodenamesState,
});

// ---------- Socket handlers ----------

io.on('connection', (socket) => {
  registerLobbyHandlers(socket);
  menifot.registerHandlers(ctx, io, socket);
  tenseconds.registerHandlers(ctx, io, socket);

  // ----- Imposter -----

  socket.on('vote', (level, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'imposter' || room.phase !== 'voting') {
      return callback({ ok: false, error: 'Voting is not open' });
    }
    if (!LEVELS.includes(level)) return callback({ ok: false, error: 'Invalid level' });

    const name = socket.data.name;
    const p = room.players.get(name);
    if (!p) return callback({ ok: false, error: 'Not joined' });

    p.vote = level;
    callback({ ok: true });
    broadcastVoting(roomCode, room);
    maybeFinishVoting(roomCode, room);
  });

  socket.on('endImposterRound', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'imposter' || room.phase !== 'playing') {
      return callback({ ok: false, error: 'Round is not in progress' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can end the round' });
    }

    for (const p of room.players.values()) p.eliminatedReport = null;
    room.imposterRoundResults = null;
    room.phase = 'reporting';

    // Anyone already disconnected defaults to eliminated so the round can't hang.
    for (const name of playersInImposterRound(room)) {
      const p = room.players.get(name);
      if (p && !p.connected) p.eliminatedReport = true;
    }

    callback({ ok: true });
    broadcastImposterReporting(roomCode, room);
    maybeFinishImposterReporting(roomCode, room);
  });

  socket.on('reportEliminated', (eliminated, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'imposter' || room.phase !== 'reporting') {
      return callback({ ok: false, error: 'Not reporting right now' });
    }

    const name = socket.data.name;
    const p = room.players.get(name);
    if (!p || (p.role !== 'imposter' && p.role !== 'crew')) {
      return callback({ ok: false, error: 'Not in this round' });
    }
    if (p.eliminatedReport !== null && p.eliminatedReport !== undefined) {
      return callback({ ok: false, error: 'Already reported' });
    }

    p.eliminatedReport = !!eliminated;
    callback({ ok: true });
    broadcastImposterReporting(roomCode, room);
    maybeFinishImposterReporting(roomCode, room);
  });

  // ----- Codenames -----

  socket.on('joinTeam', (color, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = getRoom(socket);
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
    broadcastTeamSelect(roomCode, room);
  });

  socket.on('claimLeader', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'codenames' || room.phase !== 'teamSelect') {
      return callback({ ok: false, error: 'Not choosing teams right now' });
    }

    const name = socket.data.name;
    const p = room.players.get(name);
    if (!p || !p.team) return callback({ ok: false, error: 'Join a team first' });

    const currentLeader = teamMembers(room, p.team).find((n) => room.players.get(n).leader);
    if (currentLeader && currentLeader !== name) {
      return callback({ ok: false, error: 'This team already has a leader' });
    }

    p.leader = true;
    callback({ ok: true });
    broadcastTeamSelect(roomCode, room);
  });

  socket.on('setCnTimer', (seconds, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'codenames' || room.phase !== 'teamSelect') {
      return callback({ ok: false, error: 'Not choosing teams right now' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can set the timer' });
    }
    const value = Number(seconds);
    if (!CN_TIMER_OPTIONS.includes(value)) return callback({ ok: false, error: 'Invalid timer option' });

    room.cnTimerSeconds = value || null;
    callback({ ok: true });
    broadcastTeamSelect(roomCode, room);
  });

  socket.on('startCodenames', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'codenames' || room.phase !== 'teamSelect') {
      return callback({ ok: false, error: 'Not ready to start' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can start the game' });
    }
    if (!cnTeamValid(room, 'red')) {
      return callback({ ok: false, error: 'Red team needs at least 2 players including a leader' });
    }
    if (!cnTeamValid(room, 'blue')) {
      return callback({ ok: false, error: 'Blue team needs at least 2 players including a leader' });
    }

    room.cnStartingTeam = Math.random() < 0.5 ? 'red' : 'blue';
    callback({ ok: true });
    generateCodenamesRound(roomCode, room);
  });

  socket.on('startCnTurnTimer', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'codenames' || room.phase !== 'playing') {
      return callback({ ok: false, error: 'Not playing right now' });
    }
    if (!room.cnTimerSeconds) return callback({ ok: false, error: 'No timer set for this game' });
    if (room.cnTurnEndsAt) return callback({ ok: false, error: 'Timer already running' });

    const name = socket.data.name;
    const p = room.players.get(name);
    if (!p || p.team !== room.cnActiveTeam) {
      return callback({ ok: false, error: "Only the active team can start the timer" });
    }

    startCnTimer(roomCode, room);
    callback({ ok: true });
    broadcastCodenamesState(roomCode, room);
  });

  socket.on('guessWord', (index, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'codenames' || room.phase !== 'playing') {
      return callback({ ok: false, error: 'Not playing right now' });
    }
    if (room.cnTimerSeconds && !room.cnTurnEndsAt) {
      return callback({ ok: false, error: 'Waiting for the timer to start' });
    }

    const name = socket.data.name;
    const p = room.players.get(name);
    if (!p) return callback({ ok: false, error: 'Not joined' });
    if (p.team !== room.cnActiveTeam) return callback({ ok: false, error: "Not your team's turn" });
    if (p.leader) return callback({ ok: false, error: 'Leaders cannot guess' });
    if (!Number.isInteger(index) || index < 0 || index >= CN_WORD_COUNT) {
      return callback({ ok: false, error: 'Invalid card' });
    }

    const cell = room.cnBoard[index];
    if (!cell || cell.revealed) return callback({ ok: false, error: 'Already revealed' });

    cell.revealed = true;
    callback({ ok: true });

    if (cell.color === 'assassin') {
      room.cnWinner = room.cnActiveTeam === 'red' ? 'blue' : 'red';
      return finishCodenamesGame(roomCode, room);
    }

    if (cell.color !== room.cnActiveTeam) {
      room.cnActiveTeam = room.cnActiveTeam === 'red' ? 'blue' : 'red';
      startCnTimer(roomCode, room);
    }

    const winner = checkTeamWin(room);
    if (winner) {
      room.cnWinner = winner;
      return finishCodenamesGame(roomCode, room);
    }

    broadcastCodenamesState(roomCode, room);
  });

  socket.on('endTurn', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'codenames' || room.phase !== 'playing') {
      return callback({ ok: false, error: 'Not playing right now' });
    }
    if (room.cnTimerSeconds && !room.cnTurnEndsAt) {
      return callback({ ok: false, error: 'Waiting for the timer to start' });
    }

    const name = socket.data.name;
    const p = room.players.get(name);
    if (!p) return callback({ ok: false, error: 'Not joined' });
    if (p.team !== room.cnActiveTeam || p.leader) {
      return callback({ ok: false, error: 'Only active team guessers can end the turn' });
    }

    room.cnActiveTeam = room.cnActiveTeam === 'red' ? 'blue' : 'red';
    startCnTimer(roomCode, room);
    callback({ ok: true });
    broadcastCodenamesState(roomCode, room);
  });

  socket.on('playAgainCodenames', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'codenames' || room.phase !== 'gameover') {
      return callback({ ok: false, error: 'Game is not over yet' });
    }

    const name = socket.data.name;
    const p = room.players.get(name);
    if (!p || !p.leader) {
      return callback({ ok: false, error: 'Only a team leader can start the next round' });
    }

    room.cnStartingTeam = room.cnStartingTeam === 'red' ? 'blue' : 'red';
    callback({ ok: true });
    generateCodenamesRound(roomCode, room);
  });

});

loadRoomsFromDisk({
  playersInImposterRound,
  finishImposterReporting,
  cnTimerExpired,
  cnTimerHandles,
  ctx,
});
setInterval(saveRoomsToDisk, SAVE_INTERVAL_MS);

function shutdown() {
  saveRoomsToDisk();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Imposter listening on ${PORT}`));
