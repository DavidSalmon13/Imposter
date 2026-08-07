const socket = io();

const MIN_PLAYERS = 3;
const CN_MIN_PLAYERS = 4;
const TS_MIN_PLAYERS = 2;

const screens = {
  join: document.getElementById('join-screen'),
  lobby: document.getElementById('lobby-screen'),
  voting: document.getElementById('voting-screen'),
  generating: document.getElementById('generating-screen'),
  game: document.getElementById('game-screen'),
  teamSelect: document.getElementById('team-select-screen'),
  codenames: document.getElementById('codenames-screen'),
  codenamesGameover: document.getElementById('codenames-gameover-screen'),
  tensSeconds: document.getElementById('ts-screen'),
};

const bgControls = document.getElementById('bg-controls');
const bgChangeBtn = document.getElementById('bg-change-btn');
const bgClearBtn = document.getElementById('bg-clear-btn');
const bgFileInput = document.getElementById('bg-file-input');
const bgError = document.getElementById('bg-error');

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
const chooseTensSecondsBtn = document.getElementById('choose-tenseconds-btn');

const levelButtons = Array.from(document.querySelectorAll('.level-btn:not(.cn-timer-btn)'));
const voteCount = document.getElementById('vote-count');
const votingError = document.getElementById('voting-error');
const votingBackBtn = document.getElementById('voting-back-btn');

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
const cnTeamBackBtn = document.getElementById('cn-team-back-btn');
const cnTimerBtns = Array.from(document.querySelectorAll('.cn-timer-btn'));

const cnTurnLabel = document.getElementById('cn-turn-label');
const cnScore = document.getElementById('cn-score');
const cnGrid = document.getElementById('cn-grid');
const cnEndTurnBtn = document.getElementById('cn-end-turn-btn');
const cnTimerDisplay = document.getElementById('cn-timer-display');
const cnStartTimerBtn = document.getElementById('cn-start-timer-btn');

const cnWinnerTitle = document.getElementById('cn-winner-title');
const cnFinalScore = document.getElementById('cn-final-score');
const cnFinalGrid = document.getElementById('cn-final-grid');
const cnPlayAgainBtn = document.getElementById('cn-play-again-btn');
const cnPlayAgainWaiting = document.getElementById('cn-play-again-waiting');
const cnBackBtn = document.getElementById('cn-back-btn');

const tsBadge = document.getElementById('ts-badge');
const tsTitle = document.getElementById('ts-title');
const tsSubtitle = document.getElementById('ts-subtitle');
const tsReadyPanel = document.getElementById('ts-ready-panel');
const tsPlayerList = document.getElementById('ts-player-list');
const tsStartBtn = document.getElementById('ts-start-btn');
const tsStartWaiting = document.getElementById('ts-start-waiting');
const tsReadyError = document.getElementById('ts-ready-error');
const tsRunningPanel = document.getElementById('ts-running-panel');
const tsCountdown = document.getElementById('ts-countdown');
const tsStopwatch = document.getElementById('ts-stopwatch');
const tsStopBtn = document.getElementById('ts-stop-btn');
const tsWaitingStops = document.getElementById('ts-waiting-stops');
const tsSpectateHint = document.getElementById('ts-spectate-hint');
const tsResultsPanel = document.getElementById('ts-results-panel');
const tsResultsBody = document.getElementById('ts-results-body');
const tsContinueBtn = document.getElementById('ts-continue-btn');
const tsContinueWaiting = document.getElementById('ts-continue-waiting');
const tsGameoverPanel = document.getElementById('ts-gameover-panel');
const tsChampion = document.getElementById('ts-champion');
const tsStandings = document.getElementById('ts-standings');
const tsPlayAgainBtn = document.getElementById('ts-play-again-btn');
const tsPlayAgainWaiting = document.getElementById('ts-play-again-waiting');
const tsBackBtn = document.getElementById('ts-back-btn');
const tsError = document.getElementById('ts-error');

