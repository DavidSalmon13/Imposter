'use strict';

const { chatCompletionJson } = require('../lib/openai');

const MT_MIN_PLAYERS = 2;
const MT_MAX_PLAYERS = 10;
const MT_MIN_TEAMS = 2;
const MT_MAX_TEAMS = 4;
const MT_TEAM_IDS = ['A', 'B', 'C', 'D'];
const MT_TARGET_CARDS = 10;
const MT_STARTING_TOKENS = 2;
const MT_MAX_TOKENS = 5;
const MT_SKIP_COST = 1;
const MT_CHALLENGE_COST = 1;
const MT_AUTO_CARD_COST = 3;
const MT_USED_SONGS_AVOID_WINDOW = 40;
const MT_DIFFICULTIES = ['easy', 'pro', 'expert'];
const MT_DIFFICULTY_GUIDANCE = {
  easy: 'Pick a very famous, widely recognizable song most people would know instantly.',
  pro: 'Pick a moderately well-known song - not obscure, but not a top-40 giant either.',
  expert: 'Pick a song that can be a deeper cut - well-regarded but less mainstream is fine.',
};

const SAVED_FIELDS = [
  'mtMode',
  'mtDifficulty',
  'mtTeams',
  'mtActiveTeamIndex',
  'mtCurrentSong',
  'mtCurrentChallenge',
  'mtPendingPlacement',
  'mtRevealResult',
  'mtIdConfirmed',
  'mtUsedSongs',
  'mtRoundNumber',
  'mtMatchWinners',
];

function clearState(room) {
  room.mtMode = null;
  room.mtDifficulty = null;
  room.mtTeams = {};
  room.mtActiveTeamIndex = 0;
  room.mtCurrentSong = null;
  room.mtPendingPlacement = null;
  room.mtRevealResult = null;
  room.mtIdConfirmed = false;
  room.mtCurrentChallenge = null;
  room.mtUsedSongs = [];
  room.mtRoundNumber = 0;
  room.mtMatchWinners = [];
}

/** Team ids currently configured (pre-start slot list, in formation order A→D). */
function mtTeamIds(room) {
  return Object.keys(room.mtTeams || {});
}

function mtTeamMembers(ctx, room, teamId) {
  return ctx.connectedNames(room).filter((n) => room.players.get(n).team === teamId);
}

/** Resize the pre-start team slots to `count` (keeps existing A.. prefix, drops the rest). */
function resizeMtTeams(room, count) {
  const ids = MT_TEAM_IDS.slice(0, count);
  const validSet = new Set(ids);
  for (const p of room.players.values()) {
    if (p.team && !validSet.has(p.team)) p.team = null;
  }
  const kept = {};
  for (const id of ids) kept[id] = room.mtTeams[id] || {};
  room.mtTeams = kept;
}

/**
 * Whether `releaseYear` is a valid (correct) placement at `slotIndex` among `timeline`'s
 * existing songs (BEFORE first / BETWEEN a pair / AFTER last). Same-year ties are valid on
 * either adjacent slot since the boundary comparisons are inclusive. Pure - no room/ctx.
 */
function checkPlacement(timeline, releaseYear, slotIndex) {
  const before = slotIndex > 0 ? timeline[slotIndex - 1].releaseYear : null;
  const after = slotIndex < timeline.length ? timeline[slotIndex].releaseYear : null;
  if (before !== null && releaseYear < before) return false;
  if (after !== null && releaseYear > after) return false;
  return true;
}

/** Inserts `song` at its true chronological position, regardless of which slot was tapped. */
function insertIntoTimeline(timeline, song) {
  const insertAt = timeline.findIndex((s) => s.releaseYear > song.releaseYear);
  const next = timeline.slice();
  next.splice(insertAt === -1 ? timeline.length : insertAt, 0, song);
  return next;
}

/** Team id(s) whose timeline has reached MT_TARGET_CARDS (supports simultaneous co-champions). */
function checkMtWin(room) {
  return Object.entries(room.mtTeams || {})
    .filter(([, team]) => (team.timeline || []).length >= MT_TARGET_CARDS)
    .map(([id]) => id);
}

/**
 * Ranks teams by final card count (standard competition ranking - ties share a rank and the
 * next rank skips accordingly), then fans each team's points out to every player on that team,
 * connected or not. Mirrors awardMenifotScoreboard's tie-handling.
 */
