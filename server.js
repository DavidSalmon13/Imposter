require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const {
  rooms,
  initRoomStore,
  getRoom,
  roomEmit,
} = require('./server/roomStore');
const {
  DATA_DIR,
  SAVE_INTERVAL_MS,
  saveRoomsToDisk,
  loadRoomsFromDisk,
} = require('./server/persistence');
const {
  initLobby,
  connectedNames,
  scoreboardEntries,
  addScore,
  broadcastLobby,
  attachToRoom,
  registerBackgroundRoutes,
  registerLobbyHandlers,
  SHARED_ROOM_CODE,
} = require('./server/lobby');
const { registerAllHandlers } = require('./server/gameRegistry');
const { CUSTOM_STICKERS_DIR, stickerFiles, addCustomSticker } = require('./server/stickers');
const stats = require('./server/stats');
const db = require('./server/db');
const accounts = require('./server/accounts');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
initRoomStore(io);

// Railway (and most hosts) sit one reverse proxy in front of the app; trust its
// X-Forwarded-For so req.ip is the real client (used by the /api/stats login lockout).
app.set('trust proxy', 1);

app.use(express.static(path.join(__dirname, 'public')));
stats.registerStatsRoutes(app);
accounts.registerAccountRoutes(app);

// Falls through from the public/ static above, so uploaded stickers share the
// built-ins' /images/stickers URL.
app.use('/images/stickers', express.static(CUSTOM_STICKERS_DIR));

app.get('/api/stickers', (req, res) => {
  res.json({ stickers: stickerFiles() });
});

// Any player in the room can add a sticker to the shared bank.
app.post('/api/stickers', express.raw({ type: 'image/*', limit: '2mb' }), (req, res) => {
  const room = rooms.get(SHARED_ROOM_CODE);
  const name = String(req.query.name || '').trim();
  if (!room || !room.players.has(name)) {
    return res.status(403).json({ ok: false, error: 'Not a player in this room' });
  }
  const result = addCustomSticker(req.headers['content-type'], req.body);
  if (result.error) return res.status(400).json({ ok: false, error: result.error });
  io.emit('stickersUpdated', { stickers: stickerFiles() });
  res.json({ ok: true, sticker: result.id });
});

// Tap sounds: any audio file dropped into public/sounds/ is picked up at boot, so adding
// or swapping a sound needs no code change. Clients play a random one per button press.
const SOUNDS_DIR = path.join(__dirname, 'public', 'sounds');
const SOUND_FILES = fs.existsSync(SOUNDS_DIR)
  ? fs.readdirSync(SOUNDS_DIR).filter((f) => /\.(mp3|ogg|wav|m4a)$/i.test(f)).sort()
  : [];

app.get('/api/sounds', (req, res) => {
  res.json({ sounds: SOUND_FILES });
});

const BACKGROUND_MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const BACKGROUNDS_DIR = path.join(DATA_DIR, 'backgrounds');

fs.mkdirSync(BACKGROUNDS_DIR, { recursive: true });
app.use('/backgrounds', express.static(BACKGROUNDS_DIR));
registerBackgroundRoutes(app, { BACKGROUNDS_DIR, BACKGROUND_MIME_EXT });

const ctx = {
  rooms,
  roomEmit,
  io,
  getRoom,
  connectedNames,
  scoreboardEntries,
  addScore,
  broadcastLobby,
  attachToRoom,
  saveRoomsToDisk,
  // Games pass names; this fills in each player's clientId (their device identity).
  recordGameResult(room, gameType, participants) {
    const roomCode = [...rooms.entries()].find(([, r]) => r === room)?.[0] || '';
    accounts.recordGameResult({
      roomCode,
      gameType,
      participants: participants.map((p) => ({
        ...p,
        clientId: room.players.get(p.name)?.clientId,
      })),
    });
  },
};

initLobby({
  ctx,
  BACKGROUNDS_DIR,
});

// Identifies the code this process is serving, so clients still running JS from before a
// deploy know to reload (see the 'serverBuild' listener in public/js/main.js). Prefer the
// deploy's commit so a plain restart of the same code doesn't force everyone to reload.
const SERVER_BUILD = process.env.RAILWAY_GIT_COMMIT_SHA || String(Date.now());

io.on('connection', (socket) => {
  socket.emit('serverBuild', SERVER_BUILD);
  stats.recordVisit(String((socket.handshake.auth && socket.handshake.auth.clientId) || '').slice(0, 64));
  registerLobbyHandlers(socket);
  registerAllHandlers(ctx, io, socket);
});

loadRoomsFromDisk({ ctx });
db.initDb().then(accounts.startCleanup);
setInterval(saveRoomsToDisk, SAVE_INTERVAL_MS);

async function shutdown() {
  await Promise.all([saveRoomsToDisk(), stats.saveStatsToDisk()]);
  await db.closeDb();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Shorot listening on ${PORT}`));
