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
const codenames = require('./server/games/codenames');

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
  BACKGROUNDS_DIR,
  playersInImposterRound,
  broadcastVoting,
  maybeFinishVoting,
  broadcastImposterReporting,
  maybeFinishImposterReporting,
  broadcastImposterResults,
});

// ---------- Socket handlers ----------

io.on('connection', (socket) => {
  registerLobbyHandlers(socket);
  menifot.registerHandlers(ctx, io, socket);
  tenseconds.registerHandlers(ctx, io, socket);
  codenames.registerHandlers(ctx, io, socket);

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

});

loadRoomsFromDisk({
  playersInImposterRound,
  finishImposterReporting,
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