function awardMtScoreboard(ctx, room) {
  const ids = mtTeamIds(room);
  const N = ids.length;
  if (N < 1) return;
  const ranked = ids
    .map((id) => ({ id, count: (room.mtTeams[id].timeline || []).length }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));

  const pointsByTeam = {};
  let i = 0;
  while (i < ranked.length) {
    let j = i + 1;
    while (j < ranked.length && ranked[j].count === ranked[i].count) j += 1;
    const points = N - i;
    for (let k = i; k < j; k++) pointsByTeam[ranked[k].id] = points;
    i = j;
  }

  for (const [name, p] of room.players.entries()) {
    const points = p.team ? pointsByTeam[p.team] : undefined;
    if (points) ctx.addScore(room, name, points);
  }
}

/** Advances mtActiveTeamIndex to the next team (wrapping) with >=1 connected member. */
function advanceTurn(ctx, room) {
  const ids = mtTeamIds(room);
  if (!ids.length) return;
  for (let step = 1; step <= ids.length; step++) {
    const next = (room.mtActiveTeamIndex + step) % ids.length;
    if (mtTeamMembers(ctx, room, ids[next]).length >= 1) {
      room.mtActiveTeamIndex = next;
      return;
    }
  }
}

async function generateMusicTimelineSong(room, difficulty) {
  const avoid = room.mtUsedSongs.slice(-MT_USED_SONGS_AVOID_WINDOW);
  const guidance = MT_DIFFICULTY_GUIDANCE[difficulty] || MT_DIFFICULTY_GUIDANCE.easy;
  const prompt =
    `Pick one real, released song for a music-trivia party game where players guess its release era. ` +
    `${guidance} It must have a well-documented, unambiguous original release year.` +
    (avoid.length
      ? ` These songs were already used this match - you MUST pick something different from all of them ` +
        `(compare by title AND artist): ${avoid.map((s) => `"${s.title}" by ${s.artist}`).join(', ')}.`
      : '') +
    ` Respond with ONLY compact JSON in the form {"title": "...", "artist": "...", "releaseYear": ####}.`;

  const parsed = await chatCompletionJson(prompt, { temperature: 1.1 });
  const title = String(parsed.title || '').trim();
  const artist = String(parsed.artist || '').trim();
  const releaseYear = Number(parsed.releaseYear);

  if (!title || !artist || !Number.isInteger(releaseYear)) {
    throw new Error('Incomplete response from OpenAI');
  }

  return { title, artist, releaseYear };
}

/** One starting card per team, sequential so each call's avoid-list includes the prior picks. */
async function dealStartingCards(room) {
  for (const teamId of Object.keys(room.mtTeams)) {
    const song = await generateMusicTimelineSong(room, room.mtDifficulty);
    room.mtTeams[teamId].timeline = [song];
    room.mtUsedSongs.push({ title: song.title, artist: song.artist });
  }
}

function mtCanStart(ctx, room) {
  if (room.mtMode === 'solo') {
    return ctx.connectedNames(room).length >= MT_MIN_PLAYERS;
  }
  const ids = mtTeamIds(room);
  if (ids.length < MT_MIN_TEAMS || ids.length > MT_MAX_TEAMS) return false;
  return ids.every((id) => mtTeamMembers(ctx, room, id).length >= 1);
}

function mtTeamSelectPayload(ctx, room) {
  const teams =
    room.mtMode === 'solo'
      ? []
      : mtTeamIds(room).map((id) => ({
          id,
          name: `Team ${id}`,
          members: mtTeamMembers(ctx, room, id),
        }));
  return {
    ok: true,
    game: 'musictimeline',
    phase: room.phase,
    host: room.hostName,
    mode: room.mtMode,
    difficulty: room.mtDifficulty,
    teams,
    canStart: mtCanStart(ctx, room),
  };
}

function broadcastMtTeamSelect(ctx, roomCode, room) {
  ctx.roomEmit(roomCode, 'mtTeamSelectUpdate', mtTeamSelectPayload(ctx, room));
}

function mtActiveTeamId(room) {
  const ids = Object.keys(room.mtTeams || {});
  return ids[room.mtActiveTeamIndex] || null;
}

function mtTeamsForDisplay(room) {
  return Object.entries(room.mtTeams || {}).map(([id, team]) => ({
    id,
    name: team.name,
    timeline: team.timeline || [],
    tokens: team.tokens,
  }));
}

