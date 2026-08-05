const socket = io();

const MIN_PLAYERS = 3;
const CN_MIN_PLAYERS = 4;

const screens = {
  join: document.getElementById('join-screen'),
  lobby: document.getElementById('lobby-screen'),
  voting: document.getElementById('voting-screen'),
  generating: document.getElementById('generating-screen'),
  game: document.getElementById('game-screen'),
  teamSelect: document.getElementById('team-select-screen'),
  codenames: document.getElementById('codenames-screen'),
  codenamesGameover: document.getElementById('codenames-gameover-screen'),
};

const nameInput = document.getElementById('name-input');
const roomCodeInput = document.getElementById('room-code-input');
const createRoomBtn = document.getElementById('create-room-btn');
const joinBtn = document.getElementById('join-btn');
const joinError = document.getElementById('join-error');

const roomCodeDisplay = document.getElementById('room-code-display');
const lobbyList = document.getElementById('lobby-list');
const lobbyCount = document.getElementById('lobby-count');
const gameChoice = document.getElementById('game-choice');
const chooseWaiting = document.getElementById('choose-waiting');
const chooseError = document.getElementById('choose-error');
const chooseImposterBtn = document.getElementById('choose-imposter-btn');
const chooseCodenamesBtn = document.getElementById('choose-codenames-btn');

const levelButtons = Array.from(document.querySelectorAll('.level-btn'));
const voteCount = document.getElementById('vote-count');
const votingError = document.getElementById('voting-error');

const levelLabel = document.getElementById('level-label');
const roleEl = document.getElementById('role-panel');
const playAgainBtn = document.getElementById('play-again-btn');
const playAgainWaiting = document.getElementById('play-again-waiting');

const generatingTitle = document.getElementById('generating-title');
const generatingSubtitle = document.getElementById('generating-subtitle');

const redList = document.getElementById('red-list');
const blueList = document.getElementById('blue-list');
const joinRedBtn = document.getElementById('join-red-btn');
const joinBlueBtn = document.getElementById('join-blue-btn');
const leaderRedBtn = document.getElementById('leader-red-btn');
const leaderBlueBtn = document.getElementById('leader-blue-btn');
const cnStartBtn = document.getElementById('cn-start-btn');
const cnStartWaiting = document.getElementById('cn-start-waiting');
const cnTeamError = document.getElementById('cn-team-error');

const cnTurnLabel = document.getElementById('cn-turn-label');
const cnScore = document.getElementById('cn-score');
const cnGrid = document.getElementById('cn-grid');
const cnEndTurnBtn = document.getElementById('cn-end-turn-btn');

const cnWinnerTitle = document.getElementById('cn-winner-title');
const cnFinalScore = document.getElementById('cn-final-score');
const cnFinalGrid = document.getElementById('cn-final-grid');
const cnPlayAgainBtn = document.getElementById('cn-play-again-btn');
const cnPlayAgainWaiting = document.getElementById('cn-play-again-waiting');
const cnBackBtn = document.getElementById('cn-back-btn');

let myName = localStorage.getItem('imposterName') || '';
let myRoomCode = localStorage.getItem('imposterRoom') || '';
let isHost = false;
let currentHostName = null;
let currentGame = null;
let myVote = null;
let pendingLevel = null;
let myTeam = null;
let isLeader = false;

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

function normalizeRoomCode(code) {
  return String(code || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 4);
}

function roomCodeFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return normalizeRoomCode(params.get('room'));
}

function setRoomInUrl(roomCode) {
  const url = new URL(window.location.href);
  if (roomCode) url.searchParams.set('room', roomCode);
  else url.searchParams.delete('room');
  window.history.replaceState({}, '', url);
}

function rememberSession(name, roomCode) {
  myName = name;
  myRoomCode = roomCode;
  localStorage.setItem('imposterName', name);
  localStorage.setItem('imposterRoom', roomCode);
  setRoomInUrl(roomCode);
  roomCodeDisplay.textContent = roomCode;
}

