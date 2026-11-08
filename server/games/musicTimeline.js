'use strict';

const { chatCompletionJson } = require('../lib/openai');

const MT_MIN_PLAYERS = 2;
const MT_MAX_PLAYERS = 10;
const MT_MIN_TEAMS = 2;
const MT_MAX_TEAMS = 4;
const MT_TEAM_IDS = ['A', 'B', 'C', 'D'];
const MT_TARGET_CARDS = 10;
const MT_STARTING_TOKENS = 2;
const MT_CHALLENGE_COST = 1;
const MT_USED_SONGS_AVOID_WINDOW = 40;
const MT_DIFFICULTIES = ['easy', 'pro', 'expert'];
const MT_DIFFICULTY_GUIDANCE = {
  easy: 'Pick a very famous, widely recognizable song most people would know instantly.',
  pro: 'Pick a moderately well-known song - not obscure, but not a top-40 giant either.',
  expert: 'Pick a song that can be a deeper cut - well-regarded but less mainstream is fine.',
};

// Keys within room.state.musictimeline to persist (see plans/yes-sketch-a-low-risk-quiet-chipmunk.md).
const SAVED_FIELDS = [
  'mode',
  'difficulty',
  'teams',
  'activeTeamIndex',
  'currentSong',
  'currentChallenge',
  'pendingPlacement',
  'revealResult',
  'usedSongs',
  'roundNumber',
  'matchWinners',
  'turnCollected',
  'turnOver',
];

/** Music Timeline's namespaced room state. Replaces the former flat room.mt* fields. */
function createState() {
  return {
    mode: null, // 'team' | 'solo'
    difficulty: null, // 'easy' | 'pro' | 'expert'
    teams: {}, // team id -> { name, timeline: [{ title, artist, releaseYear }, ...], tokens }
    activeTeamIndex: 0,
    currentSong: null, // { title, artist, releaseYear } | null - pending song for the active team
    pendingPlacement: null, // { slotIndex } | null - active team's locked-but-not-revealed slot pick
    revealResult: null, // { teamId, correct } | null - set at reveal, cleared at next turn/start
    currentChallenge: null, // { team, placement } | null
    usedSongs: [], // rolling avoid-list sent to ChatGPT
    roundNumber: 0,
    matchWinners: [],
    turnCollected: [], // cards collected during the active turn (lazily created pre-migration)
    turnOver: false, // active turn has ended (lazily created pre-migration)
  };
}

function clearState(room) {
  room.state.musictimeline = createState();
}

/** Team ids currently configured (pre-start slot list, in formation order A→D). */
function mtTeamIds(room) {
  return Object.keys(room.state.musictimeline.teams || {});
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
  for (const id of ids) kept[id] = room.state.musictimeline.teams[id] || {};
  room.state.musictimeline.teams = kept;
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
  return Object.entries(room.state.musictimeline.teams || {})
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
    .map((id) => ({ id, count: (room.state.musictimeline.teams[id].timeline || []).length }))
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

  const winners = room.state.musictimeline.matchWinners || [];
  const participants = [];
  for (const [name, p] of room.players.entries()) {
    const points = p.team ? pointsByTeam[p.team] : undefined;
    if (points) ctx.addScore(room, name, points);
    if (p.team && room.state.musictimeline.teams[p.team]) {
      participants.push({
        name,
        team: p.team,
        won: winners.includes(p.team),
        points: points || 0,
        details: { cards: (room.state.musictimeline.teams[p.team].timeline || []).length },
      });
    }
  }
  ctx.recordGameResult(room, 'musictimeline', participants);
}

/** Advances mtActiveTeamIndex to the next team (wrapping) with >=1 connected member. */
function advanceTurn(ctx, room) {
  const ids = mtTeamIds(room);
  if (!ids.length) return;
  for (let step = 1; step <= ids.length; step++) {
    const next = (room.state.musictimeline.activeTeamIndex + step) % ids.length;
    if (mtTeamMembers(ctx, room, ids[next]).length >= 1) {
      room.state.musictimeline.activeTeamIndex = next;
      return;
    }
  }
}