function mtStatePayload(ctx, room, viewerName) {
  const isHost = viewerName === room.hostName;
  const viewer = room.players.get(viewerName);
  const myTeamId = viewer ? viewer.team : null;
  const activeTeamId = mtActiveTeamId(room);
  const activeTeam = activeTeamId ? room.mtTeams[activeTeamId] : null;
  const activeTokens = activeTeam ? activeTeam.tokens || 0 : 0;
  const myTeam = myTeamId ? room.mtTeams[myTeamId] : null;
  const canChallenge =
    room.phase === 'locked' &&
    !room.mtCurrentChallenge &&
    !!myTeamId &&
    myTeamId !== activeTeamId &&
    !!myTeam &&
    (myTeam.tokens || 0) >= MT_CHALLENGE_COST;
  return {
    game: 'musictimeline',
    phase: room.phase,
    host: room.hostName,
    viewerName,
    myTeam: myTeamId,
    mode: room.mtMode,
    difficulty: room.mtDifficulty,
    teams: mtTeamsForDisplay(room),
    activeTeamId,
    roundNumber: room.mtRoundNumber,
    // The pending song is only ever sent to the host, regardless of team, before it's revealed -
    // the host is the one who plays it out loud. Once revealed, everyone gets to see it.
    currentSong: isHost || room.phase === 'revealed' ? room.mtCurrentSong : null,
    pendingSlotIndex: room.mtPendingPlacement ? room.mtPendingPlacement.slotIndex : null,
    revealResult: room.phase === 'revealed' ? room.mtRevealResult : null,
    idConfirmed: room.mtIdConfirmed,
    canSkip: room.phase === 'placing' && activeTokens >= MT_SKIP_COST,
    canAutoCard: room.phase === 'placing' && activeTokens >= MT_AUTO_CARD_COST,
    canChallenge,
    currentChallenge: room.mtCurrentChallenge,
    matchWinners: (room.mtMatchWinners || []).slice(),
    scoreboard: room.phase === 'gameover' ? ctx.scoreboardEntries(room) : undefined,
  };
}

function broadcastMt(ctx, roomCode, room) {
  for (const [name, p] of room.players.entries()) {
    if (!p.connected || !p.socketId) continue;
    ctx.io.to(p.socketId).emit('mtState', mtStatePayload(ctx, room, name));
  }
}

/** Reverts a failed OpenAI call made while still in team-select (dealing starting cards). */
function failMtStart(ctx, roomCode, room, error) {
  room.phase = 'teamSelect';
  broadcastMtTeamSelect(ctx, roomCode, room);
  ctx.roomEmit(roomCode, 'mtStartFailed', { error });
}

/** Reverts a failed OpenAI call made mid-match (picking the next turn's song). */
function failMtRound(ctx, roomCode, room, error) {
  room.phase = 'ready';
  room.mtCurrentSong = null;
  room.mtPendingPlacement = null;
  broadcastMt(ctx, roomCode, room);
  ctx.roomEmit(roomCode, 'mtStartFailed', { error });
}

async function finishStartingMusicTimeline(ctx, roomCode, room, mtTeams) {
  room.mtTeams = mtTeams;
  room.mtActiveTeamIndex = 0;
  room.mtRoundNumber = 0;
  room.mtUsedSongs = [];
  room.mtCurrentSong = null;
  room.mtCurrentChallenge = null;
  room.mtMatchWinners = [];
  room.phase = 'generating';
  ctx.roomEmit(roomCode, 'generating', { game: 'musictimeline' });

  try {
    await dealStartingCards(room);
  } catch (err) {
    console.error('dealStartingCards failed:', err.message);
    return failMtStart(
      ctx,
      roomCode,
      room,
      'Could not reach ChatGPT to deal starting cards. Please try starting again.'
    );
  }

  // Room may have been reset while awaiting OpenAI.
  if (!ctx.rooms.has(roomCode) || ctx.rooms.get(roomCode) !== room) return;

  room.phase = 'ready';
  broadcastMt(ctx, roomCode, room);
}

