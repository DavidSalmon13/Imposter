const socket = io();

const MIN_PLAYERS = 3;

const screens = {
  join: document.getElementById('join-screen'),
  lobby: document.getElementById('lobby-screen'),
  game: document.getElementById('game-screen'),
};

const nameInput = document.getElementById('name-input');
const joinBtn = document.getElementById('join-btn');
const joinError = document.getElementById('join-error');

const lobbyList = document.getElementById('lobby-list');
const lobbyCount = document.getElementById('lobby-count');
const startBtn = document.getElementById('start-btn');
const startError = document.getElementById('start-error');

const themeLabel = document.getElementById('theme-label');
const boardEl = document.getElementById('board');
const roleEl = document.getElementById('role-panel');
const playAgainBtn = document.getElementById('play-again-btn');

let myName = localStorage.getItem('imposterName') || '';
let pendingRound = null; // { theme, board } while waiting for a private 'role' event

function showScreen(name) {
  Object.values(screens).forEach((el) => el.classList.add('hidden'));
  screens[name].classList.remove('hidden');
}

function attemptJoin(name) {
  socket.emit('join', { name }, (res) => {
    if (!res.ok) {
      joinError.textContent = res.error;
      showScreen('join');
      return;
    }
    myName = name;
    localStorage.setItem('imposterName', name);

    if (res.phase === 'playing') {
      renderGame(res.theme, res.board, res.role, res.word);
      showScreen('game');
    } else {
      renderLobby(res.players || []);
      showScreen('lobby');
    }
  });
}

joinBtn.addEventListener('click', () => {
  const name = nameInput.value.trim();
  joinError.textContent = '';
  if (!name) {
    joinError.textContent = 'Enter a name';
    return;
  }
  attemptJoin(name);
});

nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinBtn.click();
});

startBtn.addEventListener('click', () => {
  startError.textContent = '';
  socket.emit('start', (res) => {
    if (!res.ok) startError.textContent = res.error;
  });
});

playAgainBtn.addEventListener('click', () => {
  socket.emit('newGame');
});

socket.on('lobbyUpdate', ({ players }) => {
  if (!screens.lobby.classList.contains('hidden')) {
    renderLobby(players);
  }
});

socket.on('gameStarted', ({ theme, board }) => {
  pendingRound = { theme, board };
});

socket.on('role', ({ role, word }) => {
  const round = pendingRound || { theme: null, board: [] };
  renderGame(round.theme, round.board, role, word);
  showScreen('game');
});

socket.on('reset', () => {
  pendingRound = null;
  nameInput.value = myName;
  joinError.textContent = '';
  showScreen('join');
});

function renderLobby(players) {
  lobbyList.innerHTML = '';
  players.forEach((n) => {
    const li = document.createElement('li');
    li.textContent = n;
    lobbyList.appendChild(li);
  });
  lobbyCount.textContent = `${players.length} joined`;
  startBtn.disabled = players.length < MIN_PLAYERS;
  startError.textContent =
    players.length < MIN_PLAYERS ? `Need at least ${MIN_PLAYERS} players to start` : '';
}

function renderGame(theme, board, role, word) {
  themeLabel.textContent = theme ? `Theme: ${theme}` : '';
  boardEl.innerHTML = '';
  (board || []).forEach((w) => {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.textContent = w;
    boardEl.appendChild(cell);
  });

  if (role === 'imposter') {
    roleEl.className = 'role-panel imposter';
    roleEl.textContent = 'YOU ARE THE IMPOSTER';
  } else {
    roleEl.className = 'role-panel crew';
    roleEl.textContent = `Your word: ${word}`;
  }
}

if (myName) {
  attemptJoin(myName);
}
