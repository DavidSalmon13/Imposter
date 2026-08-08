require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const { buildDeck, rankBoard } = require('./menifot-eval');

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

const TS_MIN_PLAYERS = 2;
const TS_TARGET_MS = 10000;
const TS_COUNTDOWN_MS = 3000;
const TS_FORCE_STOP_MS = 30000; // 3x target — distracted players get a real (non-DNF) result

const MF_MIN_PLAYERS = 2;
const MF_MAX_PLAYERS = 8;
const MF_THREE_BOARD_MAX_PLAYERS = 3;
const MF_TARGET_SCORE = 10;
const MF_REVEAL_STEP_MS = 1400; // pacing between each board's turn/river reveal

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
    game: null, // null | 'imposter' | 'codenames' | 'tenseconds' | 'menifot'
    phase: 'lobby',
    // Imposter phases: 'voting' | 'generating' | 'playing' | 'reporting' | 'roundResults'
    // Codenames phases: 'teamSelect' | 'generating' | 'playing' | 'gameover'
    // 10 Seconds phases: 'ready' | 'running' | 'roundResults' | 'gameover'
    // Menifot phases: 'ready' | 'allocating' | 'roundResults' | 'gameover'
    hostName: null,
    players: new Map(), // name -> { socketId, connected, role, word, hint, vote, team, leader, eliminatedReport }
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

/** @type {Map<string, NodeJS.Timeout>} */
const cnTimerHandles = new Map();

/** @type {Map<string, NodeJS.Timeout>} */
const tsForceStopHandles = new Map();

/** @type {Map<string, NodeJS.Timeout>} */
const mfRevealHandles = new Map();

function clearCnTimerHandle(roomCode) {
  const handle = cnTimerHandles.get(roomCode);
  if (handle) clearTimeout(handle);
  cnTimerHandles.delete(roomCode);
}

function clearTsForceStopHandle(roomCode) {
  const handle = tsForceStopHandles.get(roomCode);
  if (handle) clearTimeout(handle);
  tsForceStopHandles.delete(roomCode);
}

function clearMfRevealHandle(roomCode) {
  const handle = mfRevealHandles.get(roomCode);
  if (handle) clearTimeout(handle);
  mfRevealHandles.delete(roomCode);
}

function clearTsState(room, roomCode) {
  clearTsForceStopHandle(roomCode);
  room.tsActivePlayers = [];
  room.tsContenders = [];
  room.tsEliminatedOrder = [];
  room.tsRoundStartAt = null;
  room.tsRoundResults = {};
  room.tsRoundNumber = 0;
  room.tsSuddenDeath = false;
  room.tsEliminationWaves = [];
}

