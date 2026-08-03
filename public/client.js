const socket = io();

const MIN_PLAYERS = 3;

const screens = {
  join: document.getElementById('join-screen'),
  lobby: document.getElementById('lobby-screen'),
  voting: document.getElementById('voting-screen'),
  generating: document.getElementById('generating-screen'),
  game: document.getElementById('game-screen'),
};

const nameInput = document.getElementById('name-input');
const joinBtn = document.getElementById('join-btn');
const joinError = document.getElementById('join-error');

const lobbyList = document.getElementById('lobby-list');
const lobbyCount = document.getElementById('lobby-count');
const startBtn = document.getElementById('start-btn');
const startError = document.getElementById('start-error');
const startWaiting = document.getElementById('start-waiting');

const levelButtons = Array.from(document.querySelectorAll('.level-btn'));
const voteCount = document.getElementById('vote-count');

const levelLabel = document.getElementById('level-label');
const roleEl = document.getElementById('role-panel');
const playAgainBtn = document.getElementById('play-again-btn');
const playAgainWaiting = document.getElementById('play-again-waiting');

let myName = localStorage.getItem('imposterName') || '';
let isHost = false;
let currentHostName = null;
let myVote = null;
let pendingLevel = null;

function setHost(hostName) {
  currentHostName = hostName || null;
  isHost = !!hostName && hostName === myName;
  startBtn.classList.toggle('hidden', !isHost);
  startWaiting.classList.toggle('hidden', isHost);
  playAgainBtn.classList.toggle('hidden', !isHost);
  playAgainWaiting.classList.toggle('hidden', isHost);
}

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

    setHost(res.host);

    if (res.phase === 'playing') {
      renderGame(res.level, res.role, res.word, res.hint);
      showScreen('game');
    } else if (res.phase === 'generating') {
      showScreen('generating');
    } else if (res.phase === 'voting') {
      myVote = res.vote || null;
      renderVoting();
      showScreen('voting');
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
  socket.emit('newGame', (res) => {
    if (res && res.ok === false) startError.textContent = res.error;
  });
});

levelButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const level = btn.dataset.level;
    socket.emit('vote', level, (res) => {
      if (res && res.ok === false) return;
      myVote = level;
      renderVoting();
    });
  });
});

socket.on('lobbyUpdate', ({ players, host }) => {
  setHost(host);
  renderLobby(players);
});

socket.on('hostUpdate', ({ host }) => {
  setHost(host);
});

socket.on('votingStarted', ({ host }) => {
  setHost(host);
  myVote = null;
  startError.textContent = '';
  renderVoting();
  showScreen('voting');
});

socket.on('votingUpdate', ({ total, voted, host }) => {
  setHost(host);
  voteCount.textContent = `${voted} of ${total} voted`;
});

socket.on('generating', () => {
  showScreen('generating');
});

socket.on('gameStarted', ({ level }) => {
  pendingLevel = level;
});

socket.on('role', ({ role, word, hint }) => {
  renderGame(pendingLevel, role, word, hint);
  showScreen('game');
});

socket.on('startFailed', ({ error }) => {
  startError.textContent = error;
  showScreen('lobby');
});

socket.on('reset', () => {
  pendingLevel = null;
  myVote = null;
  isHost = false;
  nameInput.value = myName;
  joinError.textContent = '';
  showScreen('join');
});

function renderLobby(players) {
  lobbyList.innerHTML = '';
  players.forEach((n) => {
    const li = document.createElement('li');
    li.textContent = n === currentHostName ? `${n} (host)` : n;
    lobbyList.appendChild(li);
  });
  lobbyCount.textContent = `${players.length} joined`;
  startBtn.disabled = players.length < MIN_PLAYERS;
  startError.textContent =
    players.length < MIN_PLAYERS ? `Need at least ${MIN_PLAYERS} players to start` : '';
}

function renderVoting() {
  levelButtons.forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.level === myVote);
  });
}

function renderGame(level, role, word, hint) {
  levelLabel.textContent = level ? `Difficulty: ${level}` : '';

  if (role === 'imposter') {
    roleEl.className = 'role-panel imposter';
    roleEl.textContent = '';
    const title = document.createElement('div');
    title.textContent = 'YOU ARE THE IMPOSTER';
    const hintEl = document.createElement('div');
    hintEl.className = 'hint-text';
    hintEl.textContent = `Hint: ${hint}`;
    roleEl.appendChild(title);
    roleEl.appendChild(hintEl);
  } else {
    roleEl.className = 'role-panel crew';
    roleEl.textContent = `Your word: ${word}`;
  }
}

if (myName) {
  attemptJoin(myName);
}
