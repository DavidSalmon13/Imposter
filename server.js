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
} = require('./server/lobby');
const { registerAllHandlers } = require('./server/gameRegistry');
const { STICKER_FILES } = require('./server/stickers');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
initRoomStore(io);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/stickers', (req, res) => {
  res.json({ stickers: STICKER_FILES });
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
  registerLobbyHandlers(socket);
  registerAllHandlers(ctx, io, socket);
});

loadRoomsFromDisk({ ctx });
setInterval(saveRoomsToDisk, SAVE_INTERVAL_MS);

async function shutdown() {
  await saveRoomsToDisk();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Shorot listening on ${PORT}`));
