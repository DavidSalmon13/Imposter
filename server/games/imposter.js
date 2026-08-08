'use strict';

const { shuffle } = require('../lib/shuffle');
const { chatCompletionJson } = require('../lib/openai');

const MIN_PLAYERS = 3;
const TWO_IMPOSTER_THRESHOLD = 5;
const LEVELS = ['easy', 'medium', 'hard'];

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

const SAVED_FIELDS = [
  'currentLevel',
  'lastImposterNames',
  'usedWords',
  'imposterRoundResults',
];

function clearState(room) {
  room.currentLevel = null;
  room.imposterRoundResults = null;
}

function broadcastVoting(ctx, roomCode, room) {
  const names = ctx.connectedNames(room);
  const voted = names.filter((n) => room.players.get(n).vote).length;
  ctx.roomEmit(roomCode, 'votingUpdate', { total: names.length, voted, host: room.hostName });
}

function tallyLevel(ctx, room) {
  const counts = { easy: 0, medium: 0, hard: 0 };
  for (const name of ctx.connectedNames(room)) {
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

function failImposterRound(ctx, roomCode, room, error) {
  room.phase = 'voting';
  room.currentLevel = null;
  for (const p of room.players.values()) p.vote = null;
  ctx.roomEmit(roomCode, 'votingStarted', {
    players: ctx.connectedNames(room),
    host: room.hostName,
  });
  ctx.roomEmit(roomCode, 'startFailed', { error });
}

async function finishVoting(ctx, roomCode, room) {
  const level = tallyLevel(ctx, room);
  room.currentLevel = level;
  room.phase = 'generating';
  ctx.roomEmit(roomCode, 'generating', { game: 'imposter', level });

  let word, hint;
  try {
    ({ word, hint } = await generateWordAndHint(room, level));
  } catch (err) {
    console.error('generateWordAndHint failed:', err.message);
    return failImposterRound(
      ctx,
      roomCode,
      room,
      'Could not reach ChatGPT to pick a word. Please try starting again.'
    );
  }

  // Room may have been deleted while awaiting OpenAI.
  if (!ctx.rooms.has(roomCode) || ctx.rooms.get(roomCode) !== room) return;

  const names = ctx.connectedNames(room);
  if (names.length < MIN_PLAYERS) {
    return failImposterRound(
      ctx,
      roomCode,
      room,
      `Not enough players remained connected (need ${MIN_PLAYERS}).`
    );
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
  ctx.roomEmit(roomCode, 'gameStarted', { level });
  for (const [, p] of room.players) {
    if (p.connected) {
      ctx.io.to(p.socketId).emit('role', { role: p.role, word: p.word, hint: p.hint });
    }
  }
}

function maybeFinishVoting(ctx, roomCode, room) {
  const names = ctx.connectedNames(room);
  if (names.length === 0) return;
  const allVoted = names.every((n) => room.players.get(n).vote);
  if (allVoted) finishVoting(ctx, roomCode, room);
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

function broadcastImposterReporting(ctx, roomCode, room) {
  const names = playersInImposterRound(room);
  const answered = names.filter((n) => {
    const p = room.players.get(n);
    return p && p.eliminatedReport !== null && p.eliminatedReport !== undefined;
  }).length;
  for (const [name, p] of room.players.entries()) {
    if (!p.connected || !p.socketId) continue;
    ctx.io.to(p.socketId).emit('imposterReporting', {
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

function broadcastImposterResults(ctx, roomCode, room) {
  ctx.roomEmit(roomCode, 'imposterResults', {
    host: room.hostName,
    results: room.imposterRoundResults || [],
    scoreboard: ctx.scoreboardEntries(room),
  });
}

function finishImposterReporting(ctx, roomCode, room) {
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
    ctx.addScore(room, name, points);
    results.push({
      name,
      role: p.role,
      eliminated,
      points,
    });
  }
  room.imposterRoundResults = results;
  room.phase = 'roundResults';
  broadcastImposterResults(ctx, roomCode, room);
}

function maybeFinishImposterReporting(ctx, roomCode, room) {
  if (room.game !== 'imposter' || room.phase !== 'reporting') return;
  const names = playersInImposterRound(room);
  if (names.length === 0) return;
  const allAnswered = names.every((n) => {
    const p = room.players.get(n);
    return p && p.eliminatedReport !== null && p.eliminatedReport !== undefined;
  });
  if (allAnswered) finishImposterReporting(ctx, roomCode, room);
}

function onChoose(ctx, roomCode, room) {
  for (const p of room.players.values()) p.vote = null;
  room.phase = 'voting';
  ctx.roomEmit(roomCode, 'votingStarted', {
    players: ctx.connectedNames(room),
    host: room.hostName,
  });
}

function reconnectPayload(ctx, room, existingPlayer) {
  if (room.phase === 'playing') {
    return {
      ok: true,
      game: room.game,
      phase: room.phase,
      level: room.currentLevel,
      role: existingPlayer.role,
      word: existingPlayer.word,
      hint: existingPlayer.hint,
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
        existingPlayer.eliminatedReport === null || existingPlayer.eliminatedReport === undefined
          ? null
          : !!existingPlayer.eliminatedReport,
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
      scoreboard: ctx.scoreboardEntries(room),
    };
  }
  if (room.phase === 'generating') {
    return {
      ok: true,
      game: room.game,
      phase: room.phase,
      level: room.currentLevel,
      host: room.hostName,
    };
  }
  if (room.phase === 'voting') {
    return {
      ok: true,
      game: room.game,
      phase: room.phase,
      players: ctx.connectedNames(room),
      vote: existingPlayer.vote,
      host: room.hostName,
    };
  }
  return {
    ok: true,
    game: room.game,
    phase: room.phase,
    host: room.hostName,
  };
}

function onDisconnect(ctx, roomCode, room, name) {
  if (room.phase === 'voting') {
    broadcastVoting(ctx, roomCode, room);
    maybeFinishVoting(ctx, roomCode, room);
  } else if (room.phase === 'reporting') {
    const p = room.players.get(name);
    // Disconnect before answering defaults to eliminated.
    if (p && (p.eliminatedReport === null || p.eliminatedReport === undefined)) {
      p.eliminatedReport = true;
    }
    broadcastImposterReporting(ctx, roomCode, room);
    maybeFinishImposterReporting(ctx, roomCode, room);
  }
}

function onReconnectBroadcast(ctx, roomCode, room) {
  if (room.phase === 'voting') broadcastVoting(ctx, roomCode, room);
  else if (room.phase === 'reporting') broadcastImposterReporting(ctx, roomCode, room);
  else if (room.phase === 'roundResults') broadcastImposterResults(ctx, roomCode, room);
}

function repairOnLoad(ctx, room) {
  if (room.phase === 'generating') {
    room.phase = 'voting';
    room.currentLevel = null;
    for (const p of room.players.values()) p.vote = null;
  }

  if (room.phase !== 'reporting') return;

  // After restart everyone is disconnected; default unanswered reports so reporting
  // can't hang forever waiting for answers that will never arrive.
  for (const name of playersInImposterRound(room)) {
    const p = room.players.get(name);
    if (p && (p.eliminatedReport === null || p.eliminatedReport === undefined)) {
      p.eliminatedReport = true;
    }
  }

  if (!ctx || !ctx.rooms) return;
  let roomCode = null;
  for (const [code, r] of ctx.rooms.entries()) {
    if (r === room) {
      roomCode = code;
      break;
    }
  }
  if (!roomCode) return;

  const names = playersInImposterRound(room);
  const allAnswered =
    names.length > 0 &&
    names.every((n) => {
      const p = room.players.get(n);
      return p && p.eliminatedReport !== null && p.eliminatedReport !== undefined;
    });
  if (allAnswered) finishImposterReporting(ctx, roomCode, room);
}

function registerHandlers(ctx, io, socket) {
  socket.on('vote', (level, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
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
    broadcastVoting(ctx, roomCode, room);
    maybeFinishVoting(ctx, roomCode, room);
  });

  socket.on('endImposterRound', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
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
    broadcastImposterReporting(ctx, roomCode, room);
    maybeFinishImposterReporting(ctx, roomCode, room);
  });

  socket.on('reportEliminated', (eliminated, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
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
    broadcastImposterReporting(ctx, roomCode, room);
    maybeFinishImposterReporting(ctx, roomCode, room);
  });
}

module.exports = {
  id: 'imposter',
  minPlayers: MIN_PLAYERS,
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