async function generateMusicTimelineSong(room, difficulty) {
  const avoid = room.state.musictimeline.usedSongs.slice(-MT_USED_SONGS_AVOID_WINDOW);
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

function mtCanStart(ctx, room) {
  if (room.state.musictimeline.mode === 'solo') {
    return ctx.connectedNames(room).length >= MT_MIN_PLAYERS;
  }
  const ids = mtTeamIds(room);
  if (ids.length < MT_MIN_TEAMS || ids.length > MT_MAX_TEAMS) return false;
  return ids.every((id) => mtTeamMembers(ctx, room, id).length >= 1);
}

function mtTeamSelectPayload(ctx, room) {
  const teams =
    room.state.musictimeline.mode === 'solo'
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
    mode: room.state.musictimeline.mode,
    difficulty: room.state.musictimeline.difficulty,
    teams,
    canStart: mtCanStart(ctx, room),
  };
}

function broadcastMtTeamSelect(ctx, roomCode, room) {
  ctx.roomEmit(roomCode, 'mtTeamSelectUpdate', mtTeamSelectPayload(ctx, room));
}

function mtActiveTeamId(room) {
  const ids = Object.keys(room.state.musictimeline.teams || {});
  return ids[room.state.musictimeline.activeTeamIndex] || null;
}

/**
 * The team that gets to see (and play) the current song - always the next team after the active
 * one in turn order, skipping any team with zero connected members. Never the active team itself
 * (they're the ones guessing), so with >=2 teams this always finds someone other than whoever's
 * up, as long as at least one other team still has a connected player.
 */
function mtDjTeamId(ctx, room) {
  const ids = mtTeamIds(room);
  if (ids.length < 2) return null;
  for (let step = 1; step < ids.length; step++) {
    const idx = (room.state.musictimeline.activeTeamIndex + step) % ids.length;
    if (mtTeamMembers(ctx, room, ids[idx]).length >= 1) return ids[idx];
  }
  return null;
}