async function mtNextTurn(ctx, roomCode, room) {
  room.phase = 'generating';
  ctx.roomEmit(roomCode, 'generating', { game: 'musictimeline' });

  let song;
  try {
    song = await generateMusicTimelineSong(room, room.mtDifficulty);
  } catch (err) {
    console.error('generateMusicTimelineSong failed:', err.message);
    return failMtRound(ctx, roomCode, room, 'Could not reach ChatGPT to pick a song. Please try again.');
  }

  if (!ctx.rooms.has(roomCode) || ctx.rooms.get(roomCode) !== room) return;

  room.mtUsedSongs.push({ title: song.title, artist: song.artist });
  room.mtCurrentSong = song;
  room.mtPendingPlacement = null;
  room.mtRevealResult = null;
  room.mtIdConfirmed = false;
  room.phase = 'placing';
  broadcastMt(ctx, roomCode, room);
}

/**
 * Applies the active team's locked placement (and, if one was claimed, the challenger's own
 * placement) and moves the match into `revealed`. A successful challenge takes the card outright
 * - the active team is scored for display purposes but does not receive the card even if their
 * own placement was also correct. A failed challenge costs the challenger a token and leaves the
 * active team's own result untouched.
 */
function revealMtPlacement(ctx, room) {
  const activeTeamId = mtActiveTeamId(room);
  const activeTeam = room.mtTeams[activeTeamId];
  const song = room.mtCurrentSong;
  const slotIndex = room.mtPendingPlacement ? room.mtPendingPlacement.slotIndex : 0;
  const activeCorrect = checkPlacement(activeTeam.timeline, song.releaseYear, slotIndex);

  const challenge = room.mtCurrentChallenge;
  let challengeResult = null;

  if (challenge && challenge.slotIndex != null) {
    const challengerTeam = room.mtTeams[challenge.team];
    const challengerCorrect = checkPlacement(challengerTeam.timeline, song.releaseYear, challenge.slotIndex);
    challengeResult = { teamId: challenge.team, correct: challengerCorrect };

    if (challengerCorrect) {
      challengerTeam.timeline = insertIntoTimeline(challengerTeam.timeline, song);
    } else {
      challengerTeam.tokens = Math.max(0, (challengerTeam.tokens || 0) - MT_CHALLENGE_COST);
      if (activeCorrect) {
        activeTeam.timeline = insertIntoTimeline(activeTeam.timeline, song);
      }
    }
  } else if (activeCorrect) {
    activeTeam.timeline = insertIntoTimeline(activeTeam.timeline, song);
  }

  room.mtRevealResult = { teamId: activeTeamId, correct: activeCorrect, challenge: challengeResult };
  room.mtPendingPlacement = null;
  room.mtCurrentChallenge = null;
  room.mtIdConfirmed = false;
  room.phase = 'revealed';

  const winners = checkMtWin(room);
  if (winners.length) {
    room.mtMatchWinners = winners;
    room.phase = 'gameover';
    awardMtScoreboard(ctx, room);
  }
}

function onChoose(ctx, roomCode, room) {
  clearState(room);
  room.phase = 'teamSelect';
  room.mtMode = 'team';
  room.mtDifficulty = 'easy';
  resizeMtTeams(room, MT_MIN_TEAMS);
  broadcastMtTeamSelect(ctx, roomCode, room);
}

