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
const { isValidSticker } = require('./stickers');
const {
  canUseSticker,
  userFromSocket,
  setAccountSticker,
  playerCardForUser,
  isBanned,
} = require('./accounts');
const stats = require('./stats');
const { logActivity } = require('./activity');

// Single shared room for now - no room codes to create or join, everyone
// who connects lands in the same game.
const SHARED_ROOM_CODE = 'MAIN';

// Curated subset of the built-in sticker bank usable as reactions (see the shared
// reaction row in public/js/shared/reactions.js) - a hand-picked spread of expressions,
// not the full picker (which includes outfit/pose stickers that don't read as a reaction),
// and deliberately excludes player-uploaded custom-* stickers.
const REACTION_STICKERS = [
  '7818f961-efbf-41e6-94ee-99d8934cf823.webp', // big laugh
  'ff6eca8a-9135-4b94-85e9-04ab02f464e6.webp', // shocked
  '1fc18b9d-116d-4b73-840e-ccc8ddb1a45c.webp', // kiss / love it
  'bf45b8f8-461a-4b2a-a697-377c8d7ad371.webp', // hype / crazy
  '65e3b128-db99-4452-bc02-45d7d1602674.webp', // dead / oof
  '34252cf1-c888-481a-a846-359f70cc47aa.webp', // money
];
const REACTION_COOLDOWN_MS = 600;
// A player who closed the app without tapping Leave is dropped (with their scoreboard
// points) after this long away - otherwise they stay in room.players forever.
const STALE_PLAYER_MS = 30 * 60 * 1000;
/** @type {Map<string, number>} socket.id -> epoch ms of its last accepted reaction */
const lastReactionAt = new Map();

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

// name -> sticker filename, only for connected players with one chosen.
function connectedStickers(room) {
  const out = {};
  for (const [name, p] of room.players.entries()) {
    if (p.connected && p.sticker) out[name] = p.sticker;
  }
  return out;
}

// name -> true, only for connected players whose device is linked to a signed-in account.
function connectedSignedIn(room) {
  const out = {};
  for (const [name, p] of room.players.entries()) {
    if (p.connected && p.signedIn) out[name] = true;
  }
  return out;
}

// name -> { ovr, tier } for connected, signed-in players whose rating card has been
// looked up (see refreshRatings) - drives the lobby's mini rating card next to each name.
function connectedRatings(room) {
  const out = {};
  for (const [name, p] of room.players.entries()) {
    if (p.connected && p.signedIn && p.rating) out[name] = p.rating;
  }
  return out;
}