function mtYoutubeSearchUrl(song) {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(`${song.title} ${song.artist}`)}`;
}

/**
 * The active team's timeline plus whatever they've collected (but not yet banked) so far this
 * turn, merged into chronological order - what the team actually plays against while their turn
 * is still going. Every other team's timeline is just their own committed cards.
 */
function mtEffectiveTimeline(room, teamId) {
  const team = room.state.musictimeline.teams[teamId];
  const committed = (team && team.timeline) || [];
  if (teamId !== mtActiveTeamId(room)) return committed;
  return (room.state.musictimeline.turnCollected || []).reduce((acc, s) => insertIntoTimeline(acc, s), committed);
}

function mtTeamsForDisplay(room) {
  const activeTeamId = mtActiveTeamId(room);
  return Object.entries(room.state.musictimeline.teams || {}).map(([id, team]) => ({
    id,
    name: team.name,
    timeline: mtEffectiveTimeline(room, id),
    pendingCount: id === activeTeamId ? (room.state.musictimeline.turnCollected || []).length : 0,
    tokens: team.tokens,
  }));
}

function mtStatePayload(ctx, room, viewerName) {
  const isHost = viewerName === room.hostName;
  const viewer = room.players.get(viewerName);
  const myTeamId = viewer ? viewer.team : null;
  const activeTeamId = mtActiveTeamId(room);
  const myTeam = myTeamId ? room.state.musictimeline.teams[myTeamId] : null;
  const djTeamId = mtDjTeamId(ctx, room);
  const canChallenge =
    room.phase === 'locked' &&
    !room.state.musictimeline.currentChallenge &&
    !!myTeamId &&
    myTeamId !== activeTeamId &&
    myTeamId !== djTeamId &&
    !!myTeam &&
    (myTeam.tokens || 0) >= MT_CHALLENGE_COST;
  const turnDecisionPending =
    room.phase === 'revealed' && !!room.state.musictimeline.revealResult && room.state.musictimeline.revealResult.correct && !room.state.musictimeline.turnOver;
  const canDecideTurn = turnDecisionPending && !!myTeamId && myTeamId === activeTeamId;
  // The pending song (and a YouTube search link for it) only ever goes to the DJ team - the team
  // right after the active one in turn order - so the guessing team can't see it. If every other
  // team has fully disconnected, the host sees it instead as a last resort so the round isn't
  // stuck with nobody able to play the song at all. Once revealed, everyone sees it.
  const canSeeSong =
    room.phase === 'revealed' || (djTeamId ? myTeamId === djTeamId : isHost);
  return {
    game: 'musictimeline',
    phase: room.phase,
    host: room.hostName,
    viewerName,
    myTeam: myTeamId,
    mode: room.state.musictimeline.mode,
    difficulty: room.state.musictimeline.difficulty,
    teams: mtTeamsForDisplay(room),
    activeTeamId,
    djTeamId,
    roundNumber: room.state.musictimeline.roundNumber,
    currentSong: canSeeSong ? room.state.musictimeline.currentSong : null,
    currentSongUrl: canSeeSong && room.state.musictimeline.currentSong ? mtYoutubeSearchUrl(room.state.musictimeline.currentSong) : null,
    pendingSlotIndex: room.state.musictimeline.pendingPlacement ? room.state.musictimeline.pendingPlacement.slotIndex : null,
    revealResult: room.phase === 'revealed' ? room.state.musictimeline.revealResult : null,
    canChallenge,
    currentChallenge: room.state.musictimeline.currentChallenge,
    turnOver: room.state.musictimeline.turnOver,
    turnCollectedCount: (room.state.musictimeline.turnCollected || []).length,
    canContinueTurn: canDecideTurn,
    canStopTurn: canDecideTurn,
    matchWinners: (room.state.musictimeline.matchWinners || []).slice(),
    scoreboard: room.phase === 'gameover' ? ctx.scoreboardEntries(room) : undefined,
  };
}

function broadcastMt(ctx, roomCode, room) {
  for (const [name, p] of room.players.entries()) {
    if (!p.connected || !p.socketId) continue;
    ctx.io.to(p.socketId).emit('mtState', mtStatePayload(ctx, room, name));
  }
}

/** Reverts a failed OpenAI call made mid-match (picking the next turn's song). */
function failMtRound(ctx, roomCode, room, error) {
  room.phase = 'ready';
  room.state.musictimeline.currentSong = null;
  room.state.musictimeline.pendingPlacement = null;
  broadcastMt(ctx, roomCode, room);
  ctx.roomEmit(roomCode, 'mtStartFailed', { error });
}

function finishStartingMusicTimeline(ctx, roomCode, room, mtTeams) {
  room.state.musictimeline.teams = mtTeams;
  room.state.musictimeline.activeTeamIndex = 0;
  room.state.musictimeline.roundNumber = 0;
  room.state.musictimeline.usedSongs = [];
  room.state.musictimeline.currentSong = null;
  room.state.musictimeline.currentChallenge = null;
  room.state.musictimeline.turnCollected = [];
  room.state.musictimeline.turnOver = false;
  room.state.musictimeline.matchWinners = [];
  room.phase = 'ready';
  broadcastMt(ctx, roomCode, room);
}

async function mtNextTurn(ctx, roomCode, room) {
  room.phase = 'generating';
  ctx.roomEmit(roomCode, 'generating', { game: 'musictimeline' });

  let song;
  try {
    song = await generateMusicTimelineSong(room, room.state.musictimeline.difficulty);
  } catch (err) {
    console.error('generateMusicTimelineSong failed:', err.message);
    return failMtRound(ctx, roomCode, room, 'Could not reach ChatGPT to pick a song. Please try again.');
  }

  if (!ctx.rooms.has(roomCode) || ctx.rooms.get(roomCode) !== room) return;

  room.state.musictimeline.usedSongs.push({ title: song.title, artist: song.artist });
  room.state.musictimeline.currentSong = song;
  room.state.musictimeline.pendingPlacement = null;
  room.state.musictimeline.revealResult = null;
  room.phase = 'placing';
  broadcastMt(ctx, roomCode, room);
}

/**
 * Applies the active team's locked placement (and, if one was claimed, the challenger's own
 * placement) and moves the match into `revealed`. A successful challenge takes the card outright
 * - the active team is scored for display purposes but does not receive the card even if their
 * own placement was also correct. A failed challenge costs the challenger a token and leaves the
 * active team's own result untouched.
 *
 * The active team's own card is never committed straight to their timeline here - a correct
 * placement is only added to `mtTurnCollected`, the team's push-your-luck pile for this turn.
 * They keep it only if they later choose to stop (see mtStopTurn); a wrong guess on any later
 * song in the same turn discards the whole pile.
 */
function revealMtPlacement(ctx, room) {
  const activeTeamId = mtActiveTeamId(room);
  const song = room.state.musictimeline.currentSong;
  const slotIndex = room.state.musictimeline.pendingPlacement ? room.state.musictimeline.pendingPlacement.slotIndex : 0;
  const effectiveTimeline = mtEffectiveTimeline(room, activeTeamId);
  const activeCorrect = checkPlacement(effectiveTimeline, song.releaseYear, slotIndex);

  const challenge = room.state.musictimeline.currentChallenge;
  let challengeResult = null;
  let challengeWon = false;

  if (challenge && challenge.slotIndex != null) {
    const challengerTeam = room.state.musictimeline.teams[challenge.team];
    const challengerCorrect = checkPlacement(challengerTeam.timeline, song.releaseYear, challenge.slotIndex);
    challengeResult = { teamId: challenge.team, correct: challengerCorrect };

    if (challengerCorrect) {
      challengerTeam.timeline = insertIntoTimeline(challengerTeam.timeline, song);
      challengeWon = true;
    } else {
      challengerTeam.tokens = Math.max(0, (challengerTeam.tokens || 0) - MT_CHALLENGE_COST);
    }
  }

  if (activeCorrect && !challengeWon) {
    room.state.musictimeline.turnCollected.push(song);
  }
  if (!activeCorrect) {
    room.state.musictimeline.turnCollected = [];
  }

  room.state.musictimeline.revealResult = { teamId: activeTeamId, correct: activeCorrect, challenge: challengeResult };
  room.state.musictimeline.pendingPlacement = null;
  room.state.musictimeline.currentChallenge = null;
  // A wrong guess ends the turn on the spot; a correct one waits on the team's own decision to
  // draw another song or stop and bank what they've collected (see mtContinueTurn/mtStopTurn).
  room.state.musictimeline.turnOver = !activeCorrect;
  room.phase = 'revealed';

  const winners = checkMtWin(room);
  if (winners.length) {
    room.state.musictimeline.matchWinners = winners;
    room.phase = 'gameover';
    awardMtScoreboard(ctx, room);
  }
}

/** Banks the active team's `mtTurnCollected` pile into their real timeline and ends the turn. */
function bankMtTurn(ctx, room) {
  const activeTeamId = mtActiveTeamId(room);
  const activeTeam = room.state.musictimeline.teams[activeTeamId];
  let timeline = activeTeam.timeline || [];
  for (const s of room.state.musictimeline.turnCollected || []) timeline = insertIntoTimeline(timeline, s);
  activeTeam.timeline = timeline;
  room.state.musictimeline.turnCollected = [];
  room.state.musictimeline.turnOver = true;

  const winners = checkMtWin(room);
  if (winners.length) {
    room.state.musictimeline.matchWinners = winners;
    room.phase = 'gameover';
    awardMtScoreboard(ctx, room);
  }
}

function onChoose(ctx, roomCode, room) {
  clearState(room);
  room.phase = 'teamSelect';
  room.state.musictimeline.mode = 'team';
  room.state.musictimeline.difficulty = 'easy';
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

    room.state.musictimeline.mode = mode;
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

    room.state.musictimeline.difficulty = level;
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
    if (room.state.musictimeline.mode !== 'team') return callback({ ok: false, error: 'Switch to Team mode first' });
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
    if (room.state.musictimeline.mode !== 'team') return callback({ ok: false, error: 'Not in Team mode' });

    const teamId = data && data.teamId;
    if (!room.state.musictimeline.teams[teamId]) return callback({ ok: false, error: 'Invalid team' });

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
    if (room.state.musictimeline.mode === 'solo') {
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
    const turnFinished = room.phase === 'ready' || (room.phase === 'revealed' && room.state.musictimeline.turnOver);
    if (room.game !== 'musictimeline' || !turnFinished) {
      return callback({ ok: false, error: 'Not ready for the next turn' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can start the next turn' });
    }

    // A turn only just resolved (not the very first turn after Start) - advance to whoever's next.
    if (room.phase === 'revealed') {
      advanceTurn(ctx, room);
      room.state.musictimeline.roundNumber += 1;
    }
    room.state.musictimeline.turnCollected = [];
    room.state.musictimeline.turnOver = false;

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

  socket.on('mtContinueTurn', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'musictimeline' || room.phase !== 'revealed') {
      return callback({ ok: false, error: 'Nothing to continue right now' });
    }
    if (!room.state.musictimeline.revealResult || !room.state.musictimeline.revealResult.correct || room.state.musictimeline.turnOver) {
      return callback({ ok: false, error: "Turn isn't waiting on a decision" });
    }

    const name = socket.data.name;
    const p = room.players.get(name);
    const activeTeamId = mtActiveTeamId(room);
    if (!p || !activeTeamId || p.team !== activeTeamId) {
      return callback({ ok: false, error: "Not your team's turn" });
    }

    callback({ ok: true });
    mtNextTurn(ctx, roomCode, room);
  });

  socket.on('mtStopTurn', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'musictimeline' || room.phase !== 'revealed') {
      return callback({ ok: false, error: 'Nothing to stop right now' });
    }
    if (!room.state.musictimeline.revealResult || !room.state.musictimeline.revealResult.correct || room.state.musictimeline.turnOver) {
      return callback({ ok: false, error: "Turn isn't waiting on a decision" });
    }

    const name = socket.data.name;
    const p = room.players.get(name);
    const activeTeamId = mtActiveTeamId(room);
    if (!p || !activeTeamId || p.team !== activeTeamId) {
      return callback({ ok: false, error: "Not your team's turn" });
    }

    bankMtTurn(ctx, room);
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

    const slotCount = mtEffectiveTimeline(room, activeTeamId).length + 1;
    const slotIndex = Number(data && data.slotIndex);
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= slotCount) {
      return callback({ ok: false, error: 'Invalid slot' });
    }

    room.state.musictimeline.pendingPlacement = { slotIndex };
    room.phase = 'locked';
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
    if (!p || !p.team || !room.state.musictimeline.teams[p.team]) {
      return callback({ ok: false, error: 'Not on a team' });
    }
    if (p.team === activeTeamId) {
      return callback({ ok: false, error: "Can't challenge your own team" });
    }
    if (p.team === mtDjTeamId(ctx, room)) {
      return callback({ ok: false, error: "The DJ team already knows the song and can't challenge" });
    }
    if (room.state.musictimeline.currentChallenge) {
      return callback({ ok: false, error: 'Another team already claimed the challenge' });
    }

    const challengerTeam = room.state.musictimeline.teams[p.team];
    if ((challengerTeam.tokens || 0) < MT_CHALLENGE_COST) {
      return callback({ ok: false, error: 'Not enough tokens to challenge' });
    }

    room.state.musictimeline.currentChallenge = { team: p.team, slotIndex: null };
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
    const challenge = room.state.musictimeline.currentChallenge;
    if (!p || !challenge || p.team !== challenge.team) {
      return callback({ ok: false, error: "Not your team's challenge" });
    }
    if (challenge.slotIndex != null) {
      return callback({ ok: false, error: 'Already placed' });
    }

    const challengerTeam = room.state.musictimeline.teams[challenge.team];
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
    if (room.state.musictimeline.mode === 'solo') {
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
        mtTeams[id] = { name: room.state.musictimeline.teams[id].name, timeline: [], tokens: MT_STARTING_TOKENS };
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
      // Active team is now fully disconnected - the pending song can never be placed, and
      // anything they collected earlier this turn is lost along with it. Discard both, advance
      // to whoever's next, and immediately start generating their turn.
      const song = room.state.musictimeline.currentSong;
      if (song) room.state.musictimeline.usedSongs.push({ title: song.title, artist: song.artist });
      room.state.musictimeline.currentSong = null;
      room.state.musictimeline.pendingPlacement = null;
      room.state.musictimeline.currentChallenge = null;
      room.state.musictimeline.turnCollected = [];
      room.state.musictimeline.turnOver = false;
      advanceTurn(ctx, room);

      if (ctx.connectedNames(room).length > 0) {
        mtNextTurn(ctx, roomCode, room);
        return;
      }
      room.phase = 'ready';
    }
  } else if (
    room.phase === 'revealed' &&
    room.state.musictimeline.revealResult &&
    room.state.musictimeline.revealResult.correct &&
    !room.state.musictimeline.turnOver
  ) {
    // Active team is mid-decision (draw again vs. stop) and just lost its last connected member.
    // Nobody left who can make that call - auto-bank what they've collected so the host's "Next
    // Turn" button can free up the room instead of stalling forever.
    const activeTeamId = mtActiveTeamId(room);
    if (activeTeamId && mtTeamMembers(ctx, room, activeTeamId).length === 0) {
      bankMtTurn(ctx, room);
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
  room.state.musictimeline.currentSong = null;
  room.state.musictimeline.pendingPlacement = null;
  room.state.musictimeline.currentChallenge = null;
  room.phase = 'ready';
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
  namespaces: [{ id: 'musictimeline', createState, savedFields: SAVED_FIELDS }],
  clearState,
};