function registerHandlers(ctx, io, socket) {
  socket.on('setMtMode', (mode, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'musictimeline' || room.phase !== 'teamSelect') {
      return callback({ ok: false, error: 'Not setting up right now' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can set the mode' });
    }
    if (mode !== 'team' && mode !== 'solo') return callback({ ok: false, error: 'Invalid mode' });

    room.mtMode = mode;
    if (mode === 'solo') {
      for (const p of room.players.values()) p.team = null;
    }
    callback({ ok: true });
    broadcastMtTeamSelect(ctx, roomCode, room);
  });

  socket.on('setMtDifficulty', (level, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'musictimeline' || room.phase !== 'teamSelect') {
      return callback({ ok: false, error: 'Not setting up right now' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can set the difficulty' });
    }
    if (!MT_DIFFICULTIES.includes(level)) return callback({ ok: false, error: 'Invalid difficulty' });

    room.mtDifficulty = level;
    callback({ ok: true });
    broadcastMtTeamSelect(ctx, roomCode, room);
  });

  socket.on('setMtTeamCount', (count, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'musictimeline' || room.phase !== 'teamSelect') {
      return callback({ ok: false, error: 'Not setting up right now' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can set the team count' });
    }
    if (room.mtMode !== 'team') return callback({ ok: false, error: 'Switch to Team mode first' });
    const value = Number(count);
    if (!Number.isInteger(value) || value < MT_MIN_TEAMS || value > MT_MAX_TEAMS) {
      return callback({ ok: false, error: `Choose between ${MT_MIN_TEAMS} and ${MT_MAX_TEAMS} teams` });
    }

    resizeMtTeams(room, value);
    callback({ ok: true });
    broadcastMtTeamSelect(ctx, roomCode, room);
  });

  socket.on('joinMtTeam', (data, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'musictimeline' || room.phase !== 'teamSelect') {
      return callback({ ok: false, error: 'Not choosing teams right now' });
    }
    if (room.mtMode !== 'team') return callback({ ok: false, error: 'Not in Team mode' });

    const teamId = data && data.teamId;
    if (!room.mtTeams[teamId]) return callback({ ok: false, error: 'Invalid team' });

    const name = socket.data.name;
    const p = room.players.get(name);
    if (!p) return callback({ ok: false, error: 'Not joined' });

    p.team = teamId;
    callback({ ok: true });
    broadcastMtTeamSelect(ctx, roomCode, room);
  });

  socket.on('startMusicTimeline', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'musictimeline' || room.phase !== 'teamSelect') {
      return callback({ ok: false, error: 'Not ready to start' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can start the match' });
    }

    const mtTeams = {};
    if (room.mtMode === 'solo') {
      const connected = ctx.connectedNames(room);
      if (connected.length < MT_MIN_PLAYERS) {
        return callback({ ok: false, error: `Need at least ${MT_MIN_PLAYERS} players` });
      }
      connected.forEach((name) => {
        room.players.get(name).team = name;
        mtTeams[name] = { name, timeline: [], tokens: MT_STARTING_TOKENS };
      });
    } else {
      const ids = mtTeamIds(room);
      if (ids.length < MT_MIN_TEAMS || ids.length > MT_MAX_TEAMS) {
        return callback({ ok: false, error: `Choose between ${MT_MIN_TEAMS} and ${MT_MAX_TEAMS} teams` });
      }
      const emptyTeam = ids.find((id) => mtTeamMembers(ctx, room, id).length < 1);
      if (emptyTeam) {
        return callback({ ok: false, error: `Team ${emptyTeam} needs at least 1 player` });
      }
      for (const id of ids) {
        mtTeams[id] = { name: `Team ${id}`, timeline: [], tokens: MT_STARTING_TOKENS };
      }
    }

    callback({ ok: true });
    finishStartingMusicTimeline(ctx, roomCode, room, mtTeams);
  });

  socket.on('mtNextTurn', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'musictimeline' || (room.phase !== 'ready' && room.phase !== 'revealed')) {
      return callback({ ok: false, error: 'Not ready for the next turn' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can start the next turn' });
    }

    // A turn only just resolved (not the very first turn after Start) - advance to whoever's next.
    if (room.phase === 'revealed') {
      advanceTurn(ctx, room);
      room.mtRoundNumber += 1;
    }

    callback({ ok: true });
    mtNextTurn(ctx, roomCode, room);
  });

  socket.on('mtReveal', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'musictimeline' || room.phase !== 'locked') {
      return callback({ ok: false, error: 'Nothing to reveal' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can reveal' });
    }

    revealMtPlacement(ctx, room);
    callback({ ok: true });
    broadcastMt(ctx, roomCode, room);
  });

  socket.on('mtConfirmId', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'musictimeline' || room.phase !== 'revealed') {
      return callback({ ok: false, error: 'Nothing to confirm right now' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can confirm this' });
    }

    if (!room.mtIdConfirmed) {
      const teamId = room.mtRevealResult && room.mtRevealResult.teamId;
      const team = teamId && room.mtTeams[teamId];
      if (team) team.tokens = Math.min(MT_MAX_TOKENS, (team.tokens || 0) + 1);
      room.mtIdConfirmed = true;
    }

    callback({ ok: true });
    broadcastMt(ctx, roomCode, room);
  });

  socket.on('mtPlaceSong', (data, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'musictimeline' || room.phase !== 'placing') {
      return callback({ ok: false, error: 'Not placing right now' });
    }

    const name = socket.data.name;
    const p = room.players.get(name);
    const activeTeamId = mtActiveTeamId(room);
    if (!p || !activeTeamId || p.team !== activeTeamId) {
      return callback({ ok: false, error: "Not your team's turn" });
    }

    const activeTeam = room.mtTeams[activeTeamId];
    const slotCount = (activeTeam.timeline || []).length + 1;
    const slotIndex = Number(data && data.slotIndex);
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= slotCount) {
      return callback({ ok: false, error: 'Invalid slot' });
    }

    room.mtPendingPlacement = { slotIndex };
    room.phase = 'locked';
    callback({ ok: true });
    broadcastMt(ctx, roomCode, room);
  });

  socket.on('mtSkipSong', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'musictimeline' || room.phase !== 'placing') {
      return callback({ ok: false, error: 'Not placing right now' });
    }

    const name = socket.data.name;
    const p = room.players.get(name);
    const activeTeamId = mtActiveTeamId(room);
    if (!p || !activeTeamId || p.team !== activeTeamId) {
      return callback({ ok: false, error: "Not your team's turn" });
    }

    const activeTeam = room.mtTeams[activeTeamId];
    if ((activeTeam.tokens || 0) < MT_SKIP_COST) {
      return callback({ ok: false, error: 'Not enough tokens to skip' });
    }

    activeTeam.tokens -= MT_SKIP_COST;
    const song = room.mtCurrentSong;
    if (song) room.mtUsedSongs.push({ title: song.title, artist: song.artist });
    room.mtCurrentSong = null;

    callback({ ok: true });
    mtNextTurn(ctx, roomCode, room);
  });

  socket.on('mtAutoCard', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'musictimeline' || room.phase !== 'placing') {
      return callback({ ok: false, error: 'Not placing right now' });
    }

    const name = socket.data.name;
    const p = room.players.get(name);
    const activeTeamId = mtActiveTeamId(room);
    if (!p || !activeTeamId || p.team !== activeTeamId) {
      return callback({ ok: false, error: "Not your team's turn" });
    }

    const activeTeam = room.mtTeams[activeTeamId];
    if ((activeTeam.tokens || 0) < MT_AUTO_CARD_COST) {
      return callback({ ok: false, error: 'Not enough tokens for Auto Card' });
    }

    activeTeam.tokens -= MT_AUTO_CARD_COST;
    const song = room.mtCurrentSong;
    activeTeam.timeline = insertIntoTimeline(activeTeam.timeline, song);
    room.mtRevealResult = { teamId: activeTeamId, correct: true };
    room.mtPendingPlacement = null;
    room.mtIdConfirmed = false;
    room.phase = 'revealed';

    const winners = checkMtWin(room);
    if (winners.length) {
      room.mtMatchWinners = winners;
      room.phase = 'gameover';
      awardMtScoreboard(ctx, room);
    }

    callback({ ok: true });
    broadcastMt(ctx, roomCode, room);
  });

  socket.on('mtChallenge', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'musictimeline' || room.phase !== 'locked') {
      return callback({ ok: false, error: 'Nothing to challenge right now' });
    }

    const name = socket.data.name;
    const p = room.players.get(name);
    const activeTeamId = mtActiveTeamId(room);
    if (!p || !p.team || !room.mtTeams[p.team]) {
      return callback({ ok: false, error: 'Not on a team' });
    }
    if (p.team === activeTeamId) {
      return callback({ ok: false, error: "Can't challenge your own team" });
    }
    if (room.mtCurrentChallenge) {
      return callback({ ok: false, error: 'Another team already claimed the challenge' });
    }

    const challengerTeam = room.mtTeams[p.team];
    if ((challengerTeam.tokens || 0) < MT_CHALLENGE_COST) {
      return callback({ ok: false, error: 'Not enough tokens to challenge' });
    }

    room.mtCurrentChallenge = { team: p.team, slotIndex: null };
    callback({ ok: true });
    broadcastMt(ctx, roomCode, room);
  });

  socket.on('mtChallengePlace', (data, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'musictimeline' || room.phase !== 'locked') {
      return callback({ ok: false, error: 'Nothing to place right now' });
    }

    const name = socket.data.name;
    const p = room.players.get(name);
    const challenge = room.mtCurrentChallenge;
    if (!p || !challenge || p.team !== challenge.team) {
      return callback({ ok: false, error: "Not your team's challenge" });
    }
    if (challenge.slotIndex != null) {
      return callback({ ok: false, error: 'Already placed' });
    }

    const challengerTeam = room.mtTeams[challenge.team];
    const slotCount = (challengerTeam.timeline || []).length + 1;
    const slotIndex = Number(data && data.slotIndex);
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= slotCount) {
      return callback({ ok: false, error: 'Invalid slot' });
    }

    challenge.slotIndex = slotIndex;
    callback({ ok: true });
    broadcastMt(ctx, roomCode, room);
  });

  socket.on('playAgainMusicTimeline', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'musictimeline' || room.phase !== 'gameover') {
      return callback({ ok: false, error: 'Match is not over yet' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can play again' });
    }

    const mtTeams = {};
    if (room.mtMode === 'solo') {
      const connected = ctx.connectedNames(room);
      if (connected.length < MT_MIN_PLAYERS) {
        return callback({ ok: false, error: `Need at least ${MT_MIN_PLAYERS} players` });
      }
      connected.forEach((name) => {
        room.players.get(name).team = name;
        mtTeams[name] = { name, timeline: [], tokens: MT_STARTING_TOKENS };
      });
    } else {
      const survivingIds = mtTeamIds(room).filter((id) => mtTeamMembers(ctx, room, id).length >= 1);
      if (survivingIds.length < MT_MIN_TEAMS) {
        return callback({ ok: false, error: `Need at least ${MT_MIN_TEAMS} teams with a connected player` });
      }
      for (const id of survivingIds) {
        mtTeams[id] = { name: room.mtTeams[id].name, timeline: [], tokens: MT_STARTING_TOKENS };
      }
    }

    callback({ ok: true });
    finishStartingMusicTimeline(ctx, roomCode, room, mtTeams);
  });
}