let myName = localStorage.getItem('imposterName') || '';
let myRoomCode = localStorage.getItem('imposterRoom') || '';
let isHost = false;
let currentHostName = null;
let currentGame = null;
let myVote = null;
let pendingLevel = null;
let myTeam = null;
let isLeader = false;
let cnTimerSeconds = 0;
let cnTurnEndsAt = null;
let cnTimerTickHandle = null;
let tsRoundStartAt = null;
let tsTickHandle = null;
let tsHasStopped = false;
let tsIsContender = false;

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
  votingBackBtn.classList.toggle('hidden', !isHost);
  cnTeamBackBtn.classList.toggle('hidden', !isHost);
  tsBackBtn.classList.toggle('hidden', !isHost);
}

function showScreen(name) {
  Object.values(screens).forEach((el) => el.classList.add('hidden'));
  screens[name].classList.remove('hidden');
  bgControls.classList.toggle('hidden', name === 'join');
}

function applyBackground(url) {
  document.body.style.backgroundImage = url ? `url("${url}")` : '';
  bgClearBtn.classList.toggle('hidden', !url);
}

function resizeImage(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not read image'));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode image'))),
          'image/jpeg',
          quality
        );
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function formatCnTimer(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function tickCnTimer() {
  if (!cnTurnEndsAt) return;
  const remaining = cnTurnEndsAt - Date.now();
  cnTimerDisplay.textContent = formatCnTimer(remaining);
  cnTimerDisplay.classList.toggle('cn-timer-low', remaining <= 10000);
}

function stopCnTimerTick() {
  if (cnTimerTickHandle) {
    clearInterval(cnTimerTickHandle);
    cnTimerTickHandle = null;
  }
}

function startCnTimerTick() {
  stopCnTimerTick();
  tickCnTimer();
  cnTimerTickHandle = setInterval(tickCnTimer, 250);
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
      applyBackground(null);
    }
    showScreen('join');
    return;
  }
  rememberSession(name, res.roomCode);
  applyBackground(res.background || null);
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

  if (res.game === 'tenseconds') {
    applyTensSecondsState(res);
    showScreen('tensSeconds');
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

chooseTensSecondsBtn.addEventListener('click', () => {
  chooseError.textContent = '';
  socket.emit('chooseGame', 'tenseconds', (res) => {
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

cnTimerBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!isHost) return;
    const seconds = Number(btn.dataset.seconds);
    socket.emit('setCnTimer', seconds, (res) => {
      if (res && !res.ok) cnTeamError.textContent = res.error;
    });
  });
});

cnStartBtn.addEventListener('click', () => {
  cnTeamError.textContent = '';
  socket.emit('startCodenames', (res) => {
    if (!res.ok) cnTeamError.textContent = res.error;
  });
});