function setHost(hostName) {
  currentHostName = hostName || null;
  isHost = !!hostName && hostName === myName;
  gameChoice.classList.toggle('hidden', !isHost);
  chooseWaiting.classList.toggle('hidden', isHost);
  playAgainBtn.classList.toggle('hidden', !isHost);
  playAgainWaiting.classList.toggle('hidden', isHost);
  cnBackBtn.classList.toggle('hidden', !isHost);
}

function showScreen(name) {
  Object.values(screens).forEach((el) => el.classList.add('hidden'));
  screens[name].classList.remove('hidden');
}

function showGenerating(game) {
  if (game === 'codenames') {
    generatingTitle.textContent = 'Building the board…';
    generatingSubtitle.textContent = 'Asking ChatGPT for 25 words.';
  } else {
    generatingTitle.textContent = 'Picking a word…';
    generatingSubtitle.textContent = 'Asking ChatGPT to come up with a word and hint.';
  }
  showScreen('generating');
}

function handleJoinResult(res, name) {
  if (!res.ok) {
    joinError.textContent = res.error;
    if (res.error === 'Room not found') {
      localStorage.removeItem('imposterRoom');
      myRoomCode = '';
      setRoomInUrl('');
    }
    showScreen('join');
    return;
  }
  rememberSession(name, res.roomCode);
  routeFromJoin(res);
}

function attemptCreate(name) {
  socket.emit('createRoom', { name }, (res) => handleJoinResult(res, name));
}

function attemptJoin(name, roomCode) {
  socket.emit('join', { name, roomCode }, (res) => handleJoinResult(res, name));
}

function routeFromJoin(res) {
  currentGame = res.game || null;
  setHost(res.host);

  if (res.game === 'imposter') {
    if (res.phase === 'playing') {
      renderGame(res.level, res.role, res.word, res.hint);
      showScreen('game');
    } else if (res.phase === 'generating') {
      showGenerating('imposter');
    } else if (res.phase === 'voting') {
      myVote = res.vote || null;
      renderVoting();
      showScreen('voting');
    }
    return;
  }

  if (res.game === 'codenames') {
    if (res.phase === 'teamSelect') {
      renderTeamSelect(res);
      showScreen('teamSelect');
    } else if (res.phase === 'generating') {
      showGenerating('codenames');
    } else {
      applyCodenamesState(res);
      showScreen(res.phase === 'gameover' ? 'codenamesGameover' : 'codenames');
    }
    return;
  }

  renderLobby(res.players || []);
  showScreen('lobby');
}

function readName() {
  return nameInput.value.trim();
}

createRoomBtn.addEventListener('click', () => {
  const name = readName();
  joinError.textContent = '';
  if (!name) {
    joinError.textContent = 'Enter a name';
    return;
  }
  attemptCreate(name);
});

joinBtn.addEventListener('click', () => {
  const name = readName();
  const roomCode = normalizeRoomCode(roomCodeInput.value);
  joinError.textContent = '';
  if (!name) {
    joinError.textContent = 'Enter a name';
    return;
  }
  if (roomCode.length !== 4) {
    joinError.textContent = 'Enter a 4-character room code';
    return;
  }
  attemptJoin(name, roomCode);
});

nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinBtn.click();
});

roomCodeInput.addEventListener('input', () => {
  roomCodeInput.value = normalizeRoomCode(roomCodeInput.value);
});

roomCodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinBtn.click();
});

chooseImposterBtn.addEventListener('click', () => {
  chooseError.textContent = '';
  socket.emit('chooseGame', 'imposter', (res) => {
    if (!res.ok) chooseError.textContent = res.error;
  });
});

chooseCodenamesBtn.addEventListener('click', () => {
  chooseError.textContent = '';
  socket.emit('chooseGame', 'codenames', (res) => {
    if (!res.ok) chooseError.textContent = res.error;
  });
});