function clearMfState(room, roomCode) {
  if (roomCode) clearMfRevealHandle(roomCode);
  room.mfPlayers = [];
  room.mfBoardCount = 0;
  room.mfBoards = [];
  room.mfHands = {};
  room.mfBurned = [];
  room.mfScores = {};
  room.mfRoundNumber = 0;
  room.mfRoundResults = null;
  room.mfMatchWinners = [];
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
      if (room.game === 'tenseconds' && room.phase === 'running' && room.tsRoundStartAt) {
        scheduleTsForceStop(code, room);
      }
      // Menifot mid-allocation / mid-reveal can't safely resume — drop to ready-for-next-round
      // (or pre-Start ready) with match scores / roster preserved.
      if (room.game === 'menifot' && (room.phase === 'allocating' || room.phase === 'roundResults')) {
        if (room.phase === 'allocating') {
          room.mfBoards = [];
          room.mfHands = {};
          room.mfBurned = [];
          room.mfRoundResults = null;
          room.phase = 'ready';
        }
      }
      if (!room.mfScores || typeof room.mfScores !== 'object') room.mfScores = {};
      if (!Array.isArray(room.mfPlayers)) room.mfPlayers = [];
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

function scoreboardEntries(room) {
  return Object.entries(room.scoreboard || {})
    .map(([name, points]) => ({ name, points: Number(points) || 0 }))
    .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
}

function addScore(room, name, delta) {
  if (!name || !delta) return;
  if (!room.scoreboard) room.scoreboard = {};
  room.scoreboard[name] = (Number(room.scoreboard[name]) || 0) + delta;
}

function broadcastLobby(roomCode, room) {
  roomEmit(roomCode, 'lobbyUpdate', {
    players: connectedNames(room),
    host: room.hostName,
    roomCode,
    scoreboard: scoreboardEntries(room),
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
  clearTsState(room, roomCode);
  clearMfState(room, roomCode);
  room.imposterRoundResults = null;
  for (const p of room.players.values()) p.eliminatedReport = null;
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

// ---------- 10 Seconds ----------

function tsDisconnectedActive(room) {
  return room.tsActivePlayers.filter((n) => {
    const p = room.players.get(n);
    return !p || !p.connected;
  });
}

function tensSecondsStatePayload(room, viewerName) {
  const eliminated = room.tsEliminatedOrder.includes(viewerName);
  const isContender = room.tsContenders.includes(viewerName);
  const myResult = room.tsRoundResults[viewerName] || null;
  const disconnected = tsDisconnectedActive(room);

  const standings =
    room.phase === 'gameover'
      ? [...room.tsActivePlayers, ...[...room.tsEliminatedOrder].reverse()]
      : null;

  return {
    game: 'tenseconds',
    phase: room.phase,
    host: room.hostName,
    roundNumber: room.tsRoundNumber,
    suddenDeath: room.tsSuddenDeath,
    activePlayers: room.tsActivePlayers.slice(),
    contenders: room.tsContenders.slice(),
    eliminatedOrder: room.tsEliminatedOrder.slice(),
    roundStartAt: room.tsRoundStartAt,
    results: room.tsRoundResults,
    standings,
    eliminated,
    isContender,
    myResult,
    waitingOn: disconnected,
    canStart:
      room.phase === 'ready' &&
      disconnected.length === 0 &&
      room.tsActivePlayers.length >= TS_MIN_PLAYERS,
    scoreboard: room.phase === 'gameover' ? scoreboardEntries(room) : undefined,
  };
}

function broadcastTensSeconds(roomCode, room) {
  for (const [name, p] of room.players.entries()) {
    if (!p.connected || !p.socketId) continue;
    io.to(p.socketId).emit('tensSecondsState', tensSecondsStatePayload(room, name));
  }
}

function initTensSecondsGame(roomCode, room, playerNames) {
  clearTsForceStopHandle(roomCode);
  room.tsActivePlayers = (playerNames || connectedNames(room)).slice();
  room.tsContenders = [];
  room.tsEliminatedOrder = [];
  room.tsRoundStartAt = null;
  room.tsRoundResults = {};
  room.tsRoundNumber = 0;
  room.tsSuddenDeath = false;
  room.tsEliminationWaves = [];
  room.phase = 'ready';
  broadcastTensSeconds(roomCode, room);
}

function startTensSecondsRound(roomCode, room, { suddenDeath = false, contenders = null } = {}) {
  const racers = contenders || room.tsActivePlayers.slice();
  if (racers.length < 1) return;

  clearTsForceStopHandle(roomCode);
  room.tsSuddenDeath = suddenDeath;
  if (!suddenDeath) room.tsRoundNumber += 1;
  room.tsContenders = racers.slice();
  room.tsRoundResults = {};
  room.tsRoundStartAt = Date.now() + TS_COUNTDOWN_MS;
  room.phase = 'running';
  scheduleTsForceStop(roomCode, room);
  broadcastTensSeconds(roomCode, room);
}

function scheduleTsForceStop(roomCode, room) {
  clearTsForceStopHandle(roomCode);
  if (!room.tsRoundStartAt) return;
  const delay = room.tsRoundStartAt + TS_FORCE_STOP_MS - Date.now();
  if (delay <= 0) {
    applyTsForceStops(roomCode);
    return;
  }
  tsForceStopHandles.set(
    roomCode,
    setTimeout(() => applyTsForceStops(roomCode), delay)
  );
}

function applyTsForceStops(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || room.game !== 'tenseconds' || room.phase !== 'running') return;

  let changed = false;
  for (const name of room.tsContenders) {
    if (room.tsRoundResults[name]) continue;
    room.tsRoundResults[name] = {
      elapsedMs: TS_FORCE_STOP_MS,
      distanceMs: Math.abs(TS_FORCE_STOP_MS - TS_TARGET_MS),
      dnf: false,
    };
    changed = true;
  }
  if (changed) maybeResolveTsRound(roomCode, room);
}

function assignTsDnf(room, name) {
  if (!room.tsContenders.includes(name)) return false;
  if (room.tsRoundResults[name] && !room.tsRoundResults[name].dnf) return false;
  room.tsRoundResults[name] = { elapsedMs: null, distanceMs: Number.POSITIVE_INFINITY, dnf: true };
  return true;
}

function submitTsStop(room, name, elapsedMs) {
  if (!room.tsContenders.includes(name)) return { ok: false, error: 'Not racing this round' };
  if (room.tsRoundResults[name] && !room.tsRoundResults[name].dnf) {
    return { ok: false, error: 'Already stopped' };
  }
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return { ok: false, error: 'Invalid time' };
  }
  const clamped = Math.min(elapsedMs, TS_FORCE_STOP_MS * 2);
  room.tsRoundResults[name] = {
    elapsedMs: clamped,
    distanceMs: Math.abs(clamped - TS_TARGET_MS),
    dnf: false,
  };
  return { ok: true };
}

function allTsContendersIn(room) {
  return room.tsContenders.every((n) => !!room.tsRoundResults[n]);
}

function maybeResolveTsRound(roomCode, room) {
  if (!allTsContendersIn(room)) return;
  clearTsForceStopHandle(roomCode);
  resolveTsRound(roomCode, room);
}

function resolveTsRound(roomCode, room) {
  const contenders = room.tsContenders.slice();
  const dnfNames = contenders.filter((n) => room.tsRoundResults[n] && room.tsRoundResults[n].dnf);
  const finished = contenders.filter((n) => room.tsRoundResults[n] && !room.tsRoundResults[n].dnf);

  // All remaining racers DNF → void the round, retry from ready with same active set.
  if (dnfNames.length === contenders.length) {
    room.tsSuddenDeath = false;
    room.tsContenders = [];
    room.tsRoundStartAt = null;
    room.tsRoundResults = {};
    room.phase = 'ready';
    broadcastTensSeconds(roomCode, room);
    return;
  }

  // Multiple DNFs: eliminate all of them together (exception to one-elimination rule).
  if (dnfNames.length >= 2) {
    eliminateTsPlayers(room, dnfNames);
    finishTsRoundResolution(roomCode, room);
    return;
  }

  if (dnfNames.length === 1) {
    eliminateTsPlayers(room, dnfNames);
    finishTsRoundResolution(roomCode, room);
    return;
  }

  let worstDistance = -1;
  for (const name of finished) {
    const d = room.tsRoundResults[name].distanceMs;
    if (d > worstDistance) worstDistance = d;
  }
  const worst = finished.filter((n) => room.tsRoundResults[n].distanceMs === worstDistance);

  if (worst.length >= 2) {
    startTensSecondsRound(roomCode, room, { suddenDeath: true, contenders: worst });
    return;
  }

  eliminateTsPlayers(room, worst);
  finishTsRoundResolution(roomCode, room);
}

function eliminateTsPlayers(room, names) {
  const wave = [];
  for (const name of names) {
    if (!room.tsActivePlayers.includes(name)) continue;
    room.tsActivePlayers = room.tsActivePlayers.filter((n) => n !== name);
    if (!room.tsEliminatedOrder.includes(name)) {
      room.tsEliminatedOrder.push(name);
      wave.push(name);
    }
  }
  if (wave.length) {
    if (!room.tsEliminationWaves) room.tsEliminationWaves = [];
    room.tsEliminationWaves.push(wave);
  }
}

function finishTsRoundResolution(roomCode, room) {
  room.tsSuddenDeath = false;
  room.tsRoundStartAt = null;
  room.phase = 'roundResults';
  broadcastTensSeconds(roomCode, room);
}

function awardTensSecondsScores(room) {
  const champion = room.tsActivePlayers[0];
  if (!champion) return;

  addScore(room, champion, 2);

  const waves = room.tsEliminationWaves || [];
  if (waves.length === 0) return;

  // Only one elimination wave (includes the 2-player case): that group is last place.
  if (waves.length === 1) {
    for (const name of waves[0]) addScore(room, name, -1);
    return;
  }

  // Last wave = most recently eliminated = second place (+1).
  for (const name of waves[waves.length - 1]) addScore(room, name, 1);
  // First wave = earliest eliminated = last place (-1).
  for (const name of waves[0]) addScore(room, name, -1);
  // Middle waves get 0.
}

function continueTsAfterResults(roomCode, room) {
  if (room.tsActivePlayers.length <= 1) {
    room.phase = 'gameover';
    room.tsContenders = [];
    awardTensSecondsScores(room);
    broadcastTensSeconds(roomCode, room);
    return;
  }
  room.phase = 'ready';
  room.tsContenders = [];
  room.tsRoundResults = {};
  broadcastTensSeconds(roomCode, room);
}

// ---------- Menifot ----------

function emptyMfAllocation(boardCount) {
  const allocation = {};
  for (let i = 0; i < boardCount; i++) allocation[i] = [];
  return allocation;
}

function mfAllocationCounts(hand, boardCount) {
  const counts = [];
  for (let i = 0; i < boardCount; i++) {
    counts.push((hand.allocation[i] || hand.allocation[String(i)] || []).length);
  }
  return counts;
}

/** Final per-board size bounds for an even (±1) split of totalCards across boardCount boards. */
function mfBoardLimits(totalCards, boardCount) {
  const lo = Math.floor(totalCards / boardCount);
  const hi = Math.ceil(totalCards / boardCount);
  const hiSlots = totalCards % boardCount; // boards allowed at `hi` when hi > lo
  return { lo, hi, hiSlots };
}

/**
 * Whether a (possibly partial) allocation can still finish as a valid ±1 split.
 * Used to proactively reject illegal board taps before Lock.
 */
function mfCountsFeasible(counts, totalCards) {
  const boardCount = counts.length;
  if (boardCount < 1) return false;
  const { lo, hi, hiSlots } = mfBoardLimits(totalCards, boardCount);
  if (counts.some((c) => c < 0 || c > hi)) return false;

  const assigned = counts.reduce((a, b) => a + b, 0);
  if (assigned > totalCards) return false;
  const unassigned = totalCards - assigned;

  if (hi > lo) {
    const atHi = counts.filter((c) => c >= hi).length;
    if (atHi > hiSlots) return false;
  }

  const maxPlaceable = counts.reduce((s, c) => s + (hi - c), 0);
  if (unassigned > maxPlaceable) return false;

  let minNeeded = 0;
  for (const c of counts) {
    if (c < lo) minNeeded += lo - c;
  }
  if (minNeeded > unassigned) return false;

  return true;
}

function mfAllocationValid(hand, boardCount) {
  const assigned = [];
  for (let i = 0; i < boardCount; i++) {
    for (const c of hand.allocation[i] || hand.allocation[String(i)] || []) assigned.push(c);
  }
  if (assigned.length !== hand.cards.length) return false;
  const set = new Set(assigned);
  if (set.size !== assigned.length) return false;
  for (const c of hand.cards) {
    if (!set.has(c)) return false;
  }
  const counts = mfAllocationCounts(hand, boardCount);
  return Math.max(...counts) - Math.min(...counts) <= 1;
}

function mfCommunityCards(board) {
  return [...board.flop, board.turn, board.river];
}

function dealMenifotRound(room) {
  const playerCount = room.mfPlayers.length;
  const boardCount = room.mfBoardCount;
  const deck = shuffle(buildDeck());
  let idx = 0;

  const boards = [];
  for (let b = 0; b < boardCount; b++) {
    boards.push({
      flop: [deck[idx++], deck[idx++], deck[idx++]],
      turn: deck[idx++],
      river: deck[idx++],
      revealed: false,
    });
  }

  const remaining = deck.length - idx;
  const burnCount = remaining % playerCount;
  const burned = [];
  for (let i = 0; i < burnCount; i++) burned.push(deck[idx++]);

  const cardsPerPlayer = (remaining - burnCount) / playerCount;
  const hands = {};
  for (const name of room.mfPlayers) {
    const cards = [];
    for (let i = 0; i < cardsPerPlayer; i++) cards.push(deck[idx++]);
    hands[name] = {
      cards,
      allocation: emptyMfAllocation(boardCount),
      locked: false,
    };
  }

  room.mfBoards = boards;
  room.mfBurned = burned;
  room.mfHands = hands;
  room.mfRoundResults = null;
  room.mfRoundNumber += 1;
}

function autoLockEvenSplit(hand, boardCount) {
  const allocation = emptyMfAllocation(boardCount);
  hand.cards.forEach((card, i) => {
    allocation[i % boardCount].push(card);
  });
  hand.allocation = allocation;
  hand.locked = true;
}

function menifotPublicBoards(room) {
  return room.mfBoards.map((b) => ({
    flop: b.flop.slice(),
    turn: b.revealed ? b.turn : null,
    river: b.revealed ? b.river : null,
    revealed: !!b.revealed,
  }));
}

function menifotLockStatus(room) {
  return room.mfPlayers.map((name) => {
    const hand = room.mfHands[name];
    const p = room.players.get(name);
    return {
      name,
      locked: !!(hand && hand.locked),
      connected: !!(p && p.connected),
    };
  });
}

function menifotStatePayload(room, viewerName) {
  const inMatch = room.mfPlayers.includes(viewerName);
  const hand = room.mfHands[viewerName] || null;
  const scores = {};
  for (const name of room.mfPlayers) scores[name] = room.mfScores[name] || 0;

  const standings =
    room.phase === 'gameover'
      ? room.mfPlayers
          .slice()
          .map((name) => ({ name, score: room.mfScores[name] || 0 }))
          .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      : null;

  return {
    game: 'menifot',
    phase: room.phase,
    host: room.hostName,
    boardCount: room.mfBoardCount,
    players: room.mfPlayers.slice(),
    roundNumber: room.mfRoundNumber,
    scores,
    boards: menifotPublicBoards(room),
    burned: room.phase === 'roundResults' || room.phase === 'gameover' ? room.mfBurned.slice() : [],
    lockStatus: menifotLockStatus(room),
    myHand: hand
      ? {
          cards: hand.cards.slice(),
          allocation: Object.fromEntries(
            Object.entries(hand.allocation).map(([k, v]) => [k, v.slice()])
          ),
          locked: !!hand.locked,
        }
      : null,
    inMatch,
    roundResults: room.mfRoundResults,
    matchWinners: room.mfMatchWinners.slice(),
    standings,
    canStart:
      room.phase === 'ready' &&
      (room.mfPlayers.length > 0 ||
        (connectedNames(room).length >= MF_MIN_PLAYERS &&
          connectedNames(room).length <= MF_MAX_PLAYERS)),
    scoreboard: room.phase === 'gameover' ? scoreboardEntries(room) : undefined,
  };
}

function broadcastMenifot(roomCode, room) {
  for (const [name, p] of room.players.entries()) {
    if (!p.connected || !p.socketId) continue;
    io.to(p.socketId).emit('menifotState', menifotStatePayload(room, name));
  }
}

function initMenifotGame(roomCode, room) {
  clearMfState(room, roomCode);
  room.phase = 'ready';
  broadcastMenifot(roomCode, room);
}

function startMenifotMatch(roomCode, room, playerNames) {
  const names = (playerNames || connectedNames(room)).slice();
  if (names.length < MF_MIN_PLAYERS || names.length > MF_MAX_PLAYERS) return false;

  room.mfPlayers = names;
  room.mfBoardCount = names.length <= MF_THREE_BOARD_MAX_PLAYERS ? 3 : 2;
  room.mfScores = {};
  for (const name of names) room.mfScores[name] = 0;
  room.mfRoundNumber = 0;
  room.mfMatchWinners = [];
  room.mfRoundResults = null;
  dealMenifotRound(room);
  room.phase = 'allocating';

  // Auto-lock anyone already disconnected at deal time.
  for (const name of room.mfPlayers) {
    const p = room.players.get(name);
    if (!p || !p.connected) {
      autoLockEvenSplit(room.mfHands[name], room.mfBoardCount);
    }
  }
  broadcastMenifot(roomCode, room);
  maybeRevealMenifot(roomCode, room);
  return true;
}

function startMenifotNextRound(roomCode, room) {
  dealMenifotRound(room);
  room.phase = 'allocating';
  for (const name of room.mfPlayers) {
    const p = room.players.get(name);
    if (!p || !p.connected) {
      autoLockEvenSplit(room.mfHands[name], room.mfBoardCount);
    }
  }
  broadcastMenifot(roomCode, room);
  maybeRevealMenifot(roomCode, room);
}

function setMfCardBoard(hand, card, boardIndex, boardCount) {
  if (hand.locked) return { ok: false, error: 'Hand is locked' };
  if (!hand.cards.includes(card)) return { ok: false, error: 'Card not in hand' };

  const next = emptyMfAllocation(boardCount);
  for (let i = 0; i < boardCount; i++) {
    for (const c of hand.allocation[i] || hand.allocation[String(i)] || []) {
      if (c !== card) next[i].push(c);
    }
  }

  if (boardIndex !== null && boardIndex !== undefined && boardIndex !== -1) {
    const bi = Number(boardIndex);
    if (!Number.isInteger(bi) || bi < 0 || bi >= boardCount) {
      return { ok: false, error: 'Invalid board' };
    }
    next[bi].push(card);
  }

  const counts = [];
  for (let i = 0; i < boardCount; i++) counts.push(next[i].length);
  if (!mfCountsFeasible(counts, hand.cards.length)) {
    return { ok: false, error: 'That board can’t take another card (±1 rule)' };
  }

  hand.allocation = next;
  return { ok: true };
}

function lockMfHand(room, name) {
  const hand = room.mfHands[name];
  if (!hand) return { ok: false, error: 'Not in this match' };
  if (hand.locked) return { ok: false, error: 'Already locked' };
  if (!mfAllocationValid(hand, room.mfBoardCount)) {
    return { ok: false, error: 'Assign every card with board counts differing by at most 1' };
  }
  hand.locked = true;
  return { ok: true };
}

function allMfLocked(room) {
  return room.mfPlayers.every((name) => room.mfHands[name] && room.mfHands[name].locked);
}

function finalizeMenifotRound(roomCode, room) {
  clearMfRevealHandle(roomCode);

  const boardResults = [];
  const pointsAwarded = {};
  for (const name of room.mfPlayers) pointsAwarded[name] = 0;

  for (let bi = 0; bi < room.mfBoardCount; bi++) {
    const board = room.mfBoards[bi];
    const community = mfCommunityCards(board);
    const playersOnBoard = room.mfPlayers.map((name) => ({
      name,
      holeCards: (room.mfHands[name].allocation[bi] || []).slice(),
      boardCards: community,
    }));
    const { winners, rankings } = rankBoard(playersOnBoard);
    for (const w of winners) pointsAwarded[w] = (pointsAwarded[w] || 0) + 1;
    boardResults.push({ boardIndex: bi, winners, rankings });
  }

  for (const name of room.mfPlayers) {
    room.mfScores[name] = (room.mfScores[name] || 0) + (pointsAwarded[name] || 0);
  }

  room.mfRoundResults = {
    boards: boardResults,
    pointsAwarded,
    burned: room.mfBurned.slice(),
    allocations: Object.fromEntries(
      room.mfPlayers.map((name) => [
        name,
        Object.fromEntries(
          Object.entries(room.mfHands[name].allocation).map(([k, v]) => [k, v.slice()])
        ),
      ])
    ),
  };

  const reached = room.mfPlayers.filter((n) => (room.mfScores[n] || 0) >= MF_TARGET_SCORE);
  if (reached.length > 0) {
    room.mfMatchWinners = reached.slice();
    awardMenifotScoreboard(room);
    room.phase = 'gameover';
  } else {
    room.phase = 'roundResults';
  }

  broadcastMenifot(roomCode, room);
}

// Reveals each board's turn/river one at a time (instead of all at once) so the table
// watches boards flip in sequence before landing on the round-results screen. Stays in
// the 'allocating' phase throughout — every hand is already locked, so no further
// allocation moves are possible, and the client renders locked boards read-only.
function revealNextMfBoard(roomCode, room, boardIndex) {
  if (!rooms.has(roomCode) || rooms.get(roomCode) !== room) return;
  if (room.game !== 'menifot' || room.phase !== 'allocating') return;

  if (boardIndex >= room.mfBoards.length) {
    finalizeMenifotRound(roomCode, room);
    return;
  }

  room.mfBoards[boardIndex].revealed = true;
  broadcastMenifot(roomCode, room);
  mfRevealHandles.set(
    roomCode,
    setTimeout(() => revealNextMfBoard(roomCode, room, boardIndex + 1), MF_REVEAL_STEP_MS)
  );
}

function maybeRevealMenifot(roomCode, room) {
  if (room.game !== 'menifot' || room.phase !== 'allocating') return;
  if (!allMfLocked(room)) return;
  clearMfRevealHandle(roomCode);
  mfRevealHandles.set(
    roomCode,
    setTimeout(() => revealNextMfBoard(roomCode, room, 0), MF_REVEAL_STEP_MS)
  );
}

function awardMenifotScoreboard(room) {
  const N = room.mfPlayers.length;
  if (N < 1) return;
  const ranked = room.mfPlayers
    .map((name) => ({ name, score: room.mfScores[name] || 0 }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  let i = 0;
  while (i < ranked.length) {
    let j = i + 1;
    while (j < ranked.length && ranked[j].score === ranked[i].score) j += 1;
    const points = N - i;
    for (let k = i; k < j; k++) addScore(room, ranked[k].name, points);
    i = j;
  }
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
    if (room.phase === 'reporting') {
      return {
        ok: true,
        game: room.game,
        phase: room.phase,
        host: room.hostName,
        myAnswer:
          existing.eliminatedReport === null || existing.eliminatedReport === undefined
            ? null
            : !!existing.eliminatedReport,
        total: playersInImposterRound(room).length,
        answered: playersInImposterRound(room).filter((n) => {
          const p = room.players.get(n);
          return p && p.eliminatedReport !== null && p.eliminatedReport !== undefined;
        }).length,
      };
    }
    if (room.phase === 'roundResults') {
      return {
        ok: true,
        game: room.game,
        phase: room.phase,
        host: room.hostName,
        results: room.imposterRoundResults || [],
        scoreboard: scoreboardEntries(room),
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
        scoreboard: room.phase === 'gameover' ? scoreboardEntries(room) : undefined,
      };
    }
  }

  if (room.game === 'tenseconds') {
    let viewerName = null;
    for (const [n, p] of room.players.entries()) {
      if (p === existing) {
        viewerName = n;
        break;
      }
    }
    return { ok: true, ...tensSecondsStatePayload(room, viewerName) };
  }

  if (room.game === 'menifot') {
    let viewerName = null;
    for (const [n, p] of room.players.entries()) {
      if (p === existing) {
        viewerName = n;
        break;
      }
    }
    return { ok: true, ...menifotStatePayload(room, viewerName) };
  }

  return {
    ok: true,
    game: null,
    phase: 'lobby',
    players: connectedNames(room),
    host: room.hostName,
    scoreboard: scoreboardEntries(room),
  };
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
    else if (room.phase === 'reporting') broadcastImposterReporting(roomCode, room);
    else if (room.game === 'imposter' && room.phase === 'roundResults') {
      broadcastImposterResults(roomCode, room);
    } else if (room.game === 'tenseconds') {
      // Clear a mid-round DNF so a reconnecting player can still submit a live stop.
      if (
        room.phase === 'running' &&
        room.tsContenders.includes(name) &&
        room.tsRoundResults[name] &&
        room.tsRoundResults[name].dnf
      ) {
        delete room.tsRoundResults[name];
      }
      broadcastTensSeconds(roomCode, room);
    } else if (room.game === 'menifot') {
      broadcastMenifot(roomCode, room);
    } else if (room.phase === 'lobby') {
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
    eliminatedReport: null,
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
    scoreboard: scoreboardEntries(room),
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
      eliminatedReport: null,
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
      scoreboard: scoreboardEntries(room),
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
    if (selectedGame !== 'imposter' && selectedGame !== 'codenames' && selectedGame !== 'tenseconds' && selectedGame !== 'menifot') {
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

    if (selectedGame === 'tenseconds') {
      if (names.length < TS_MIN_PLAYERS) {
        return callback({ ok: false, error: `Need at least ${TS_MIN_PLAYERS} players` });
      }
      room.game = 'tenseconds';
      roomEmit(roomCode, 'gameChosen', { game: room.game });
      initTensSecondsGame(roomCode, room);
      return callback({ ok: true });
    }

    if (selectedGame === 'menifot') {
      if (names.length < MF_MIN_PLAYERS) {
        return callback({ ok: false, error: `Need at least ${MF_MIN_PLAYERS} players` });
      }
      if (names.length > MF_MAX_PLAYERS) {
        return callback({ ok: false, error: `Menifot supports at most ${MF_MAX_PLAYERS} players` });
      }
      room.game = 'menifot';
      roomEmit(roomCode, 'gameChosen', { game: room.game });
      initMenifotGame(roomCode, room);
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

  socket.on('resetScoreboard', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.phase !== 'lobby') return callback({ ok: false, error: 'Only available in the lobby' });
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can reset the scoreboard' });
    }

    room.scoreboard = {};
    callback({ ok: true });
    broadcastLobby(roomCode, room);
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

  // ----- 10 Seconds -----

  socket.on('startTensSeconds', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'tenseconds' || room.phase !== 'ready') {
      return callback({ ok: false, error: 'Not ready to start' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can start the round' });
    }
    if (room.tsActivePlayers.length < TS_MIN_PLAYERS) {
      return callback({ ok: false, error: `Need at least ${TS_MIN_PLAYERS} players` });
    }
    const waiting = tsDisconnectedActive(room);
    if (waiting.length > 0) {
      return callback({ ok: false, error: `Waiting for ${waiting.join(', ')} to reconnect` });
    }

    callback({ ok: true });
    startTensSecondsRound(roomCode, room);
  });

  socket.on('tsStop', (elapsedMs, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'tenseconds' || room.phase !== 'running') {
      return callback({ ok: false, error: 'Round is not running' });
    }
    if (!room.tsRoundStartAt || Date.now() < room.tsRoundStartAt) {
      return callback({ ok: false, error: 'Countdown still in progress' });
    }

    const name = socket.data.name;
    const result = submitTsStop(room, name, Number(elapsedMs));
    if (!result.ok) return callback(result);

    callback({ ok: true });
    broadcastTensSeconds(roomCode, room);
    maybeResolveTsRound(roomCode, room);
  });

  socket.on('tsContinue', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'tenseconds' || room.phase !== 'roundResults') {
      return callback({ ok: false, error: 'No results to continue from' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can continue' });
    }

    callback({ ok: true });
    continueTsAfterResults(roomCode, room);
  });

  socket.on('playAgainTensSeconds', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'tenseconds' || room.phase !== 'gameover') {
      return callback({ ok: false, error: 'Game is not over yet' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can play again' });
    }
    if (connectedNames(room).length < TS_MIN_PLAYERS) {
      return callback({ ok: false, error: `Need at least ${TS_MIN_PLAYERS} players` });
    }

    callback({ ok: true });
    initTensSecondsGame(roomCode, room, Array.from(room.players.keys()));
  });

  // ----- Menifot -----

  socket.on('startMenifot', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'menifot' || room.phase !== 'ready') {
      return callback({ ok: false, error: 'Not ready to start' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can start' });
    }

    // Mid-match ready (e.g. after server restart): reuse frozen roster.
    if (room.mfPlayers.length > 0) {
      callback({ ok: true });
      startMenifotNextRound(roomCode, room);
      return;
    }

    const names = connectedNames(room);
    if (names.length < MF_MIN_PLAYERS) {
      return callback({ ok: false, error: `Need at least ${MF_MIN_PLAYERS} players` });
    }
    if (names.length > MF_MAX_PLAYERS) {
      return callback({ ok: false, error: `Menifot supports at most ${MF_MAX_PLAYERS} players` });
    }

    callback({ ok: true });
    startMenifotMatch(roomCode, room, names);
  });

  socket.on('mfAssignCard', (data, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'menifot' || room.phase !== 'allocating') {
      return callback({ ok: false, error: 'Not allocating right now' });
    }

    const name = socket.data.name;
    const hand = room.mfHands[name];
    if (!hand) return callback({ ok: false, error: 'Not in this match' });

    const card = data && data.card;
    const boardIndex = data && data.boardIndex;
    const result = setMfCardBoard(hand, card, boardIndex, room.mfBoardCount);
    if (!result.ok) return callback(result);

    callback({ ok: true });
    broadcastMenifot(roomCode, room);
  });

  socket.on('mfLock', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'menifot' || room.phase !== 'allocating') {
      return callback({ ok: false, error: 'Not allocating right now' });
    }

    const name = socket.data.name;
    const result = lockMfHand(room, name);
    if (!result.ok) return callback(result);

    callback({ ok: true });
    broadcastMenifot(roomCode, room);
    maybeRevealMenifot(roomCode, room);
  });

  socket.on('mfNextRound', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'menifot' || room.phase !== 'roundResults') {
      return callback({ ok: false, error: 'No results to continue from' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can continue' });
    }

    callback({ ok: true });
    startMenifotNextRound(roomCode, room);
  });

  socket.on('playAgainMenifot', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'menifot' || room.phase !== 'gameover') {
      return callback({ ok: false, error: 'Match is not over yet' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can play again' });
    }

    const names = connectedNames(room);
    if (names.length < MF_MIN_PLAYERS) {
      return callback({ ok: false, error: `Need at least ${MF_MIN_PLAYERS} players` });
    }
    if (names.length > MF_MAX_PLAYERS) {
      return callback({ ok: false, error: `Menifot supports at most ${MF_MAX_PLAYERS} players` });
    }

    callback({ ok: true });
    startMenifotMatch(roomCode, room, names);
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
    } else if (room.phase === 'reporting') {
      // Disconnect before answering defaults to eliminated.
      if (p.eliminatedReport === null || p.eliminatedReport === undefined) {
        p.eliminatedReport = true;
      }
      broadcastImposterReporting(roomCode, room);
      maybeFinishImposterReporting(roomCode, room);
    } else if (room.phase === 'teamSelect') {
      broadcastTeamSelect(roomCode, room);
    } else if (room.game === 'codenames' && (room.phase === 'playing' || room.phase === 'gameover')) {
      broadcastCodenamesState(roomCode, room);
    } else if (room.game === 'tenseconds') {
      if (
        room.phase === 'running' &&
        room.tsContenders.includes(name) &&
        !room.tsRoundResults[name]
      ) {
        assignTsDnf(room, name);
        broadcastTensSeconds(roomCode, room);
        maybeResolveTsRound(roomCode, room);
      } else {
        broadcastTensSeconds(roomCode, room);
      }
    } else if (room.game === 'menifot') {
      if (room.phase === 'allocating' && room.mfHands[name] && !room.mfHands[name].locked) {
        autoLockEvenSplit(room.mfHands[name], room.mfBoardCount);
        broadcastMenifot(roomCode, room);
        maybeRevealMenifot(roomCode, room);
      } else {
        broadcastMenifot(roomCode, room);
      }
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
