require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const MIN_PLAYERS = 3;
const LEVELS = ['easy', 'medium', 'hard'];
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const LEVEL_INSTRUCTIONS = {
  easy: 'The hint should be quite revealing and specific, giving a strong clue toward the word while still not saying it outright.',
  medium: 'The hint should give a moderate, fairly general clue - enough to work with but requiring some real thought.',
  hard: 'The hint should be vague and abstract, giving only a subtle clue that requires real deduction.',
};

let phase = 'lobby'; // 'lobby' | 'voting' | 'generating' | 'playing'
let hostName = null;
let currentLevel = null;
const players = new Map(); // name -> { socketId, connected, role, word, hint, vote }
const usedWords = [];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function connectedNames() {
  return Array.from(players.entries())
    .filter(([, p]) => p.connected)
    .map(([name]) => name);
}

function broadcastLobby() {
  io.emit('lobbyUpdate', { players: connectedNames(), host: hostName });
}

function broadcastVoting() {
  const names = connectedNames();
  const voted = names.filter((n) => players.get(n).vote).length;
  io.emit('votingUpdate', { total: names.length, voted, host: hostName });
}

function setHost(name) {
  hostName = name;
  io.emit('hostUpdate', { host: hostName });
}

function tallyLevel() {
  const counts = { easy: 0, medium: 0, hard: 0 };
  for (const name of connectedNames()) {
    const vote = players.get(name).vote;
    if (vote) counts[vote] += 1;
  }
  const maxCount = Math.max(...LEVELS.map((l) => counts[l]));
  return LEVELS.find((l) => counts[l] === maxCount);
}

async function generateWordAndHint(level) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured on the server');
  }

  const avoid = usedWords.slice(-20);
  const prompt =
    `Pick one common, family-friendly word or short phrase (1-2 words) that most adults would instantly ` +
    `recognize - e.g. an everyday object, animal, food, place, sport, or job. Then write ONE short hint ` +
    `sentence (max ~15 words) about it for a party game, calibrated for a "${level}" difficulty level. ` +
    `${LEVEL_INSTRUCTIONS[level]} The hint must never contain the word itself or any part of it.` +
    (avoid.length ? ` Do not reuse any of these previous words: ${avoid.join(', ')}.` : '') +
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
      temperature: 1,
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

function failRound(error) {
  phase = 'lobby';
  currentLevel = null;
  for (const p of players.values()) p.vote = null;
  broadcastLobby();
  io.emit('startFailed', { error });
}

async function finishVoting() {
  const level = tallyLevel();
  currentLevel = level;
  phase = 'generating';
  io.emit('generating', { level });

  let word, hint;
  try {
    ({ word, hint } = await generateWordAndHint(level));
  } catch (err) {
    console.error('generateWordAndHint failed:', err.message);
    return failRound('Could not reach ChatGPT to pick a word. Please try starting again.');
  }

  const names = connectedNames();
  if (names.length < MIN_PLAYERS) {
    return failRound(`Not enough players remained connected (need ${MIN_PLAYERS}).`);
  }

  usedWords.push(word);
  if (usedWords.length > 50) usedWords.splice(0, usedWords.length - 50);

  const imposterName = names[Math.floor(Math.random() * names.length)];
  for (const [name, p] of players) {
    if (name === imposterName) {
      p.role = 'imposter';
      p.word = null;
      p.hint = hint;
    } else {
      p.role = 'crew';
      p.word = word;
      p.hint = null;
    }
  }

  phase = 'playing';
  io.emit('gameStarted', { level });
  for (const [, p] of players) {
    if (p.connected) {
      io.to(p.socketId).emit('role', { role: p.role, word: p.word, hint: p.hint });
    }
  }
}

function maybeFinishVoting() {
  const names = connectedNames();
  if (names.length === 0) return;
  const allVoted = names.every((n) => players.get(n).vote);
  if (allVoted) finishVoting();
}

io.on('connection', (socket) => {
  socket.on('join', (data, callback) => {
    callback = callback || (() => {});
    const name = ((data && data.name) || '').trim();

    if (!name) return callback({ ok: false, error: 'Name required' });
    if (name.length > 20) return callback({ ok: false, error: 'Name too long' });

    const existing = players.get(name);

    if (existing) {
      if (existing.connected) {
        return callback({ ok: false, error: 'That name is taken' });
      }
      existing.connected = true;
      existing.socketId = socket.id;
      socket.data.name = name;

      if (phase === 'playing') {
        return callback({
          ok: true,
          phase,
          level: currentLevel,
          role: existing.role,
          word: existing.word,
          hint: existing.hint,
          host: hostName,
        });
      }
      if (phase === 'generating') {
        return callback({ ok: true, phase, level: currentLevel, host: hostName });
      }
      if (phase === 'voting') {
        return callback({
          ok: true,
          phase,
          players: connectedNames(),
          vote: existing.vote,
          host: hostName,
        });
      }
      if (!hostName) setHost(name);
      broadcastLobby();
      return callback({ ok: true, phase: 'lobby', players: connectedNames(), host: hostName });
    }

    if (phase !== 'lobby') {
      return callback({ ok: false, error: 'Game already in progress, wait for the next round' });
    }

    players.set(name, { socketId: socket.id, connected: true, role: null, word: null, hint: null, vote: null });
    socket.data.name = name;
    if (!hostName) setHost(name);
    broadcastLobby();
    callback({ ok: true, phase: 'lobby', players: connectedNames(), host: hostName });
  });

  socket.on('start', (callback) => {
    callback = callback || (() => {});
    if (phase !== 'lobby') return callback({ ok: false, error: 'Game already started' });
    if (socket.data.name !== hostName) {
      return callback({ ok: false, error: 'Only the host can start the game' });
    }

    const names = connectedNames();
    if (names.length < MIN_PLAYERS) {
      return callback({ ok: false, error: `Need at least ${MIN_PLAYERS} players` });
    }

    for (const p of players.values()) p.vote = null;
    phase = 'voting';
    io.emit('votingStarted', { players: connectedNames(), host: hostName });
    callback({ ok: true });
  });

  socket.on('vote', (level, callback) => {
    callback = callback || (() => {});
    if (phase !== 'voting') return callback({ ok: false, error: 'Voting is not open' });
    if (!LEVELS.includes(level)) return callback({ ok: false, error: 'Invalid level' });

    const name = socket.data.name;
    const p = players.get(name);
    if (!p) return callback({ ok: false, error: 'Not joined' });

    p.vote = level;
    callback({ ok: true });
    broadcastVoting();
    maybeFinishVoting();
  });

  socket.on('newGame', (callback) => {
    callback = callback || (() => {});
    if (socket.data.name !== hostName) {
      return callback({ ok: false, error: 'Only the host can start a new game' });
    }
    players.clear();
    phase = 'lobby';
    hostName = null;
    currentLevel = null;
    io.emit('reset');
    callback({ ok: true });
  });

  socket.on('disconnect', () => {
    const name = socket.data.name;
    if (!name) return;
    const p = players.get(name);
    if (!p) return;

    if (phase === 'lobby' || phase === 'voting') {
      players.delete(name);
      if (name === hostName) {
        const [nextHost] = connectedNames();
        hostName = nextHost || null;
      }
      if (phase === 'voting') {
        broadcastVoting();
        maybeFinishVoting();
      } else {
        broadcastLobby();
      }
      return;
    }

    p.connected = false;
    if (name === hostName) {
      const [nextHost] = connectedNames();
      setHost(nextHost || null);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Imposter listening on ${PORT}`));
