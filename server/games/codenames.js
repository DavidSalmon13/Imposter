'use strict';

const { shuffle } = require('../lib/shuffle');
const { chatCompletionJson } = require('../lib/openai');

const CN_MIN_PLAYERS = 4;
const CN_MIN_TEAM_SIZE = 2;
const CN_WORD_COUNT = 25;
const CN_START_COUNT = 7;
const CN_OTHER_COUNT = 6;
const CN_ASSASSIN_COUNT = 1;
const CN_NEUTRAL_COUNT = CN_WORD_COUNT - CN_START_COUNT - CN_OTHER_COUNT - CN_ASSASSIN_COUNT;
const CN_TIMER_OPTIONS = [0, 60, 120]; // seconds; 0 = no timer

const SAVED_FIELDS = [
  'cnUsedWords',
  'cnBoard',
  'cnActiveTeam',
  'cnStartingTeam',
  'cnWinner',
  'cnScores',
  'cnTimerSeconds',
  'cnTurnEndsAt',
];

/** @type {Map<string, NodeJS.Timeout>} */
const cnTimerHandles = new Map();

function clearCnTimerHandle(roomCode) {
  const handle = cnTimerHandles.get(roomCode);
  if (handle) clearTimeout(handle);
  cnTimerHandles.delete(roomCode);
}

function clearState(room, roomCode) {
  if (roomCode) clearCnTimerHandle(roomCode);
  room.cnBoard = null;
  room.cnActiveTeam = null;
  room.cnStartingTeam = null;
  room.cnWinner = null;
  room.cnScores = { red: 0, blue: 0 };
  room.cnTimerSeconds = null;
  room.cnTurnEndsAt = null;
}

function startCnTimer(ctx, roomCode, room) {
  clearCnTimerHandle(roomCode);
  if (!room.cnTimerSeconds) {
    room.cnTurnEndsAt = null;
    return;
  }
  room.cnTurnEndsAt = Date.now() + room.cnTimerSeconds * 1000;
  cnTimerHandles.set(
    roomCode,
    setTimeout(() => cnTimerExpired(ctx, roomCode), room.cnTimerSeconds * 1000)
  );
}

function cnTimerExpired(ctx, roomCode) {
  const room = ctx.rooms.get(roomCode);
  if (!room || room.game !== 'codenames' || room.phase !== 'playing') return;
  room.cnActiveTeam = room.cnActiveTeam === 'red' ? 'blue' : 'red';
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
    timerSeconds: room.cnTimerSeconds || 0,
  });
}

function cnTeamValid(ctx, room, color) {
  const members = teamMembers(ctx, room, color);
  return members.length >= CN_MIN_TEAM_SIZE && members.some((n) => room.players.get(n).leader);
}

async function generateWordGrid(room) {
  const avoid = room.cnUsedWords.slice(-100);
  const languageInstruction =
    room.wordLanguage === 'hebrew' ? ' Write every word in Hebrew.' : '';
  const prompt =
    `Generate exactly ${CN_WORD_COUNT} common, family-friendly, single-word nouns suitable for a word-guessing ` +
    `party game grid. Each must be ONE word (no phrases, no proper nouns), instantly recognizable to most ` +
    `adults, covering a broad mix of categories (objects, animals, food, places, jobs, nature, sports, tools, ` +
    `clothing, etc). All ${CN_WORD_COUNT} words must be different from each other.${languageInstruction}` +
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

function broadcastCodenamesState(ctx, roomCode, room) {
  for (const [, p] of room.players) {
    if (!p.connected) continue;
    ctx.io.to(p.socketId).emit('codenamesState', {
      phase: room.phase,
      activeTeam: room.cnActiveTeam,
      winner: room.cnWinner,
      scores: room.cnScores,
      board: boardForViewer(room, p),
      isLeader: p.leader,
      myTeam: p.team,
      red: teamPlayersInfo(ctx, room, 'red'),
      blue: teamPlayersInfo(ctx, room, 'blue'),
      host: room.hostName,
      timerSeconds: room.cnTimerSeconds || 0,
      turnEndsAt: room.cnTurnEndsAt,
      scoreboard: room.phase === 'gameover' ? ctx.scoreboardEntries(room) : undefined,
    });
  }
}

function failCodenamesRound(ctx, roomCode, room, error) {
  room.phase = 'teamSelect';
  clearCnTimerHandle(roomCode);
  room.cnTurnEndsAt = null;
  broadcastTeamSelect(ctx, roomCode, room);
  ctx.roomEmit(roomCode, 'codenamesStartFailed', { error });
}

function checkTeamWin(room) {
  for (const color of ['red', 'blue']) {
    const remaining = room.cnBoard.filter((c) => c.color === color && !c.revealed);
    if (remaining.length === 0) return color;
  }
  return null;
}

function awardCodenamesScores(ctx, room) {
  if (!room.cnWinner) return;
  for (const [name, p] of room.players.entries()) {
    if (!p.team) continue;
    if (p.team === room.cnWinner) ctx.addScore(room, name, 2);
    // Losing team gets 0 — no scoreboard write needed.
  }
}

function finishCodenamesGame(ctx, roomCode, room) {
  room.phase = 'gameover';
  if (room.cnWinner) room.cnScores[room.cnWinner] += 1;
  awardCodenamesScores(ctx, room);
  clearCnTimerHandle(roomCode);
  room.cnTurnEndsAt = null;
  broadcastCodenamesState(ctx, roomCode, room);
}

async function generateCodenamesRound(ctx, roomCode, room) {
  room.phase = 'generating';
  ctx.roomEmit(roomCode, 'generating', { game: 'codenames' });

  let words;
  try {
    words = await generateWordGrid(room);
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
      board: boardForViewer(room, existingPlayer),
      isLeader: existingPlayer.leader,
      myTeam: existingPlayer.team,
      red: teamPlayersInfo(ctx, room, 'red'),
      blue: teamPlayersInfo(ctx, room, 'blue'),
      timerSeconds: room.cnTimerSeconds || 0,
      turnEndsAt: room.cnTurnEndsAt,
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
  if (room.phase !== 'playing' || !room.cnTimerSeconds || !room.cnTurnEndsAt || !ctx || !ctx.rooms) {
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

  const remaining = room.cnTurnEndsAt - Date.now();
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

    room.cnTimerSeconds = value || null;
    callback({ ok: true });
    broadcastTeamSelect(ctx, roomCode, room);
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

    room.cnStartingTeam = Math.random() < 0.5 ? 'red' : 'blue';
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
    if (!room.cnTimerSeconds) return callback({ ok: false, error: 'No timer set for this game' });
    if (room.cnTurnEndsAt) return callback({ ok: false, error: 'Timer already running' });

    const name = socket.data.name;
    const p = room.players.get(name);
    if (!p || p.team !== room.cnActiveTeam) {
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
      return finishCodenamesGame(ctx, roomCode, room);
    }

    if (cell.color !== room.cnActiveTeam) {
      room.cnActiveTeam = room.cnActiveTeam === 'red' ? 'blue' : 'red';
      startCnTimer(ctx, roomCode, room);
    }

    const winner = checkTeamWin(room);
    if (winner) {
      room.cnWinner = winner;
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
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can play again' });
    }
    if (!cnTeamValid(ctx, room, 'red') || !cnTeamValid(ctx, room, 'blue')) {
      return callback({ ok: false, error: 'Both teams need at least 2 players including a leader' });
    }

    room.cnStartingTeam = room.cnStartingTeam === 'red' ? 'blue' : 'red';
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
  savedFields: SAVED_FIELDS,
  repairOnLoad,
  clearState,
};