cnStartTimerBtn.addEventListener('click', () => {
  socket.emit('startCnTurnTimer', () => {});
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

votingBackBtn.addEventListener('click', () => {
  socket.emit('backToLobby', () => {});
});

cnTeamBackBtn.addEventListener('click', () => {
  socket.emit('backToLobby', () => {});
});

tsStartBtn.addEventListener('click', () => {
  tsReadyError.textContent = '';
  tsError.textContent = '';
  socket.emit('startTensSeconds', (res) => {
    if (res && !res.ok) tsReadyError.textContent = res.error;
  });
});

tsStopBtn.addEventListener('click', () => {
  if (!tsRoundStartAt || tsHasStopped) return;
  const elapsed = Date.now() - tsRoundStartAt;
  if (elapsed < 0) return;
  tsHasStopped = true;
  tsStopBtn.disabled = true;
  stopTsTick();
  tsStopwatch.textContent = formatTsTime(elapsed);
  socket.emit('tsStop', elapsed, (res) => {
    if (res && !res.ok) {
      tsHasStopped = false;
      tsError.textContent = res.error || 'Could not submit stop';
    }
  });
});

tsContinueBtn.addEventListener('click', () => {
  socket.emit('tsContinue', (res) => {
    if (res && !res.ok) tsError.textContent = res.error;
  });
});

tsPlayAgainBtn.addEventListener('click', () => {
  socket.emit('playAgainTensSeconds', (res) => {
    if (res && !res.ok) tsError.textContent = res.error;
  });
});

tsBackBtn.addEventListener('click', () => {
  socket.emit('backToLobby', () => {});
});

bgChangeBtn.addEventListener('click', () => {
  bgFileInput.click();
});

bgFileInput.addEventListener('change', async () => {
  const file = bgFileInput.files[0];
  bgFileInput.value = '';
  if (!file || !myRoomCode) return;

  bgError.textContent = '';
  bgError.classList.add('hidden');
  try {
    const blob = await resizeImage(file, 1600, 0.82);
    const res = await fetch(`/api/rooms/${myRoomCode}/background?name=${encodeURIComponent(myName)}`, {
      method: 'POST',
      headers: { 'Content-Type': blob.type },
      body: blob,
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Upload failed');
    applyBackground(data.background);
  } catch (err) {
    bgError.textContent = 'Could not set background - try a smaller or different image.';
    bgError.classList.remove('hidden');
  }
});

bgClearBtn.addEventListener('click', () => {
  socket.emit('clearBackground', () => {});
});

socket.on('backgroundChanged', ({ background }) => {
  applyBackground(background);
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

socket.on('tensSecondsState', (data) => {
  applyTensSecondsState(data);
  showScreen('tensSeconds');
});

socket.on('backToLobby', () => {
  currentGame = null;
  myVote = null;
  pendingLevel = null;
  myTeam = null;
  isLeader = false;
  cnTimerSeconds = 0;
  cnTurnEndsAt = null;
  stopCnTimerTick();
  stopTsTick();
  tsRoundStartAt = null;
  tsHasStopped = false;
  tsIsContender = false;
  cnTeamError.textContent = '';
  chooseError.textContent = '';
  tsError.textContent = '';
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
  chooseTensSecondsBtn.disabled = players.length < TS_MIN_PLAYERS;
  if (players.length < MIN_PLAYERS) {
    chooseError.textContent = `Need at least ${TS_MIN_PLAYERS} for 10 Seconds, ${MIN_PLAYERS} for Imposter, ${CN_MIN_PLAYERS} for Codenames`;
  } else if (players.length < CN_MIN_PLAYERS) {
    chooseError.textContent = `Need at least ${CN_MIN_PLAYERS} players for Codenames`;
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

  cnTimerSeconds = data.timerSeconds || 0;
  cnTimerBtns.forEach((btn) => {
    btn.classList.toggle('selected', Number(btn.dataset.seconds) === cnTimerSeconds);
    btn.disabled = !isHost;
  });
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
  cnTimerSeconds = data.timerSeconds || 0;
  cnTurnEndsAt = data.turnEndsAt || null;

  if (data.phase === 'gameover') {
    stopCnTimerTick();
    cnTimerDisplay.classList.add('hidden');
    cnStartTimerBtn.classList.add('hidden');
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

    const waitingToStart = cnTimerSeconds > 0 && !cnTurnEndsAt;
    const interactive = mine && !isLeader && !waitingToStart;
    renderGrid(cnGrid, data.board, interactive, (i) => socket.emit('guessWord', i, () => {}));
    cnEndTurnBtn.classList.toggle('hidden', !interactive);
    cnStartTimerBtn.classList.toggle('hidden', !(waitingToStart && mine));

    if (cnTimerSeconds > 0 && cnTurnEndsAt) {
      cnTimerDisplay.classList.remove('hidden');
      startCnTimerTick();
    } else {
      stopCnTimerTick();
      cnTimerDisplay.classList.add('hidden');
    }
  }
}

function formatTsTime(ms) {
  const clamped = Math.max(0, ms);
  return (clamped / 1000).toFixed(3);
}

function formatTsDistance(ms) {
  if (!Number.isFinite(ms)) return 'DNF';
  return `${(ms / 1000).toFixed(3)}s`;
}

function stopTsTick() {
  if (tsTickHandle) {
    clearInterval(tsTickHandle);
    tsTickHandle = null;
  }
}

function tickTsRound() {
  if (!tsRoundStartAt) return;
  const now = Date.now();
  const untilStart = tsRoundStartAt - now;

  if (untilStart > 0) {
    tsCountdown.classList.remove('hidden');
    tsStopwatch.classList.add('hidden');
    tsStopBtn.classList.add('hidden');
    if (untilStart > 2000) {
      tsCountdown.textContent = '3';
      tsCountdown.classList.remove('ts-go');
    } else if (untilStart > 1000) {
      tsCountdown.textContent = '2';
      tsCountdown.classList.remove('ts-go');
    } else if (untilStart > 400) {
      tsCountdown.textContent = '1';
      tsCountdown.classList.remove('ts-go');
    } else {
      tsCountdown.textContent = 'GO';
      tsCountdown.classList.add('ts-go');
    }
    return;
  }

  tsCountdown.classList.add('hidden');

  if (!tsIsContender || tsHasStopped) {
    tsStopwatch.classList.add('hidden');
    tsStopBtn.classList.add('hidden');
    return;
  }

  const elapsed = now - tsRoundStartAt;
  tsStopwatch.classList.remove('hidden');
  tsStopwatch.textContent = formatTsTime(elapsed);
  tsStopBtn.classList.remove('hidden');
  tsStopBtn.disabled = false;
}

function startTsTick() {
  stopTsTick();
  tickTsRound();
  tsTickHandle = setInterval(tickTsRound, 16);
}

function applyTensSecondsState(data) {
  setHost(data.host);
  currentGame = 'tenseconds';
  tsError.textContent = '';
  tsRoundStartAt = data.roundStartAt || null;
  tsIsContender = !!data.isContender;
  tsHasStopped = !!(data.myResult && !data.myResult.dnf);

  tsBadge.classList.toggle('hidden', !data.eliminated);
  tsReadyPanel.classList.add('hidden');
  tsRunningPanel.classList.add('hidden');
  tsResultsPanel.classList.add('hidden');
  tsGameoverPanel.classList.add('hidden');
  stopTsTick();

  if (data.phase === 'ready') {
    tsTitle.textContent = '10 Seconds';
    tsSubtitle.textContent =
      data.roundNumber > 0 ? `Round ${data.roundNumber + 1}` : 'Stop as close as you can to 10.000s';
    tsReadyPanel.classList.remove('hidden');

    tsPlayerList.innerHTML = '';
    data.activePlayers.forEach((n) => {
      const li = document.createElement('li');
      const waiting = (data.waitingOn || []).includes(n);
      li.textContent = waiting ? `${n} (disconnected)` : n;
      if (waiting) li.classList.add('ts-disconnected');
      tsPlayerList.appendChild(li);
    });

    const waitingMsg =
      data.waitingOn && data.waitingOn.length
        ? `Waiting for ${data.waitingOn.join(', ')} to reconnect`
        : '';
    tsReadyError.textContent = waitingMsg;

    const label = data.roundNumber > 0 ? 'Next Round' : 'Start';
    tsStartBtn.textContent = label;
    tsStartBtn.classList.toggle('hidden', !isHost);
    tsStartBtn.disabled = !data.canStart;
    tsStartWaiting.classList.toggle('hidden', isHost);
    return;
  }

  if (data.phase === 'running') {
    tsTitle.textContent = data.suddenDeath ? 'Sudden Death!' : `Round ${data.roundNumber}`;
    tsSubtitle.textContent = data.suddenDeath
      ? `Tiebreaker — ${data.contenders.join(' vs ')}`
      : 'Stop as close as you can to 10.000s';
    tsRunningPanel.classList.remove('hidden');

    const spectating = data.eliminated || !data.isContender;
    tsSpectateHint.classList.toggle('hidden', !spectating);
    tsWaitingStops.classList.toggle('hidden', !(data.isContender && tsHasStopped));
    tsStopBtn.classList.add('hidden');
    tsStopwatch.classList.add('hidden');
    tsCountdown.classList.add('hidden');

    if (data.isContender && data.myResult && !data.myResult.dnf) {
      tsStopwatch.classList.remove('hidden');
      tsStopwatch.textContent = formatTsTime(data.myResult.elapsedMs);
      tsWaitingStops.classList.remove('hidden');
    } else if (data.isContender) {
      startTsTick();
    } else {
      // Spectators still see the shared countdown.
      startTsTick();
      tsStopwatch.classList.add('hidden');
      tsStopBtn.classList.add('hidden');
    }
    return;
  }

  if (data.phase === 'roundResults') {
    tsTitle.textContent = `Round ${data.roundNumber} Results`;
    tsSubtitle.textContent = '';
    tsResultsPanel.classList.remove('hidden');

    const rows = (data.contenders || []).map((name) => {
      const r = (data.results && data.results[name]) || {};
      return { name, ...r };
    });
    rows.sort((a, b) => {
      const da = a.dnf ? Number.POSITIVE_INFINITY : a.distanceMs;
      const db = b.dnf ? Number.POSITIVE_INFINITY : b.distanceMs;
      return da - db;
    });

    const justEliminated = new Set(
      (data.eliminatedOrder || []).filter((n) => (data.contenders || []).includes(n) && !(data.activePlayers || []).includes(n))
    );

    tsResultsBody.innerHTML = '';
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      if (justEliminated.has(row.name)) tr.classList.add('ts-eliminated-row');
      const timeText = row.dnf ? 'DNF' : formatTsTime(row.elapsedMs);
      const distText = row.dnf ? 'DNF' : formatTsDistance(row.distanceMs);
      tr.innerHTML = `<td>${row.name}${justEliminated.has(row.name) ? ' ✕' : ''}</td><td>${timeText}</td><td>${distText}</td>`;
      tsResultsBody.appendChild(tr);
    });

    tsContinueBtn.classList.toggle('hidden', !isHost);
    tsContinueBtn.textContent = data.activePlayers.length <= 1 ? 'See Standings' : 'Next Round';
    tsContinueWaiting.classList.toggle('hidden', isHost);
    return;
  }

  if (data.phase === 'gameover') {
    tsTitle.textContent = 'Game Over';
    tsSubtitle.textContent = '';
    tsGameoverPanel.classList.remove('hidden');
    const champion = (data.standings && data.standings[0]) || (data.activePlayers && data.activePlayers[0]) || '';
    tsChampion.textContent = champion ? `${champion} is the 10-Second Champion!` : 'No champion';
    tsStandings.innerHTML = '';
    (data.standings || []).forEach((name, i) => {
      const li = document.createElement('li');
      li.textContent = `${i + 1}. ${name}`;
      if (i === 0) li.classList.add('ts-champion-row');
      tsStandings.appendChild(li);
    });
    tsPlayAgainBtn.classList.toggle('hidden', !isHost);
    tsPlayAgainWaiting.classList.toggle('hidden', isHost);
  }
}

const urlRoom = roomCodeFromUrl();
if (urlRoom) {
  roomCodeInput.value = urlRoom;
  myRoomCode = urlRoom;
}

if (myName) nameInput.value = myName;

// Re-sync on every connect, not just the first one - phones suspend the socket when the
// screen locks or the tab backgrounds, and on reconnect we need to catch back up to the
// current phase/screen rather than being stuck on whatever was last rendered.
socket.on('connect', () => {
  if (myName && myRoomCode) attemptJoin(myName, myRoomCode);
});
