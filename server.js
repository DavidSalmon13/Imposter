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

// Shared, app-wide state (single room, single game at a time).
let game = null; // null | 'imposter' | 'codenames'
let phase = 'lobby';
// Imposter phases: 'voting' | 'generating' | 'playing'
// Codenames phases: 'teamSelect' | 'generating' | 'playing' | 'gameover'
let hostName = null;
const players = new Map(); // name -> { socketId, connected, role, word, hint, vote, team, leader }

// Imposter-only state.
let currentLevel = null;
let lastImposterNames = [];
const usedWords = [];

// Codenames-only state.
const cnUsedWords = [];
let cnBoard = null; // [{ word, color: 'red'|'blue'|'neutral'|'assassin', revealed }]
let cnActiveTeam = null; // 'red' | 'blue'
let cnStartingTeam = null; // 'red' | 'blue'
let cnWinner = null; // 'red' | 'blue' | null
let cnScores = { red: 0, blue: 0 };

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

function setHost(name) {
  hostName = name;
  io.emit('hostUpdate', { host: hostName });
}

function resetToLobby() {
  for (const p of players.values()) {
    p.vote = null;
    p.role = null;
    p.word = null;
    p.hint = null;
    p.team = null;
    p.leader = false;
  }
  game = null;
  phase = 'lobby';
  currentLevel = null;
  cnBoard = null;
  cnActiveTeam = null;
  cnStartingTeam = null;
  cnWinner = null;
  cnScores = { red: 0, blue: 0 };
  io.emit('backToLobby');
  broadcastLobby();
}

// ---------- Imposter ----------

