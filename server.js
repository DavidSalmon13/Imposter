require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const CN_MIN_PLAYERS = 4;
const CN_MIN_TEAM_SIZE = 2;
const CN_WORD_COUNT = 25;
const CN_START_COUNT = 7;
const CN_OTHER_COUNT = 6;
const CN_ASSASSIN_COUNT = 1;
const CN_NEUTRAL_COUNT = CN_WORD_COUNT - CN_START_COUNT - CN_OTHER_COUNT - CN_ASSASSIN_COUNT;
const CN_TIMER_OPTIONS = [0, 60, 120]; // seconds; 0 = no timer

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 4;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
const BACKGROUNDS_DIR = path.join(DATA_DIR, 'backgrounds');
const SAVE_INTERVAL_MS = 5000;

fs.mkdirSync(BACKGROUNDS_DIR, { recursive: true });
app.use('/backgrounds', express.static(BACKGROUNDS_DIR));

app.post('/api/rooms/:roomCode/background', express.raw({ type: 'image/*', limit: '8mb' }), (req, res) => {
  const roomCode = normalizeRoomCode(req.params.roomCode);
  const room = rooms.get(roomCode);
  if (!room) return res.status(404).json({ ok: false, error: 'Room not found' });

  const name = String(req.query.name || '').trim();
  if (!room.players.has(name)) {
    return res.status(403).json({ ok: false, error: 'Not a player in this room' });
  }

  const ext = BACKGROUND_MIME_EXT[req.headers['content-type']];
  if (!ext) return res.status(400).json({ ok: false, error: 'Unsupported image type' });
  if (!req.body || !req.body.length) return res.status(400).json({ ok: false, error: 'Empty upload' });

  if (room.backgroundImage) {
    fs.unlink(path.join(BACKGROUNDS_DIR, path.basename(room.backgroundImage)), () => {});
  }

  const filename = `${roomCode}-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(BACKGROUNDS_DIR, filename), req.body);
  room.backgroundImage = `/backgrounds/${filename}`;
  roomEmit(roomCode, 'backgroundChanged', { background: room.backgroundImage });
  saveRoomsToDisk();
  res.json({ ok: true, background: room.backgroundImage });
});

app.use((err, req, res, next) => {
  if (!err) return next();
  console.error('Upload error:', err.message);
  res.status(400).json({ ok: false, error: 'Upload failed - try a smaller image' });
});

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

/** @type {Map<string, object>} */
const rooms = new Map();

function createRoomState() {
  return {
    game: null, // null | 'imposter' | 'codenames'
    phase: 'lobby',
    // Imposter phases: 'voting' | 'generating' | 'playing'
    // Codenames phases: 'teamSelect' | 'generating' | 'playing' | 'gameover'
    hostName: null,
    players: new Map(), // name -> { socketId, connected, role, word, hint, vote, team, leader }
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
    backgroundImage: null,
  };
}

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

function loadRoomsFromDisk() {
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
    }
    console.log(`Loaded ${rooms.size} room(s) from ${ROOMS_FILE}`);
  } catch (err) {
    console.error('Failed to load rooms from disk:', err);
  }
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function connectedNames(room) {
  return Array.from(room.players.entries())
    .filter(([, p]) => p.connected)
    .map(([name]) => name);
}

function broadcastLobby(roomCode, room) {
  roomEmit(roomCode, 'lobbyUpdate', {
    players: connectedNames(room),
    host: room.hostName,
    roomCode,
  });
}

function setHost(roomCode, room, name) {
  room.hostName = name;
  roomEmit(roomCode, 'hostUpdate', { host: room.hostName });
}

function resetToLobby(roomCode, room) {
  for (const p of room.players.values()) {
    p.vote = null;
    p.role = null;
    p.word = null;
    p.hint = null;
    p.team = null;
    p.leader = false;
  }
  room.game = null;
  room.phase = 'lobby';
  room.currentLevel = null;
  room.cnBoard = null;
  room.cnActiveTeam = null;
  room.cnStartingTeam = null;
  room.cnWinner = null;
  room.cnScores = { red: 0, blue: 0 };
  clearCnTimerHandle(roomCode);
  room.cnTimerSeconds = null;
  room.cnTurnEndsAt = null;
  roomEmit(roomCode, 'backToLobby');
  broadcastLobby(roomCode, room);
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
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured on the server');
  }

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

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 1.2,
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenAI request failed (${res.status})`);
  }

  const data = await res.json();
  const raw = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  const parsed = JSON.parse(raw);
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
  }

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
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured on the server');
  }

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

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 1.1,
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenAI request failed (${res.status})`);
  }

  const data = await res.json();
  const raw = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  const parsed = JSON.parse(raw);
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

function finishCodenamesGame(roomCode, room) {
  room.phase = 'gameover';
  if (room.cnWinner) room.cnScores[room.cnWinner] += 1;
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

function validateName(name) {
  if (!name) return 'Name required';
  if (name.length > 20) return 'Name too long';
  return null;
}

function attachToRoom(socket, roomCode, room, name) {
  if (socket.data.roomCode && socket.data.roomCode !== roomCode) {
    socket.leave(socket.data.roomCode);
  }
  socket.join(roomCode);
  socket.data.roomCode = roomCode;
  socket.data.name = name;
}

function reconnectPayload(room, existing) {
  if (room.game === 'imposter') {
    if (room.phase === 'playing') {
      return {
        ok: true,
        game: room.game,
        phase: room.phase,
        level: room.currentLevel,
        role: existing.role,
        word: existing.word,
        hint: existing.hint,
        host: room.hostName,
      };
    }
    if (room.phase === 'generating') {
      return { ok: true, game: room.game, phase: room.phase, level: room.currentLevel, host: room.hostName };
    }
    if (room.phase === 'voting') {
      return {
        ok: true,
        game: room.game,
        phase: room.phase,
        players: connectedNames(room),
        vote: existing.vote,
        host: room.hostName,
      };
    }
  }

  if (room.game === 'codenames') {
    if (room.phase === 'teamSelect') {
      return {
        ok: true,
        game: room.game,
        phase: room.phase,
        host: room.hostName,
        red: teamPlayersInfo(room, 'red'),
        blue: teamPlayersInfo(room, 'blue'),
        unassigned: connectedNames(room).filter((n) => !room.players.get(n).team),
        timerSeconds: room.cnTimerSeconds || 0,
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
        activeTeam: room.cnActiveTeam,
        winner: room.cnWinner,
        scores: room.cnScores,
        board: boardForViewer(room, existing),
        isLeader: existing.leader,
        myTeam: existing.team,
        red: teamPlayersInfo(room, 'red'),
        blue: teamPlayersInfo(room, 'blue'),
        timerSeconds: room.cnTimerSeconds || 0,
        turnEndsAt: room.cnTurnEndsAt,
      };
    }
  }

  return { ok: true, game: null, phase: 'lobby', players: connectedNames(room), host: room.hostName };
}

function joinExistingRoom(socket, roomCode, name, callback) {
  const room = rooms.get(roomCode);
  if (!room) return callback({ ok: false, error: 'Room not found' });

  const existing = room.players.get(name);

  if (existing) {
    if (existing.connected) {
      return callback({ ok: false, error: 'That name is taken' });
    }
    existing.connected = true;
    existing.socketId = socket.id;
    attachToRoom(socket, roomCode, room, name);

    if (room.phase === 'voting') broadcastVoting(roomCode, room);
    else if (room.phase === 'teamSelect') broadcastTeamSelect(roomCode, room);
    else if (room.phase === 'lobby') {
      if (!room.hostName) setHost(roomCode, room, name);
      broadcastLobby(roomCode, room);
    }

    const payload = reconnectPayload(room, existing);
    payload.roomCode = roomCode;
    payload.background = room.backgroundImage;
    return callback(payload);
  }

  if (room.phase !== 'lobby') {
    return callback({ ok: false, error: 'Game already in progress, wait for the next round' });
  }

  room.players.set(name, {
    socketId: socket.id,
    connected: true,
    role: null,
    word: null,
    hint: null,
    vote: null,
    team: null,
    leader: false,
  });
  attachToRoom(socket, roomCode, room, name);
  if (!room.hostName) setHost(roomCode, room, name);
  broadcastLobby(roomCode, room);
  callback({
    ok: true,
    game: null,
    phase: 'lobby',
    players: connectedNames(room),
    host: room.hostName,
    roomCode,
    background: room.backgroundImage,
  });
}

// ---------- Socket handlers ----------

io.on('connection', (socket) => {
  socket.on('createRoom', (data, callback) => {
    callback = callback || (() => {});
    const name = ((data && data.name) || '').trim();
    const nameError = validateName(name);
    if (nameError) return callback({ ok: false, error: nameError });

    let roomCode;
    try {
      roomCode = generateRoomCode();
    } catch (err) {
      return callback({ ok: false, error: 'Could not create a room. Try again.' });
    }

    const room = createRoomState();
    rooms.set(roomCode, room);
    room.players.set(name, {
      socketId: socket.id,
      connected: true,
      role: null,
      word: null,
      hint: null,
      vote: null,
      team: null,
      leader: false,
    });
    attachToRoom(socket, roomCode, room, name);
    setHost(roomCode, room, name);
    broadcastLobby(roomCode, room);
    callback({
      ok: true,
      game: null,
      phase: 'lobby',
      players: connectedNames(room),
      host: room.hostName,
      roomCode,
      background: room.backgroundImage,
    });
  });

  socket.on('join', (data, callback) => {
    callback = callback || (() => {});
    const name = ((data && data.name) || '').trim();
    const roomCode = normalizeRoomCode(data && data.roomCode);

    const nameError = validateName(name);
    if (nameError) return callback({ ok: false, error: nameError });
    if (!roomCode || roomCode.length !== ROOM_CODE_LENGTH) {
      return callback({ ok: false, error: 'Enter a valid room code' });
    }

    joinExistingRoom(socket, roomCode, name, callback);
  });

  socket.on('chooseGame', (selectedGame, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.phase !== 'lobby') return callback({ ok: false, error: 'Game already chosen' });
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can choose the game' });
    }
    if (selectedGame !== 'imposter' && selectedGame !== 'codenames') {
      return callback({ ok: false, error: 'Invalid game' });
    }

    const names = connectedNames(room);

    if (selectedGame === 'imposter') {
      if (names.length < MIN_PLAYERS) {
        return callback({ ok: false, error: `Need at least ${MIN_PLAYERS} players` });
      }
      room.game = 'imposter';
      for (const p of room.players.values()) p.vote = null;
      room.phase = 'voting';
      roomEmit(roomCode, 'gameChosen', { game: room.game });
      roomEmit(roomCode, 'votingStarted', { players: connectedNames(room), host: room.hostName });
      return callback({ ok: true });
    }

    if (names.length < CN_MIN_PLAYERS) {
      return callback({ ok: false, error: `Need at least ${CN_MIN_PLAYERS} players` });
    }
    room.game = 'codenames';
    room.phase = 'teamSelect';
    roomEmit(roomCode, 'gameChosen', { game: room.game });
    broadcastTeamSelect(roomCode, room);
    callback({ ok: true });
  });

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

  // ----- Shared -----

  socket.on('backToLobby', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can return to the lobby' });
    }
    resetToLobby(roomCode, room);
    callback({ ok: true });
  });

  socket.on('clearBackground', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });

    if (room.backgroundImage) {
      fs.unlink(path.join(BACKGROUNDS_DIR, path.basename(room.backgroundImage)), () => {});
      room.backgroundImage = null;
      roomEmit(roomCode, 'backgroundChanged', { background: null });
      saveRoomsToDisk();
    }
    callback({ ok: true });
  });

  socket.on('disconnect', () => {
    const name = socket.data.name;
    const roomCode = socket.data.roomCode;
    if (!name || !roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    const p = room.players.get(name);
    if (!p) return;

    if (room.phase === 'lobby') {
      room.players.delete(name);
      if (name === room.hostName) {
        const [nextHost] = connectedNames(room);
        setHost(roomCode, room, nextHost || null);
      }
      broadcastLobby(roomCode, room);
      return;
    }

    // Past the lobby, a dropped connection (phone locked, WiFi blip, tab backgrounded)
    // shouldn't erase the player's spot - keep them so a reconnect restores it instead
    // of being treated as a stranger trying to join a game already in progress.
    p.connected = false;
    if (name === room.hostName) {
      const [nextHost] = connectedNames(room);
      setHost(roomCode, room, nextHost || null);
    }
    if (room.phase === 'voting') {
      broadcastVoting(roomCode, room);
      maybeFinishVoting(roomCode, room);
    } else if (room.phase === 'teamSelect') {
      broadcastTeamSelect(roomCode, room);
    } else if (room.game === 'codenames' && (room.phase === 'playing' || room.phase === 'gameover')) {
      broadcastCodenamesState(roomCode, room);
    }
  });
});

loadRoomsFromDisk();
setInterval(saveRoomsToDisk, SAVE_INTERVAL_MS);

function shutdown() {
  saveRoomsToDisk();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Imposter listening on ${PORT}`));
