const fs = require('fs');
const path = require('path');
const express = require('express');
const { validateName } = require('./lib/validateName');
const {
  rooms,
  createRoomState,
  normalizeRoomCode,
  generateRoomCode,
  getRoom,
  roomEmit,
  ROOM_CODE_LENGTH,
} = require('./roomStore');
const { saveRoomsToDisk } = require('./persistence');
const menifot = require('./games/menifot');
const tenseconds = require('./games/tenseconds');

/** @type {object | null} */
let hooks = null;
/** @type {object | null} */
let ctx = null;

/**
 * Game-specific helpers still live in server.js until each game module is
 * extracted (Steps 6a–6d). Lobby shells call through these hooks.
 * Menifot (Step 6a) is already a module — call its contract methods with ctx.
 */
function initLobby(gameHooks) {
  hooks = gameHooks;
  ctx = gameHooks.ctx;
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
  hooks.clearCnTimerHandle(roomCode);
  room.cnTimerSeconds = null;
  room.cnTurnEndsAt = null;
  tenseconds.clearState(room, roomCode);
  menifot.clearState(room);
  room.imposterRoundResults = null;
  for (const p of room.players.values()) p.eliminatedReport = null;
  roomEmit(roomCode, 'backToLobby');
  broadcastLobby(roomCode, room);
}

function attachToRoom(socket, roomCode, room, name) {
  if (socket.data.roomCode && socket.data.roomCode !== roomCode) {
    socket.leave(socket.data.roomCode);
  }
  socket.join(roomCode);
  socket.data.roomCode = roomCode;
  socket.data.name = name;
}

// Shell: per-game branches stay until Steps 6/7 replace them with GAMES[room.game].reconnectPayload.
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
        total: hooks.playersInImposterRound(room).length,
        answered: hooks.playersInImposterRound(room).filter((n) => {
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
        red: hooks.teamPlayersInfo(room, 'red'),
        blue: hooks.teamPlayersInfo(room, 'blue'),
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
        board: hooks.boardForViewer(room, existing),
        isLeader: existing.leader,
        myTeam: existing.team,
        red: hooks.teamPlayersInfo(room, 'red'),
        blue: hooks.teamPlayersInfo(room, 'blue'),
        timerSeconds: room.cnTimerSeconds || 0,
        turnEndsAt: room.cnTurnEndsAt,
        scoreboard: room.phase === 'gameover' ? scoreboardEntries(room) : undefined,
      };
    }
  }

  if (room.game === 'tenseconds') {
    return tenseconds.reconnectPayload(ctx, room, existing);
  }

  if (room.game === 'menifot') {
    return menifot.reconnectPayload(ctx, room, existing);
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

    if (room.phase === 'voting') hooks.broadcastVoting(roomCode, room);
    else if (room.phase === 'teamSelect') hooks.broadcastTeamSelect(roomCode, room);
    else if (room.phase === 'reporting') hooks.broadcastImposterReporting(roomCode, room);
    else if (room.game === 'imposter' && room.phase === 'roundResults') {
      hooks.broadcastImposterResults(roomCode, room);
    } else if (room.game === 'tenseconds') {
      tenseconds.onReconnectBroadcast(ctx, roomCode, room, name);
    } else if (room.game === 'menifot') {
      menifot.onReconnectBroadcast(ctx, roomCode, room, name);
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

function registerBackgroundRoutes(app, { BACKGROUNDS_DIR, BACKGROUND_MIME_EXT }) {
  app.post(
    '/api/rooms/:roomCode/background',
    express.raw({ type: 'image/*', limit: '8mb' }),
    (req, res) => {
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
    }
  );

  app.use((err, req, res, next) => {
    if (!err) return next();
    console.error('Upload error:', err.message);
    res.status(400).json({ ok: false, error: 'Upload failed - try a smaller image' });
  });
}

function registerLobbyHandlers(socket) {
  const {
    MIN_PLAYERS,
    CN_MIN_PLAYERS,
    BACKGROUNDS_DIR,
  } = hooks;

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

  // Shell: per-game branches until Steps 6/7 replace them with GAMES[selectedGame].onChoose.
  socket.on('chooseGame', (selectedGame, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.phase !== 'lobby') return callback({ ok: false, error: 'Game already chosen' });
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can choose the game' });
    }
    if (
      selectedGame !== 'imposter' &&
      selectedGame !== 'codenames' &&
      selectedGame !== 'tenseconds' &&
      selectedGame !== 'menifot'
    ) {
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
      if (names.length < tenseconds.minPlayers) {
        return callback({ ok: false, error: `Need at least ${tenseconds.minPlayers} players` });
      }
      room.game = tenseconds.id;
      roomEmit(roomCode, 'gameChosen', { game: room.game });
      tenseconds.onChoose(ctx, roomCode, room);
      return callback({ ok: true });
    }

    if (selectedGame === 'menifot') {
      if (names.length < menifot.minPlayers) {
        return callback({ ok: false, error: `Need at least ${menifot.minPlayers} players` });
      }
      if (names.length > menifot.maxPlayers) {
        return callback({
          ok: false,
          error: `Menifot supports at most ${menifot.maxPlayers} players`,
        });
      }
      room.game = menifot.id;
      roomEmit(roomCode, 'gameChosen', { game: room.game });
      menifot.onChoose(ctx, roomCode, room);
      return callback({ ok: true });
    }

    if (names.length < CN_MIN_PLAYERS) {
      return callback({ ok: false, error: `Need at least ${CN_MIN_PLAYERS} players` });
    }
    room.game = 'codenames';
    room.phase = 'teamSelect';
    roomEmit(roomCode, 'gameChosen', { game: room.game });
    hooks.broadcastTeamSelect(roomCode, room);
    callback({ ok: true });
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

  // Shell: per-game branches until Steps 6/7 replace them with GAMES[room.game].onDisconnect.
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
      hooks.broadcastVoting(roomCode, room);
      hooks.maybeFinishVoting(roomCode, room);
    } else if (room.phase === 'reporting') {
      // Disconnect before answering defaults to eliminated.
      if (p.eliminatedReport === null || p.eliminatedReport === undefined) {
        p.eliminatedReport = true;
      }
      hooks.broadcastImposterReporting(roomCode, room);
      hooks.maybeFinishImposterReporting(roomCode, room);
    } else if (room.phase === 'teamSelect') {
      hooks.broadcastTeamSelect(roomCode, room);
    } else if (room.game === 'codenames' && (room.phase === 'playing' || room.phase === 'gameover')) {
      hooks.broadcastCodenamesState(roomCode, room);
    } else if (room.game === 'tenseconds') {
      tenseconds.onDisconnect(ctx, roomCode, room, name);
    } else if (room.game === 'menifot') {
      menifot.onDisconnect(ctx, roomCode, room, name);
    }
  });
}

module.exports = {
  initLobby,
  connectedNames,
  scoreboardEntries,
  addScore,
  broadcastLobby,
  setHost,
  resetToLobby,
  attachToRoom,
  reconnectPayload,
  joinExistingRoom,
  registerBackgroundRoutes,
  registerLobbyHandlers,
};