playAgainBtn.addEventListener('click', () => {
  socket.emit('backToLobby', () => {});
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

joinRedBtn.addEventListener('click', () => {
  socket.emit('joinTeam', 'red', (res) => {
    if (res && !res.ok) cnTeamError.textContent = res.error;
  });
});

joinBlueBtn.addEventListener('click', () => {
  socket.emit('joinTeam', 'blue', (res) => {
    if (res && !res.ok) cnTeamError.textContent = res.error;
  });
});

leaderRedBtn.addEventListener('click', () => {
  socket.emit('claimLeader', (res) => {
    if (res && !res.ok) cnTeamError.textContent = res.error;
  });
});

leaderBlueBtn.addEventListener('click', () => {
  socket.emit('claimLeader', (res) => {
    if (res && !res.ok) cnTeamError.textContent = res.error;
  });
});

cnStartBtn.addEventListener('click', () => {
  cnTeamError.textContent = '';
  socket.emit('startCodenames', (res) => {
    if (!res.ok) cnTeamError.textContent = res.error;
  });
});

cnEndTurnBtn.addEventListener('click', () => {
  socket.emit('endTurn', () => {});
});

cnPlayAgainBtn.addEventListener('click', () => {
  socket.emit('playAgainCodenames', () => {});
});

cnBackBtn.addEventListener('click', () => {
  socket.emit('backToLobby', () => {});
});

socket.on('lobbyUpdate', ({ players, host, roomCode }) => {
  setHost(host);
  if (roomCode) roomCodeDisplay.textContent = roomCode;
  renderLobby(players);
});

socket.on('hostUpdate', ({ host }) => {
  setHost(host);
});

socket.on('gameChosen', ({ game }) => {
  currentGame = game;
});

socket.on('votingStarted', ({ host }) => {
  setHost(host);
  myVote = null;
  votingError.textContent = '';
  renderVoting();
  showScreen('voting');
});

socket.on('votingUpdate', ({ total, voted, host }) => {
  setHost(host);
  voteCount.textContent = `${voted} of ${total} voted`;
});

socket.on('generating', ({ game }) => {
  showGenerating(game || currentGame);
});

socket.on('gameStarted', ({ level }) => {
  pendingLevel = level;
});

socket.on('role', ({ role, word, hint }) => {
  renderGame(pendingLevel, role, word, hint);
  showScreen('game');
});

socket.on('startFailed', ({ error }) => {
  votingError.textContent = error;
  showScreen('voting');
});

socket.on('teamSelectUpdate', (data) => {
  renderTeamSelect(data);
  showScreen('teamSelect');
});

socket.on('codenamesStartFailed', ({ error }) => {
  cnTeamError.textContent = error;
  showScreen('teamSelect');
});

socket.on('codenamesState', (data) => {
  applyCodenamesState(data);
  showScreen(data.phase === 'gameover' ? 'codenamesGameover' : 'codenames');
});

socket.on('backToLobby', () => {
  currentGame = null;
  myVote = null;
  pendingLevel = null;
  myTeam = null;
  isLeader = false;
  cnTeamError.textContent = '';
  chooseError.textContent = '';
  showScreen('lobby');
});

function renderLobby(players) {
  lobbyList.innerHTML = '';
  players.forEach((n) => {
    const li = document.createElement('li');
    li.textContent = n === currentHostName ? `${n} (host)` : n;
    lobbyList.appendChild(li);
  });
  lobbyCount.textContent = `${players.length} joined`;
  chooseImposterBtn.disabled = players.length < MIN_PLAYERS;
  chooseCodenamesBtn.disabled = players.length < CN_MIN_PLAYERS;
  if (players.length < CN_MIN_PLAYERS) {
    chooseError.textContent =
      players.length < MIN_PLAYERS
        ? `Need at least ${MIN_PLAYERS} players for Imposter, ${CN_MIN_PLAYERS} for Codenames`
        : `Need at least ${CN_MIN_PLAYERS} players for Codenames`;
  } else {
    chooseError.textContent = '';
  }
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

function renderTeamMembers(el, members) {
  el.innerHTML = '';
  members.forEach((m) => {
    const li = document.createElement('li');
    li.textContent = m.leader ? `${m.name} (leader)` : m.name;
    el.appendChild(li);
  });
}

function renderTeamSelect(data) {
  setHost(data.host);
  myTeam = null;
  isLeader = false;
  [...data.red, ...data.blue].forEach((m) => {
    if (m.name === myName) {
      myTeam = data.red.includes(m) ? 'red' : 'blue';
      isLeader = m.leader;
    }
  });

  renderTeamMembers(redList, data.red);
  renderTeamMembers(blueList, data.blue);

  joinRedBtn.classList.toggle('hidden', myTeam === 'red');
  joinBlueBtn.classList.toggle('hidden', myTeam === 'blue');

  const redHasLeader = data.red.some((p) => p.leader);
  const blueHasLeader = data.blue.some((p) => p.leader);

  leaderRedBtn.classList.toggle('hidden', myTeam !== 'red' || redHasLeader);
  leaderBlueBtn.classList.toggle('hidden', myTeam !== 'blue' || blueHasLeader);

  const redValid = data.red.length >= 2 && redHasLeader;
  const blueValid = data.blue.length >= 2 && blueHasLeader;
  const ready = redValid && blueValid;

  cnStartBtn.classList.toggle('hidden', !isHost);
  cnStartBtn.disabled = !ready;
  cnStartWaiting.classList.toggle('hidden', isHost);

  cnTeamError.textContent = ready ? '' : 'Each team needs at least 2 players including a leader';
}

function renderGrid(container, board, interactive, onClick) {
  container.innerHTML = '';
  board.forEach((cell, i) => {
    const btn = document.createElement('button');
    btn.className = 'cn-card';
    btn.textContent = cell.word;
    if (cell.revealed) {
      btn.classList.add('revealed', `cn-${cell.color}`);
    } else if (cell.color) {
      btn.classList.add('cn-leader-hint', `cn-${cell.color}`);
    }
    const clickable = interactive && !cell.revealed;
    btn.disabled = !clickable;
    if (clickable) {
      btn.addEventListener('click', () => onClick(i));
    }
    container.appendChild(btn);
  });
}

function applyCodenamesState(data) {
  setHost(data.host);
  myTeam = data.myTeam;
  isLeader = data.isLeader;

  if (data.phase === 'gameover') {
    cnWinnerTitle.textContent = `${capitalize(data.winner)} Wins!`;
    cnWinnerTitle.className = `cn-turn-${data.winner}`;
    cnFinalScore.textContent = `Red ${data.scores.red} — Blue ${data.scores.blue}`;
    renderGrid(cnFinalGrid, data.board, false, null);
    cnPlayAgainBtn.classList.toggle('hidden', !isLeader);
    cnPlayAgainWaiting.classList.toggle('hidden', isLeader);
  } else {
    const mine = data.activeTeam === myTeam;
    cnTurnLabel.textContent = mine
      ? `${capitalize(data.activeTeam)}'s turn (yours!)`
      : `${capitalize(data.activeTeam)}'s turn`;
    cnTurnLabel.className = `cn-turn cn-turn-${data.activeTeam}`;
    cnScore.textContent = `Red ${data.scores.red} — Blue ${data.scores.blue}`;

    const interactive = mine && !isLeader;
    renderGrid(cnGrid, data.board, interactive, (i) => socket.emit('guessWord', i, () => {}));
    cnEndTurnBtn.classList.toggle('hidden', !interactive);
  }
}

const urlRoom = roomCodeFromUrl();
if (urlRoom) {
  roomCodeInput.value = urlRoom;
  myRoomCode = urlRoom;
}

if (myName) nameInput.value = myName;

if (myName && myRoomCode) {
  attemptJoin(myName, myRoomCode);
}
