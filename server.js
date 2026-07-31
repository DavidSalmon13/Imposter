const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const words = require('./words.json');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const MIN_PLAYERS = 3;
const THEMES = Object.keys(words);

let phase = 'lobby'; // 'lobby' | 'playing'
let theme = null;
let board = [];
const players = new Map(); // name -> { socketId, connected, role, word }

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
  io.emit('lobbyUpdate', { players: connectedNames() });
}

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

      if (phase === 'playing') {
        return callback({
          ok: true,
          phase,
          theme,
          board,
          role: existing.role,
          word: existing.word,
        });
      }
      broadcastLobby();
      return callback({ ok: true, phase: 'lobby', players: connectedNames() });
    }

    if (phase === 'playing') {
      return callback({ ok: false, error: 'Game already in progress, wait for the next round' });
    }

    players.set(name, { socketId: socket.id, connected: true, role: null, word: null });
    socket.data.name = name;
    broadcastLobby();
    callback({ ok: true, phase: 'lobby', players: connectedNames() });
  });

  socket.on('start', (callback) => {
    callback = callback || (() => {});
    if (phase !== 'lobby') return callback({ ok: false, error: 'Game already started' });

    const names = connectedNames();
    if (names.length < MIN_PLAYERS) {
      return callback({ ok: false, error: `Need at least ${MIN_PLAYERS} players` });
    }

    theme = THEMES[Math.floor(Math.random() * THEMES.length)];
    board = shuffle(words[theme]).slice(0, 25);
    const secretWord = board[Math.floor(Math.random() * board.length)];
    const imposterName = names[Math.floor(Math.random() * names.length)];

    for (const [name, p] of players) {
      if (name === imposterName) {
        p.role = 'imposter';
        p.word = null;
      } else {
        p.role = 'crew';
        p.word = secretWord;
      }
    }

    phase = 'playing';
    io.emit('gameStarted', { theme, board });
    for (const [, p] of players) {
      if (p.connected) {
        io.to(p.socketId).emit('role', { role: p.role, word: p.word });
      }
    }
    callback({ ok: true });
  });

  socket.on('newGame', () => {
    players.clear();
    phase = 'lobby';
    theme = null;
    board = [];
    io.emit('reset');
  });

  socket.on('disconnect', () => {
    const name = socket.data.name;
    if (!name) return;
    const p = players.get(name);
    if (!p) return;

    if (phase === 'playing') {
      p.connected = false;
      return;
    }
    players.delete(name);
    broadcastLobby();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Imposter listening on ${PORT}`));