// Looks up the overall rating + tier for the named signed-in players and re-broadcasts
// the lobby if any changed. Cached on the player (not fetched per lobbyUpdate) because
// ratings only move when a game is recorded: called on join and on every return to the
// lobby. Best-effort - a failed lookup just leaves the previous value (or none).
async function refreshRatings(roomCode, room, names) {
  const targets = names
    .map((n) => [n, room.players.get(n)])
    .filter(([, p]) => p && p.signedIn && p.userId);
  if (!targets.length) return;
  let changed = false;
  await Promise.all(
    targets.map(async ([, p]) => {
      const result = await playerCardForUser(p.userId);
      const r = result && result.card && result.card.ratings;
      if (!r) return;
      if (!p.rating || p.rating.ovr !== r.ovr || p.rating.tier !== r.tier) {
        p.rating = { ovr: r.ovr, tier: r.tier };
        changed = true;
      }
    })
  );
  if (changed && room.phase === 'lobby') broadcastLobby(roomCode, room);
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
    playerStickers: connectedStickers(room),
    playerSignedIn: connectedSignedIn(room),
    playerRatings: connectedRatings(room),
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
  // The game that just ended may have moved signed-in players' ratings.
  refreshRatings(roomCode, room, connectedNames(room)).catch(() => {});
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
    playerStickers: connectedStickers(room),
    playerSignedIn: connectedSignedIn(room),
    playerRatings: connectedRatings(room),
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

function joinExistingRoom(socket, roomCode, name, clientId, callback, sticker, userId) {
  const room = rooms.get(roomCode);
  if (!room) return callback({ ok: false, error: 'Room not found' });

  const existing = room.players.get(name);

  if (existing) {
    // A reconnect resends whatever sticker the client has saved locally, so this
    // also doubles as how a picker change made via `changeSticker` survives a
    // dropped connection.
    if (sticker !== undefined) existing.sticker = sticker;
    if (userId !== undefined) {
      existing.userId = userId;
      existing.signedIn = !!userId;
    }
    let staleSocket = null;
    if (!existing.connected) logActivity('join', `${name} reconnected`);
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
    // isn't stuck without one. Only hand host back if nobody was around to inherit
    // it (room went hostless) - if someone else is currently holding it, a later
    // reconnect shouldn't silently bump them back out.
    if (existing.wasHost) {
      existing.wasHost = false;
      if (!room.hostName) setHost(roomCode, room, name);
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

  // All-In or Fold's dual-entry design deliberately lets brand-new players join the shared
  // room while a table is already 'playing' — they land on the lobby screen (via the
  // reconnectPayload's atLobby flag below) with the tile in "Rejoin" mode, and only enter
  // the actual table via the separate `enterAllInOrFold`/`aiofSitSeat` handlers, which
  // already accept brand-new seats mid-match. Every other game keeps the hard gate.
  if (room.phase !== 'lobby' && room.game !== 'allinorfold') {
    return callback({ ok: false, error: 'Game already in progress, wait for the next round' });
  }

  logActivity('join', `${name} joined${userId ? '' : ' (guest)'}`);
  room.players.set(name, {
    socketId: socket.id,
    connected: true,
    clientId: clientId || null,
    sticker: sticker || null,
    // The account this player is signed in to on this connection (null = guest).
    userId: userId || null,
    signedIn: !!userId,
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

  // Built from the same reconnectPayload used for reconnecting players (rather than a
  // hardcoded { game: null, phase: 'lobby' }) so a brand-new join during an active
  // All-In or Fold match correctly reports `atLobby`/`game` instead of lying about the
  // room's real state.
  const payload = reconnectPayload(room, room.players.get(name));
  payload.roomCode = roomCode;
  payload.background = room.backgroundImage;
  callback(payload);
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

/**
 * Why `name` can't be taken out of the room right now, or null if they can. Game modules
 * key their in-progress state by name, so removal is a lobby-only thing - except in
 * All-In or Fold, whose spectators wait on the lobby screen for the whole match (see
 * all-in-or-fold-plan.md's dual-entry note) and only need to leave their seat first.
 */
function removalError(room, name) {
  if (room.game === 'allinorfold') {
    if (room.aiofSeats.includes(name)) return 'Leave your seat at the table first';
  } else if (room.phase !== 'lobby') {
    return 'Only available in the lobby';
  }
  return null;
}

/** Takes `name` out of the room and off the scoreboard (leaving, kicked, or long gone); `socket` is theirs, if connected. */
function removePlayer(roomCode, room, name, socket) {
  room.players.delete(name);
  if (room.scoreboard) delete room.scoreboard[name];
  if (socket) {
    socket.leave(roomCode);
    socket.data.roomCode = null;
    socket.data.name = null;
  }

  if (room.players.size === 0) {
    // Nobody's left in the room at all. Without this, the room stays stuck on
    // whatever game/phase it was last in (e.g. mid-AIOF-match) forever: a brand-new
    // join is rejected outside room.phase === 'lobby', and chooseGame/backToLobby
    // both require already being a room member to call them - so there'd be no one
    // left who *could* reset it. Give the next joiner a clean lobby instead.
    //
    // resetToLobby doesn't touch hostName (normally it's called with the host still
    // present, e.g. mid-game "Back to Lobby"), so clear it explicitly here - otherwise
    // it'd keep pointing at a player who no longer exists, silently blocking the next
    // joiner from ever becoming host (`join` only assigns a host when there isn't one).
    room.hostName = null;
    resetToLobby(roomCode, room);
  } else {
    if (name === room.hostName) {
      const [nextHost] = connectedNames(room);
      setHost(roomCode, room, nextHost || null);
    }
    broadcastLobby(roomCode, room);
  }
}

/**
 * Admin kick (server/admin.js): tells the player's phone, then removes them from the
 * room. Outside the lobby that would desync the game, so it's refused unless `force`
 * (a ban), which just drops their connection - the game treats it like any disconnect,
 * and the ban stops them rejoining. Returns an error string, or null on success.
 */
function kickPlayer(roomCode, room, name, { reason = 'You were removed by the admin', force = false } = {}) {
  const player = room.players.get(name);
  if (!player) return 'No such player';
  const error = removalError(room, name);
  if (error && !force) return error;
  const socket = player.connected && player.socketId && ctx.io.sockets
    ? ctx.io.sockets.sockets.get(player.socketId)
    : null;
  if (socket) socket.emit('kicked', { reason });
  if (!error) removePlayer(roomCode, room, name, socket);
  if (socket) socket.disconnect(true);
  return null;
}

/**
 * Drops players who have been disconnected for STALE_PLAYER_MS, wherever removal is
 * allowed (see removalError - never mid-game), and scoreboard entries for names no longer
 * in the room. Run on a timer from server.js.
 */
function sweepStalePlayers(now = Date.now()) {
  for (const [roomCode, room] of rooms) {
    for (const [name, p] of room.players) {
      if (p.connected) continue;
      // Players restored from disk (or from before this field existed) start their clock now.
      if (!p.disconnectedAt) {
        p.disconnectedAt = now;
        continue;
      }
      if (now - p.disconnectedAt < STALE_PLAYER_MS || removalError(room, name)) continue;
      removePlayer(roomCode, room, name, null);
      logActivity('leave', `${name} removed after ${Math.round(STALE_PLAYER_MS / 60000)} min away`);
    }
    const stale = Object.keys(room.scoreboard || {}).filter((n) => !room.players.has(n));
    if (stale.length) {
      for (const n of stale) delete room.scoreboard[n];
      if (room.phase === 'lobby') broadcastLobby(roomCode, room);
    }
  }
}

function registerLobbyHandlers(socket) {
  const { BACKGROUNDS_DIR } = hooks;

  socket.on('join', async (data, callback) => {
    callback = callback || (() => {});
    const name = ((data && data.name) || '').trim();
    const clientId = String((data && data.clientId) || '').slice(0, 64);
    // Signed in = a valid login cookie on this connection, not merely a device that was
    // once linked to an account - so signing out makes this phone a guest again.
    const user = await userFromSocket(socket);
    const userId = user ? String(user.id) : null;
    // A signed-in account's sticker wins over whatever this device last had locally -
    // see "Sticker unification" in specs/account-page-specs.md.
    const rawSticker = (user && user.sticker) || (data && data.sticker);
    // A badge sticker this player hasn't unlocked is dropped (joining still succeeds).
    const sticker =
      isValidSticker(rawSticker) && (await canUseSticker(userId, rawSticker)) ? rawSticker : null;

    const nameError = validateName(name);
    if (nameError) return callback({ ok: false, error: nameError });
    if (await isBanned({ userId, clientId })) {
      return callback({ ok: false, error: 'You have been banned from Shorot' });
    }

    const room = getSharedRoom();
    joinExistingRoom(socket, SHARED_ROOM_CODE, name, clientId, (res) => {
      if (res && res.ok) {
        stats.recordPlayer(clientId, connectedNames(room).length);
        if (userId) refreshRatings(SHARED_ROOM_CODE, room, [name]).catch(() => {});
      }
      callback(res);
    }, sticker, userId);
  });

  // Fetches another connected, signed-in player's rating card for the lobby's
  // click-to-view popup (see the glowing avatar in public/js/main.js's renderLobby).
  socket.on('viewPlayerCard', async (name, callback) => {
    callback = callback || (() => {});
    const room = getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    const player = room.players.get(String(name || ''));
    if (!player || !player.connected || !player.signedIn) {
      return callback({ ok: false, error: 'Player card not available' });
    }
    const result = await playerCardForUser(player.userId);
    if (!result) return callback({ ok: false, error: 'Could not load card' });
    callback({ ok: true, ...result });
  });

  socket.on('changeSticker', async (data, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.phase !== 'lobby') {
      return callback({ ok: false, error: 'Can only change your sticker in the lobby' });
    }

    const name = socket.data.name;
    const player = room.players.get(name);
    if (!player) return callback({ ok: false, error: 'Not in a room' });

    const rawSticker = data && data.sticker;
    if (isValidSticker(rawSticker) && !(await canUseSticker(player.userId, rawSticker))) {
      return callback({ ok: false, error: 'Earn its badge to unlock this sticker' });
    }
    // Empty/invalid clears back to the emoji fallback rather than erroring - "no sticker"
    // is always a valid choice, not just an invalid one.
    player.sticker = isValidSticker(rawSticker) ? rawSticker : null;
    // Best-effort: if this device is signed in, keep the account's sticker in sync too,
    // same as recordGameResult treats the database elsewhere.
    setAccountSticker(player.userId, player.sticker);

    broadcastLobby(roomCode, room);
    callback({ ok: true, sticker: player.sticker });
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
    stats.recordGame(game.id);
    logActivity('game', `${socket.data.name} started ${game.id} with ${names.length} players`);
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

  // Shared reaction row (any screen, any game) - broadcasts a curated sticker to the room
  // as a floating reaction. Purely cosmetic, not persisted, rate-limited per socket.
  socket.on('sendReaction', (sticker, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (!REACTION_STICKERS.includes(sticker)) return callback({ ok: false, error: 'Invalid reaction' });

    const now = Date.now();
    const last = lastReactionAt.get(socket.id) || 0;
    if (now - last < REACTION_COOLDOWN_MS) return callback({ ok: false, error: 'Too fast' });
    lastReactionAt.set(socket.id, now);

    callback({ ok: true });
    roomEmit(roomCode, 'reaction', { name: socket.data.name, sticker });
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
    if (room.game) logActivity('game', `${socket.data.name} ended ${room.game}, back to the lobby`);
    resetToLobby(roomCode, room);
    callback({ ok: true });
  });

  socket.on('leaveLobby', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });

    const name = socket.data.name;
    const error = removalError(room, name);
    if (error) return callback({ ok: false, error });

    removePlayer(roomCode, room, name, socket);
    logActivity('leave', `${name} left`);
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
    lastReactionAt.delete(socket.id);
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
    p.disconnectedAt = Date.now();
    logActivity('leave', `${name} disconnected`);
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
  kickPlayer,
  attachToRoom,
  reconnectPayload,
  joinExistingRoom,
  registerBackgroundRoutes,
  registerLobbyHandlers,
  sweepStalePlayers,
  SHARED_ROOM_CODE,
};