function reconnectPayload(ctx, room, existingPlayer) {
  if (room.phase === 'teamSelect') {
    return mtTeamSelectPayload(ctx, room);
  }

  let viewerName = null;
  for (const [n, p] of room.players.entries()) {
    if (p === existingPlayer) {
      viewerName = n;
      break;
    }
  }
  return { ok: true, ...mtStatePayload(ctx, room, viewerName) };
}

function onDisconnect(ctx, roomCode, room, name) {
  if (room.phase === 'teamSelect') {
    broadcastMtTeamSelect(ctx, roomCode, room);
    return;
  }

  if (room.phase === 'placing' || room.phase === 'locked') {
    const activeTeamId = mtActiveTeamId(room);
    if (activeTeamId && mtTeamMembers(ctx, room, activeTeamId).length === 0) {
      // Active team is now fully disconnected - the pending song can never be placed. Discard
      // it, advance to whoever's next, and immediately start generating their turn.
      const song = room.mtCurrentSong;
      if (song) room.mtUsedSongs.push({ title: song.title, artist: song.artist });
      room.mtCurrentSong = null;
      room.mtPendingPlacement = null;
      room.mtCurrentChallenge = null;
      advanceTurn(ctx, room);

      if (ctx.connectedNames(room).length > 0) {
        mtNextTurn(ctx, roomCode, room);
        return;
      }
      room.phase = 'ready';
    }
  }

  broadcastMt(ctx, roomCode, room);
}

function onReconnectBroadcast(ctx, roomCode, room) {
  if (room.phase === 'teamSelect') {
    broadcastMtTeamSelect(ctx, roomCode, room);
  } else {
    broadcastMt(ctx, roomCode, room);
  }
}

/** An in-flight OpenAI call can't be resumed after a restart - roll back to the last safe phase. */
function repairOnLoad(ctx, room) {
  if (room.phase !== 'generating') return;
  const ids = mtTeamIds(room);
  const dealComplete = ids.length > 0 && ids.every((id) => (room.mtTeams[id].timeline || []).length > 0);
  room.mtCurrentSong = null;
  room.mtPendingPlacement = null;
  room.mtCurrentChallenge = null;
  room.phase = dealComplete ? 'ready' : 'teamSelect';
}

module.exports = {
  id: 'musictimeline',
  minPlayers: MT_MIN_PLAYERS,
  maxPlayers: MT_MAX_PLAYERS,
  onChoose,
  registerHandlers,
  reconnectPayload,
  onDisconnect,
  onReconnectBroadcast,
  repairOnLoad,
  savedFields: SAVED_FIELDS,
  clearState,
};
