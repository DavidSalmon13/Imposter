const fs = require('fs');
const path = require('path');
const express = require('express');
const { validateName } = require('./lib/validateName');
const {
  rooms,
  createRoomState,
  normalizeRoomCode,
  getRoom,
  roomEmit,
} = require('./roomStore');
const { saveRoomsToDisk } = require('./persistence');
const { getGame, clearAllGameState } = require('./gameRegistry');

// Single shared room for now - no room codes to create or join, everyone
// who connects lands in the same game.
const SHARED_ROOM_CODE = 'MAIN';

/** @type {object | null} */
let hooks = null;
/** @type {object | null} */
let ctx = null;

/**
 * Shared helpers still live here; per-game dispatch goes through gameRegistry.
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
    wordLanguage: room.wordLanguage || 'english',
    wordTheme: room.wordTheme || '',
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
  clearAllGameState(room, roomCode);
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

function reconnectPayload(room, existing) {
  const game = getGame(room.game);
  if (game) {
    return game.reconnectPayload(ctx, room, existing);
  }

  return {
    ok: true,
    game: null,
    phase: 'lobby',
    players: connectedNames(room),
    host: room.hostName,
    scoreboard: scoreboardEntries(room),
    wordLanguage: room.wordLanguage || 'english',
    wordTheme: room.wordTheme || '',
  };
}

function getSharedRoom() {
  let room = rooms.get(SHARED_ROOM_CODE);
  if (!room) {
    room = createRoomState();
    rooms.set(SHARED_ROOM_CODE, room);
  }
  return room;
}

function joinExistingRoom(socket, roomCode, name, clientId, callback) {
  const room = rooms.get(roomCode);
  if (!room) return callback({ ok: false, error: 'Room not found' });

  const existing = room.players.get(name);

  if (existing) {
    let staleSocket = null;
    if (existing.connected) {
      // The `connected` flag can lag behind reality for up to ~45s (socket.io's
      // ping timeout) after a phone locks/loses signal - long enough for the same
      // browser to reconnect and get wrongly told its own name is taken. Only
      // treat this as a real clash when it's not the same client reclaiming it.
      const sameClient = clientId && existing.clientId && existing.clientId === clientId;
      if (!sameClient) {
        return callback({ ok: false, error: 'That name is taken' });
      }
      staleSocket = ctx.io.sockets.sockets.get(existing.socketId);
    }
    // Reassign the slot to the new socket before disconnecting the old one, so
    // its disconnect handler sees it no longer owns this player and no-ops
    // instead of briefly (and wrongly) marking the reclaiming player as gone.
    existing.connected = true;
    existing.socketId = socket.id;
    if (clientId) existing.clientId = clientId;
    if (staleSocket && staleSocket.id !== socket.id) staleSocket.disconnect(true);
    attachToRoom(socket, roomCode, room, name);

    // A disconnect that happened while this player was host reassigned host to
    // whoever was next connected (see the `disconnect` handler below) so the room
    // isn't stuck without one. Now that they're back, hand host back to them so a
    // brief phone-lock/wifi blip doesn't permanently bump someone else into it.
    if (existing.wasHost) {
      existing.wasHost = false;
      setHost(roomCode, room, name);
    }

    const game = getGame(room.game);
    if (game && typeof game.onReconnectBroadcast === 'function') {
      game.onReconnectBroadcast(ctx, roomCode, room, name);
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
    clientId: clientId || null,
    role: null,
    word: null,
    hint: null,
    vote: null,
    team: null,
    leader: false,
    eliminatedReport: null,
    wasHost: false,
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
    wordLanguage: room.wordLanguage || 'english',
    wordTheme: room.wordTheme || '',
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
  const { BACKGROUNDS_DIR } = hooks;

  socket.on('join', (data, callback) => {
    callback = callback || (() => {});
    const name = ((data && data.name) || '').trim();
    const clientId = String((data && data.clientId) || '').slice(0, 64);

    const nameError = validateName(name);
    if (nameError) return callback({ ok: false, error: nameError });

    getSharedRoom();
    joinExistingRoom(socket, SHARED_ROOM_CODE, name, clientId, callback);
  });

  socket.on('renameSelf', (data, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    // Player identity is keyed by name throughout every game module's in-progress
    // state (seats, hands, votes, turn order, ...), so renaming mid-game would
    // silently desync all of it - only allow it between games.
    if (room.phase !== 'lobby') {
      return callback({ ok: false, error: 'Can only change your name in the lobby' });
    }

    const oldName = socket.data.name;
    const newName = ((data && data.name) || '').trim();
    const nameError = validateName(newName);
    if (nameError) return callback({ ok: false, error: nameError });
    if (newName === oldName) return callback({ ok: true, name: oldName, host: room.hostName });
    if (room.players.has(newName)) {
      return callback({ ok: false, error: 'That name is taken' });
    }

    const player = room.players.get(oldName);
    room.players.delete(oldName);
    room.players.set(newName, player);
    socket.data.name = newName;

    // Carry the score over to the new name instead of starting it back at zero -
    // merge rather than overwrite in case a past (disconnected) player already
    // holds points under that name.
    if (room.scoreboard && Object.prototype.hasOwnProperty.call(room.scoreboard, oldName)) {
      room.scoreboard[newName] = (Number(room.scoreboard[newName]) || 0) + (Number(room.scoreboard[oldName]) || 0);
      delete room.scoreboard[oldName];
    }

    if (room.hostName === oldName) room.hostName = newName;

    broadcastLobby(roomCode, room);
    callback({ ok: true, name: newName, host: room.hostName });
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

    const game = getGame(selectedGame);
    if (!game) return callback({ ok: false, error: 'Invalid game' });

    const names = connectedNames(room);
    if (names.length < game.minPlayers) {
      return callback({ ok: false, error: `Need at least ${game.minPlayers} players` });
    }
    if (game.maxPlayers != null && names.length > game.maxPlayers) {
      return callback({
        ok: false,
        error: `${game.id} supports at most ${game.maxPlayers} players`,
      });
    }

    room.game = game.id;
    roomEmit(roomCode, 'gameChosen', { game: game.id });
    game.onChoose(ctx, roomCode, room);
    return callback({ ok: true });
  });

  socket.on('setWordLanguage', (language, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.phase !== 'lobby') return callback({ ok: false, error: 'Only available in the lobby' });
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can set the word language' });
    }
    if (language !== 'english' && language !== 'hebrew') {
      return callback({ ok: false, error: 'Invalid language' });
    }

    room.wordLanguage = language;
    callback({ ok: true });
    broadcastLobby(roomCode, room);
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
    resetToLobby(roomCode, room);
    callback({ ok: true });
  });

  socket.on('leaveLobby', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.phase !== 'lobby') return callback({ ok: false, error: 'Only available in the lobby' });

    const name = socket.data.name;
    room.players.delete(name);
    if (name === room.hostName) {
      const [nextHost] = connectedNames(room);
      setHost(roomCode, room, nextHost || null);
    }
    socket.leave(roomCode);
    socket.data.roomCode = null;
    socket.data.name = null;
    broadcastLobby(roomCode, room);
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
    // This socket's disconnect event can arrive late (socket.io ping timeout),
    // after the same player already reconnected on a new socket and reclaimed
    // this slot. Ignore it so we don't wipe out a session that's already back.
    if (p.socketId !== socket.id) return;

    // A dropped connection (phone locked, WiFi blip, tab backgrounded) shouldn't
    // erase the player's spot - keep them so a reconnect restores it instead of
    // either kicking them from the lobby list or treating them as a stranger
    // trying to join a game already in progress.
    p.connected = false;
    if (name === room.hostName) {
      p.wasHost = true;
      const [nextHost] = connectedNames(room);
      setHost(roomCode, room, nextHost || null);
    }

    if (room.phase === 'lobby') {
      broadcastLobby(roomCode, room);
      return;
    }

    const game = getGame(room.game);
    if (game) {
      game.onDisconnect(ctx, roomCode, room, name);
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