function broadcastVoting() {
  const names = connectedNames();
  const voted = names.filter((n) => players.get(n).vote).length;
  io.emit('votingUpdate', { total: names.length, voted, host: hostName });
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

  const avoid = usedWords.slice(-40);
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

function failImposterRound(error) {
  phase = 'voting';
  currentLevel = null;
  for (const p of players.values()) p.vote = null;
  io.emit('votingStarted', { players: connectedNames(), host: hostName });
  io.emit('startFailed', { error });
}

async function finishVoting() {
  const level = tallyLevel();
  currentLevel = level;
  phase = 'generating';
  io.emit('generating', { game: 'imposter', level });

  let word, hint;
  try {
    ({ word, hint } = await generateWordAndHint(level));
  } catch (err) {
    console.error('generateWordAndHint failed:', err.message);
    return failImposterRound('Could not reach ChatGPT to pick a word. Please try starting again.');
  }

  const names = connectedNames();
  if (names.length < MIN_PLAYERS) {
    return failImposterRound(`Not enough players remained connected (need ${MIN_PLAYERS}).`);
  }

  usedWords.push(word);
  if (usedWords.length > 80) usedWords.splice(0, usedWords.length - 80);

  const imposterCount = names.length >= TWO_IMPOSTER_THRESHOLD ? 2 : 1;
  const fresh = names.filter((n) => !lastImposterNames.includes(n));
  const candidates = fresh.length >= imposterCount ? fresh : names;
  const imposterNames = shuffle(candidates).slice(0, imposterCount);
  lastImposterNames = imposterNames;
  for (const [name, p] of players) {
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

// ---------- Codenames ----------

function teamMembers(color) {
  return connectedNames().filter((n) => players.get(n).team === color);
}

function teamPlayersInfo(color) {
  return teamMembers(color).map((n) => ({ name: n, leader: players.get(n).leader }));
}

function broadcastTeamSelect() {
  io.emit('teamSelectUpdate', {
    host: hostName,
    red: teamPlayersInfo('red'),
    blue: teamPlayersInfo('blue'),
    unassigned: connectedNames().filter((n) => !players.get(n).team),
  });
}

function cnTeamValid(color) {
  const members = teamMembers(color);
  return members.length >= CN_MIN_TEAM_SIZE && members.some((n) => players.get(n).leader);
}

async function generateWordGrid() {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured on the server');
  }

  const avoid = cnUsedWords.slice(-100);
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

function boardForViewer(p) {
  return cnBoard.map((cell) => {
    if (cell.revealed || p.leader) {
      return { word: cell.word, color: cell.color, revealed: cell.revealed };
    }
    return { word: cell.word, color: null, revealed: false };
  });
}

function broadcastCodenamesState() {
  for (const [, p] of players) {
    if (!p.connected) continue;
    io.to(p.socketId).emit('codenamesState', {
      phase,
      activeTeam: cnActiveTeam,
      winner: cnWinner,
      scores: cnScores,
      board: boardForViewer(p),
      isLeader: p.leader,
      myTeam: p.team,
      red: teamPlayersInfo('red'),
      blue: teamPlayersInfo('blue'),
      host: hostName,
    });
  }
}

function failCodenamesRound(error) {
  phase = 'teamSelect';
  broadcastTeamSelect();
  io.emit('codenamesStartFailed', { error });
}

function checkTeamWin() {
  for (const color of ['red', 'blue']) {
    const remaining = cnBoard.filter((c) => c.color === color && !c.revealed);
    if (remaining.length === 0) return color;
  }
  return null;
}

function finishCodenamesGame() {
  phase = 'gameover';
  if (cnWinner) cnScores[cnWinner] += 1;
  broadcastCodenamesState();
}

async function generateCodenamesRound() {
  phase = 'generating';
  io.emit('generating', { game: 'codenames' });

  let words;
  try {
    words = await generateWordGrid();
  } catch (err) {
    console.error('generateWordGrid failed:', err.message);
    return failCodenamesRound('Could not reach ChatGPT to build the board. Please try starting again.');
  }

  if (!cnTeamValid('red') || !cnTeamValid('blue')) {
    return failCodenamesRound('Not enough players remained on a team.');
  }

  for (const w of words) cnUsedWords.push(w);
  if (cnUsedWords.length > 150) cnUsedWords.splice(0, cnUsedWords.length - 150);

  cnBoard = buildBoard(words, cnStartingTeam);
  cnActiveTeam = cnStartingTeam;
  cnWinner = null;
  phase = 'playing';
  broadcastCodenamesState();
}

// ---------- Socket handlers ----------

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

      if (game === 'imposter') {
        if (phase === 'playing') {
          return callback({
            ok: true,
            game,
            phase,
            level: currentLevel,
            role: existing.role,
            word: existing.word,
            hint: existing.hint,
            host: hostName,
          });
        }
        if (phase === 'generating') {
          return callback({ ok: true, game, phase, level: currentLevel, host: hostName });
        }
        if (phase === 'voting') {
          broadcastVoting();
          return callback({
            ok: true,
            game,
            phase,
            players: connectedNames(),
            vote: existing.vote,
            host: hostName,
          });
        }
      }

      if (game === 'codenames') {
        if (phase === 'teamSelect') {
          broadcastTeamSelect();
          return callback({
            ok: true,
            game,
            phase,
            host: hostName,
            red: teamPlayersInfo('red'),
            blue: teamPlayersInfo('blue'),
            unassigned: connectedNames().filter((n) => !players.get(n).team),
          });
        }
        if (phase === 'generating') {
          return callback({ ok: true, game, phase, host: hostName });
        }
        if (phase === 'playing' || phase === 'gameover') {
          return callback({
            ok: true,
            game,
            phase,
            host: hostName,
            activeTeam: cnActiveTeam,
            winner: cnWinner,
            scores: cnScores,
            board: boardForViewer(existing),
            isLeader: existing.leader,
            myTeam: existing.team,
            red: teamPlayersInfo('red'),
            blue: teamPlayersInfo('blue'),
          });
        }
      }

      if (!hostName) setHost(name);
      broadcastLobby();
      return callback({ ok: true, game: null, phase: 'lobby', players: connectedNames(), host: hostName });
    }

    if (phase !== 'lobby') {
      return callback({ ok: false, error: 'Game already in progress, wait for the next round' });
    }

    players.set(name, {
      socketId: socket.id,
      connected: true,
      role: null,
      word: null,
      hint: null,
      vote: null,
      team: null,
      leader: false,
    });
    socket.data.name = name;
    if (!hostName) setHost(name);
    broadcastLobby();
    callback({ ok: true, game: null, phase: 'lobby', players: connectedNames(), host: hostName });
  });

  socket.on('chooseGame', (selectedGame, callback) => {
    callback = callback || (() => {});
    if (phase !== 'lobby') return callback({ ok: false, error: 'Game already chosen' });
    if (socket.data.name !== hostName) {
      return callback({ ok: false, error: 'Only the host can choose the game' });
    }
    if (selectedGame !== 'imposter' && selectedGame !== 'codenames') {
      return callback({ ok: false, error: 'Invalid game' });
    }

    const names = connectedNames();

    if (selectedGame === 'imposter') {
      if (names.length < MIN_PLAYERS) {
        return callback({ ok: false, error: `Need at least ${MIN_PLAYERS} players` });
      }
      game = 'imposter';
      for (const p of players.values()) p.vote = null;
      phase = 'voting';
      io.emit('gameChosen', { game });
      io.emit('votingStarted', { players: connectedNames(), host: hostName });
      return callback({ ok: true });
    }

    if (names.length < CN_MIN_PLAYERS) {
      return callback({ ok: false, error: `Need at least ${CN_MIN_PLAYERS} players` });
    }
    game = 'codenames';
    phase = 'teamSelect';
    io.emit('gameChosen', { game });
    broadcastTeamSelect();
    callback({ ok: true });
  });

  // ----- Imposter -----

  socket.on('vote', (level, callback) => {
    callback = callback || (() => {});
    if (game !== 'imposter' || phase !== 'voting') return callback({ ok: false, error: 'Voting is not open' });
    if (!LEVELS.includes(level)) return callback({ ok: false, error: 'Invalid level' });

    const name = socket.data.name;
    const p = players.get(name);
    if (!p) return callback({ ok: false, error: 'Not joined' });

    p.vote = level;
    callback({ ok: true });
    broadcastVoting();
    maybeFinishVoting();
  });

  // ----- Codenames -----

  socket.on('joinTeam', (color, callback) => {
    callback = callback || (() => {});
    if (game !== 'codenames' || phase !== 'teamSelect') {
      return callback({ ok: false, error: 'Not choosing teams right now' });
    }
    if (color !== 'red' && color !== 'blue') return callback({ ok: false, error: 'Invalid team' });

    const name = socket.data.name;
    const p = players.get(name);
    if (!p) return callback({ ok: false, error: 'Not joined' });

    if (p.team !== color) {
      p.team = color;
      p.leader = false;
    }
    callback({ ok: true });
    broadcastTeamSelect();
  });

  socket.on('claimLeader', (callback) => {
    callback = callback || (() => {});
    if (game !== 'codenames' || phase !== 'teamSelect') {
      return callback({ ok: false, error: 'Not choosing teams right now' });
    }

    const name = socket.data.name;
    const p = players.get(name);
    if (!p || !p.team) return callback({ ok: false, error: 'Join a team first' });

    const currentLeader = teamMembers(p.team).find((n) => players.get(n).leader);
    if (currentLeader && currentLeader !== name) {
      return callback({ ok: false, error: 'This team already has a leader' });
    }

    p.leader = true;
    callback({ ok: true });
    broadcastTeamSelect();
  });

  socket.on('startCodenames', (callback) => {
    callback = callback || (() => {});
    if (game !== 'codenames' || phase !== 'teamSelect') {
      return callback({ ok: false, error: 'Not ready to start' });
    }
    if (socket.data.name !== hostName) {
      return callback({ ok: false, error: 'Only the host can start the game' });
    }
    if (!cnTeamValid('red')) {
      return callback({ ok: false, error: 'Red team needs at least 2 players including a leader' });
    }
    if (!cnTeamValid('blue')) {
      return callback({ ok: false, error: 'Blue team needs at least 2 players including a leader' });
    }

    cnStartingTeam = Math.random() < 0.5 ? 'red' : 'blue';
    callback({ ok: true });
    generateCodenamesRound();
  });

  socket.on('guessWord', (index, callback) => {
    callback = callback || (() => {});
    if (game !== 'codenames' || phase !== 'playing') {
      return callback({ ok: false, error: 'Not playing right now' });
    }

    const name = socket.data.name;
    const p = players.get(name);
    if (!p) return callback({ ok: false, error: 'Not joined' });
    if (p.team !== cnActiveTeam) return callback({ ok: false, error: "Not your team's turn" });
    if (p.leader) return callback({ ok: false, error: 'Leaders cannot guess' });
    if (!Number.isInteger(index) || index < 0 || index >= CN_WORD_COUNT) {
      return callback({ ok: false, error: 'Invalid card' });
    }

    const cell = cnBoard[index];
    if (!cell || cell.revealed) return callback({ ok: false, error: 'Already revealed' });

    cell.revealed = true;
    callback({ ok: true });

    if (cell.color === 'assassin') {
      cnWinner = cnActiveTeam === 'red' ? 'blue' : 'red';
      return finishCodenamesGame();
    }

    if (cell.color !== cnActiveTeam) {
      cnActiveTeam = cnActiveTeam === 'red' ? 'blue' : 'red';
    }

    const winner = checkTeamWin();
    if (winner) {
      cnWinner = winner;
      return finishCodenamesGame();
    }

    broadcastCodenamesState();
  });

  socket.on('endTurn', (callback) => {
    callback = callback || (() => {});
    if (game !== 'codenames' || phase !== 'playing') {
      return callback({ ok: false, error: 'Not playing right now' });
    }

    const name = socket.data.name;
    const p = players.get(name);
    if (!p) return callback({ ok: false, error: 'Not joined' });
    if (p.team !== cnActiveTeam || p.leader) {
      return callback({ ok: false, error: 'Only active team guessers can end the turn' });
    }

    cnActiveTeam = cnActiveTeam === 'red' ? 'blue' : 'red';
    callback({ ok: true });
    broadcastCodenamesState();
  });

  socket.on('playAgainCodenames', (callback) => {
    callback = callback || (() => {});
    if (game !== 'codenames' || phase !== 'gameover') {
      return callback({ ok: false, error: 'Game is not over yet' });
    }

    const name = socket.data.name;
    const p = players.get(name);
    if (!p || !p.leader) {
      return callback({ ok: false, error: 'Only a team leader can start the next round' });
    }

    cnStartingTeam = cnStartingTeam === 'red' ? 'blue' : 'red';
    callback({ ok: true });
    generateCodenamesRound();
  });

  // ----- Shared -----

  socket.on('backToLobby', (callback) => {
    callback = callback || (() => {});
    if (socket.data.name !== hostName) {
      return callback({ ok: false, error: 'Only the host can return to the lobby' });
    }
    resetToLobby();
    callback({ ok: true });
  });

  socket.on('disconnect', () => {
    const name = socket.data.name;
    if (!name) return;
    const p = players.get(name);
    if (!p) return;

    if (phase === 'lobby' || phase === 'voting' || phase === 'teamSelect') {
      players.delete(name);
      if (name === hostName) {
        const [nextHost] = connectedNames();
        hostName = nextHost || null;
      }
      if (phase === 'voting') {
        broadcastVoting();
        maybeFinishVoting();
      } else if (phase === 'teamSelect') {
        broadcastTeamSelect();
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
    if (game === 'codenames' && (phase === 'playing' || phase === 'gameover')) {
      broadcastCodenamesState();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Imposter listening on ${PORT}`));
