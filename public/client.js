import { KartRace } from './js/games/kartRace.js';
import { sfx, haptics, isMuted, toggleMuted, renderScoreboardFx } from './js/fx.js';

const socket = io();
KartRace.init(socket);

const MIN_PLAYERS = 3;
const CN_MIN_PLAYERS = 4;
const TS_MIN_PLAYERS = 2;
const MF_MIN_PLAYERS = 2;
const MF_MAX_PLAYERS = 8;
const KR_MIN_PLAYERS = 2;

const screens = {
  join: document.getElementById('join-screen'),
  lobby: document.getElementById('lobby-screen'),
  voting: document.getElementById('voting-screen'),
  generating: document.getElementById('generating-screen'),
  game: document.getElementById('game-screen'),
  imposterReporting: document.getElementById('imposter-reporting-screen'),
  imposterResults: document.getElementById('imposter-results-screen'),
  teamSelect: document.getElementById('team-select-screen'),
  codenames: document.getElementById('codenames-screen'),
  codenamesGameover: document.getElementById('codenames-gameover-screen'),
  tensSeconds: document.getElementById('ts-screen'),
  menifot: document.getElementById('mf-screen'),
  kartRace: document.getElementById('kart-race-screen'),
};

const bgControls = document.getElementById('bg-controls');
const bgChangeBtn = document.getElementById('bg-change-btn');
const bgClearBtn = document.getElementById('bg-clear-btn');
const bgFileInput = document.getElementById('bg-file-input');
const bgError = document.getElementById('bg-error');
const muteBtn = document.getElementById('mute-btn');

function refreshMuteBtn() {
  const muted = isMuted();
  muteBtn.textContent = muted ? '🔇' : '🔊';
  muteBtn.title = muted ? 'Unmute sound' : 'Mute sound';
}

muteBtn.addEventListener('click', () => {
  toggleMuted();
  refreshMuteBtn();
});
refreshMuteBtn();

// Light tap feedback on every button press, except held racing controls
// (accelerate/steer/brake), which fire far too rapidly for a per-tap cue.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn || btn.disabled || btn.closest('#kr-controls')) return;
  sfx.click();
  haptics.tap();
});

const nameInput = document.getElementById('name-input');
const roomCodeInput = document.getElementById('room-code-input');
const createRoomBtn = document.getElementById('create-room-btn');
const joinBtn = document.getElementById('join-btn');
const joinError = document.getElementById('join-error');

const roomCodeDisplay = document.getElementById('room-code-display');
const lobbyList = document.getElementById('lobby-list');
const lobbyCount = document.getElementById('lobby-count');
const scoreboardList = document.getElementById('scoreboard-list');
const resetScoreboardBtn = document.getElementById('reset-scoreboard-btn');
const gameChoice = document.getElementById('game-choice');
const chooseWaiting = document.getElementById('choose-waiting');
const chooseError = document.getElementById('choose-error');
const chooseImposterBtn = document.getElementById('choose-imposter-btn');
const chooseCodenamesBtn = document.getElementById('choose-codenames-btn');
const chooseTensSecondsBtn = document.getElementById('choose-tenseconds-btn');
const chooseMenifotBtn = document.getElementById('choose-menifot-btn');
const chooseKartRaceBtn = document.getElementById('choose-kartrace-btn');
const exitLobbyBtn = document.getElementById('exit-lobby-btn');
const krBackBtn = document.getElementById('kr-back-btn');
const wordLanguageSection = document.getElementById('word-language-section');
const wordLanguageBtns = Array.from(document.querySelectorAll('.word-lang-btn'));
const wordThemeSection = document.getElementById('word-theme-section');
const wordThemeInput = document.getElementById('word-theme-input');

const levelButtons = Array.from(
  document.querySelectorAll('.level-btn:not(.cn-timer-btn):not(.word-lang-btn)')
);
const voteCount = document.getElementById('vote-count');
const votingError = document.getElementById('voting-error');
const votingBackBtn = document.getElementById('voting-back-btn');

const levelLabel = document.getElementById('level-label');
const roleEl = document.getElementById('role-panel');
const endRoundBtn = document.getElementById('end-round-btn');
const playAgainBtn = document.getElementById('play-again-btn');
const playAgainWaiting = document.getElementById('play-again-waiting');

const reportYesBtn = document.getElementById('report-yes-btn');
const reportNoBtn = document.getElementById('report-no-btn');
const reportChoices = document.getElementById('report-choices');
const reportWaiting = document.getElementById('report-waiting');
const reportCount = document.getElementById('report-count');
const reportError = document.getElementById('report-error');

const imposterResultsBody = document.getElementById('imposter-results-body');
const imposterResultsScoreboard = document.getElementById('imposter-results-scoreboard');
const imposterResultsBackBtn = document.getElementById('imposter-results-back-btn');

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
const cnScoreboard = document.getElementById('cn-scoreboard');
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
const tsScoreboard = document.getElementById('ts-scoreboard');
const tsPlayAgainBtn = document.getElementById('ts-play-again-btn');
const tsPlayAgainWaiting = document.getElementById('ts-play-again-waiting');
const tsBackBtn = document.getElementById('ts-back-btn');
const tsError = document.getElementById('ts-error');

const mfTitle = document.getElementById('mf-title');
const mfSubtitle = document.getElementById('mf-subtitle');
const mfScores = document.getElementById('mf-scores');
const mfReadyPanel = document.getElementById('mf-ready-panel');
const mfPlayerList = document.getElementById('mf-player-list');
const mfStartBtn = document.getElementById('mf-start-btn');
const mfStartWaiting = document.getElementById('mf-start-waiting');
const mfReadyError = document.getElementById('mf-ready-error');
const mfAllocPanel = document.getElementById('mf-alloc-panel');
const mfBoards = document.getElementById('mf-boards');
const mfHand = document.getElementById('mf-hand');
const mfAllocHint = document.getElementById('mf-alloc-hint');
const mfUnassignBtn = document.getElementById('mf-unassign-btn');
const mfLockedBadge = document.getElementById('mf-locked-badge');
const mfLockStatus = document.getElementById('mf-lock-status');
const mfLockBtn = document.getElementById('mf-lock-btn');
const mfLockWaiting = document.getElementById('mf-lock-waiting');
const mfAllocError = document.getElementById('mf-alloc-error');
const mfResultsPanel = document.getElementById('mf-results-panel');
const mfResultsBody = document.getElementById('mf-results-body');
const mfNextBtn = document.getElementById('mf-next-btn');
const mfNextWaiting = document.getElementById('mf-next-waiting');
const mfGameoverPanel = document.getElementById('mf-gameover-panel');
const mfChampion = document.getElementById('mf-champion');
const mfStandings = document.getElementById('mf-standings');
const mfFinalRound = document.getElementById('mf-final-round');
const mfScoreboard = document.getElementById('mf-scoreboard');
const mfPlayAgainBtn = document.getElementById('mf-play-again-btn');
const mfPlayAgainWaiting = document.getElementById('mf-play-again-waiting');
const mfBackBtn = document.getElementById('mf-back-btn');
const mfError = document.getElementById('mf-error');

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
let wordLanguage = 'english';
let wordTheme = '';
let cnTurnEndsAt = null;
let cnTimerTickHandle = null;
let tsRoundStartAt = null;
let tsTickHandle = null;
let tsHasStopped = false;
let tsIsContender = false;
let mfSelectedCard = null;
let mfAllocData = null;

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
  endRoundBtn.classList.toggle('hidden', !isHost);
  playAgainWaiting.classList.toggle('hidden', isHost);
  // Returning to the lobby is available to every player, not just the host.
  playAgainBtn.classList.remove('hidden');
  cnBackBtn.classList.remove('hidden');
  votingBackBtn.classList.remove('hidden');
  cnTeamBackBtn.classList.remove('hidden');
  tsBackBtn.classList.remove('hidden');
  mfBackBtn.classList.remove('hidden');
  krBackBtn.classList.remove('hidden');
  imposterResultsBackBtn.classList.remove('hidden');
  resetScoreboardBtn.classList.toggle('hidden', !isHost);
  wordLanguageSection.classList.toggle('hidden', !isHost);
  wordThemeSection.classList.toggle('hidden', !isHost);
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
    sfx.error();
    haptics.warn();
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
  sfx.join();
  haptics.success();
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
    } else if (res.phase === 'reporting') {
      renderImposterReporting(res);
      showScreen('imposterReporting');
    } else if (res.phase === 'roundResults') {
      renderImposterResults(res);
      showScreen('imposterResults');
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

  if (res.game === 'menifot') {
    applyMenifotState(res);
    showScreen('menifot');
    return;
  }

  if (res.game === 'kartrace') {
    KartRace.applyState(res);
    showScreen('kartRace');
    return;
  }

  applyWordLanguage(res.wordLanguage);
  applyWordTheme(res.wordTheme);
  renderLobby(res.players || [], res.scoreboard || []);
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

chooseMenifotBtn.addEventListener('click', () => {
  chooseError.textContent = '';
  socket.emit('chooseGame', 'menifot', (res) => {
    if (!res.ok) chooseError.textContent = res.error;
  });
});

chooseKartRaceBtn.addEventListener('click', () => {
  chooseError.textContent = '';
  socket.emit('chooseGame', 'kartrace', (res) => {
    if (!res.ok) chooseError.textContent = res.error;
  });
});

playAgainBtn.addEventListener('click', () => {
  socket.emit('backToLobby', () => {});
});

endRoundBtn.addEventListener('click', () => {
  socket.emit('endImposterRound', (res) => {
    if (res && !res.ok) {
      // Stay on game screen; host can retry.
    }
  });
});

reportYesBtn.addEventListener('click', () => {
  reportError.textContent = '';
  socket.emit('reportEliminated', true, (res) => {
    if (res && !res.ok) reportError.textContent = res.error;
  });
});

reportNoBtn.addEventListener('click', () => {
  reportError.textContent = '';
  socket.emit('reportEliminated', false, (res) => {
    if (res && !res.ok) reportError.textContent = res.error;
  });
});

imposterResultsBackBtn.addEventListener('click', () => {
  socket.emit('backToLobby', () => {});
});

resetScoreboardBtn.addEventListener('click', () => {
  if (!confirm('Reset the scoreboard to zero for everyone in this room?')) return;
  socket.emit('resetScoreboard', () => {});
});

exitLobbyBtn.addEventListener('click', () => {
  if (!confirm('Leave this room?')) return;
  socket.emit('leaveLobby', (res) => {
    if (!res || !res.ok) return;
    localStorage.removeItem('imposterRoom');
    myRoomCode = '';
    setRoomInUrl('');
    applyBackground(null);
    currentHostName = null;
    isHost = false;
    currentGame = null;
    showScreen('join');
  });
});

wordLanguageBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!isHost) return;
    socket.emit('setWordLanguage', btn.dataset.lang, () => {});
  });
});

wordThemeInput.addEventListener('change', () => {
  if (!isHost) return;
  socket.emit('setWordTheme', wordThemeInput.value, () => {});
});

wordThemeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') wordThemeInput.blur();
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

mfStartBtn.addEventListener('click', () => {
  mfReadyError.textContent = '';
  mfError.textContent = '';
  socket.emit('startMenifot', (res) => {
    if (res && !res.ok) mfReadyError.textContent = res.error;
  });
});

mfLockBtn.addEventListener('click', () => {
  mfAllocError.textContent = '';
  socket.emit('mfLock', (res) => {
    if (res && !res.ok) mfAllocError.textContent = res.error;
  });
});

mfUnassignBtn.addEventListener('click', () => {
  if (!mfSelectedCard || !mfAllocData || (mfAllocData.myHand && mfAllocData.myHand.locked)) return;
  mfAllocError.textContent = '';
  socket.emit('mfAssignCard', { card: mfSelectedCard, boardIndex: -1 }, (res) => {
    if (res && !res.ok) mfAllocError.textContent = res.error;
    else mfSelectedCard = null;
  });
});

mfNextBtn.addEventListener('click', () => {
  socket.emit('mfNextRound', (res) => {
    if (res && !res.ok) mfError.textContent = res.error;
  });
});

mfPlayAgainBtn.addEventListener('click', () => {
  socket.emit('playAgainMenifot', (res) => {
    if (res && !res.ok) mfError.textContent = res.error;
  });
});

mfBackBtn.addEventListener('click', () => {
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

socket.on('lobbyUpdate', ({ players, host, roomCode, scoreboard, wordLanguage: lang, wordTheme: theme }) => {
  setHost(host);
  if (roomCode) roomCodeDisplay.textContent = roomCode;
  applyWordLanguage(lang);
  applyWordTheme(theme);
  renderLobby(players, scoreboard);
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

socket.on('imposterReporting', (data) => {
  renderImposterReporting(data);
  showScreen('imposterReporting');
});

socket.on('imposterResults', (data) => {
  renderImposterResults(data);
  showScreen('imposterResults');
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

socket.on('menifotState', (data) => {
  applyMenifotState(data);
  showScreen('menifot');
});

socket.on('krState', (data) => {
  KartRace.applyState(data);
  showScreen('kartRace');
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
  KartRace.stop();
  tsRoundStartAt = null;
  tsHasStopped = false;
  tsIsContender = false;
  cnTeamError.textContent = '';
  chooseError.textContent = '';
  tsError.textContent = '';
  mfError.textContent = '';
  mfAllocError.textContent = '';
  mfSelectedCard = null;
  mfAllocData = null;
  reportError.textContent = '';
  showScreen('lobby');
});

const renderScoreboard = renderScoreboardFx;

function applyWordLanguage(lang) {
  wordLanguage = lang === 'hebrew' ? 'hebrew' : 'english';
  wordLanguageBtns.forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.lang === wordLanguage);
  });
}

function applyWordTheme(theme) {
  wordTheme = theme || '';
  if (document.activeElement !== wordThemeInput) {
    wordThemeInput.value = wordTheme;
  }
}

function renderLobby(players, scoreboard) {
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
  chooseKartRaceBtn.disabled = players.length < KR_MIN_PLAYERS;
  if (players.length < MIN_PLAYERS) {
    chooseError.textContent = `Need at least ${TS_MIN_PLAYERS} for 10 Seconds / Kart Race, ${MIN_PLAYERS} for Imposter, ${CN_MIN_PLAYERS} for Codenames`;
  } else if (players.length < CN_MIN_PLAYERS) {
    chooseError.textContent = `Need at least ${CN_MIN_PLAYERS} players for Codenames`;
  } else {
    chooseError.textContent = '';
  }

  const scoreMap = new Map((scoreboard || []).map((e) => [e.name, e.points]));
  const names = new Set(players);
  (scoreboard || []).forEach((e) => names.add(e.name));
  const entries = Array.from(names)
    .map((name) => ({ name, points: scoreMap.get(name) || 0 }))
    .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
  renderScoreboard(scoreboardList, entries);
  resetScoreboardBtn.classList.toggle('hidden', !isHost);
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

function renderImposterReporting(data) {
  setHost(data.host);
  reportError.textContent = '';
  reportCount.textContent = `${data.answered || 0} of ${data.total || 0} answered`;
  const answered = data.myAnswer !== null && data.myAnswer !== undefined;
  reportChoices.classList.toggle('hidden', answered);
  reportWaiting.classList.toggle('hidden', !answered);
}

function renderImposterResults(data) {
  setHost(data.host);
  imposterResultsBody.innerHTML = '';
  (data.results || []).forEach((row) => {
    const tr = document.createElement('tr');
    const ptsClass =
      row.points > 0 ? 'pts-positive' : row.points < 0 ? 'pts-negative' : '';
    const ptsText = row.points > 0 ? `+${row.points}` : String(row.points);
    tr.innerHTML = `<td>${row.name}</td><td>${row.role === 'imposter' ? 'Imposter' : 'Crew'}</td><td>${row.eliminated ? 'Eliminated' : 'Survived'}</td><td class="${ptsClass}">${ptsText}</td>`;
    imposterResultsBody.appendChild(tr);
  });
  renderScoreboard(imposterResultsScoreboard, data.scoreboard || []);
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
  applyWordTheme(data.wordTheme);
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
    renderScoreboard(cnScoreboard, data.scoreboard || []);
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
    renderScoreboard(tsScoreboard, data.scoreboard || []);
    tsPlayAgainBtn.classList.toggle('hidden', !isHost);
    tsPlayAgainWaiting.classList.toggle('hidden', isHost);
  }
}

const MF_SUIT_SYMBOL = { s: '♠', h: '♥', d: '♦', c: '♣' };
const MF_SUIT_CLASS = { s: 'mf-suit-s', h: 'mf-suit-h', d: 'mf-suit-d', c: 'mf-suit-c' };
const MF_RANK_ORDER = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  T: 10, J: 11, Q: 12, K: 13, A: 14,
};

function formatMfCard(code) {
  if (!code) return '?';
  const rank = code.slice(0, -1);
  const suit = code.slice(-1);
  const displayRank = rank === 'T' ? '10' : rank;
  return `${displayRank}${MF_SUIT_SYMBOL[suit] || suit}`;
}

function mfCardSuitClass(code) {
  const suit = code && code.slice(-1);
  return MF_SUIT_CLASS[suit] || '';
}

function mfCardRankValue(code) {
  const rank = code && code.slice(0, -1);
  return MF_RANK_ORDER[rank] || 0;
}

function mfSortCards(cards) {
  return (cards || []).slice().sort((a, b) => mfCardRankValue(a) - mfCardRankValue(b));
}

function mfCornerEl(rank, pip, position) {
  const corner = document.createElement('span');
  corner.className = `mf-card-corner mf-card-corner-${position}`;
  const rankEl = document.createElement('span');
  rankEl.className = 'mf-card-rank';
  rankEl.textContent = rank;
  const pipEl = document.createElement('span');
  pipEl.className = 'mf-card-pip';
  pipEl.textContent = pip;
  corner.appendChild(rankEl);
  corner.appendChild(pipEl);
  return corner;
}

function makeMfCardEl(code, { hidden = false, selected = false, interactive = false, outcome = null } = {}) {
  const el = document.createElement(interactive ? 'button' : 'span');
  if (interactive) {
    el.type = 'button';
    el.className = 'mf-card mf-card-btn';
  } else {
    el.className = 'mf-card';
  }
  if (hidden) {
    el.classList.add('hidden-card');
  } else {
    const rank = code ? (code.slice(0, -1) === 'T' ? '10' : code.slice(0, -1)) : '?';
    const suit = code ? code.slice(-1) : '';
    const pip = MF_SUIT_SYMBOL[suit] || suit;
    const suitClass = mfCardSuitClass(code);
    if (suitClass) el.classList.add(suitClass);
    el.appendChild(mfCornerEl(rank, pip, 'tl'));
    const center = document.createElement('span');
    center.className = 'mf-card-center';
    center.textContent = pip;
    el.appendChild(center);
    el.appendChild(mfCornerEl(rank, pip, 'br'));
    el.setAttribute('aria-label', formatMfCard(code));
  }
  if (selected) el.classList.add('selected');
  if (outcome === 'win') el.classList.add('mf-card-win');
  else if (outcome === 'lose') el.classList.add('mf-card-lose');
  return el;
}

function renderMfScoresLine(scores, players, { awarded = null } = {}) {
  const parts = (players || []).map((n) => {
    const total = scores && scores[n] != null ? scores[n] : 0;
    if (awarded && awarded[n]) return `${n} ${total} (+${awarded[n]})`;
    return `${n} ${total}`;
  });
  mfScores.textContent = parts.length ? parts.join(' · ') : '';
}

function boardIndexForCard(allocation, card, boardCount) {
  for (let i = 0; i < boardCount; i++) {
    if ((allocation[i] || allocation[String(i)] || []).includes(card)) return i;
  }
  return -1;
}

function mfBoardLimits(totalCards, boardCount) {
  const lo = Math.floor(totalCards / boardCount);
  const hi = Math.ceil(totalCards / boardCount);
  const hiSlots = totalCards % boardCount;
  return { lo, hi, hiSlots };
}

function mfCountsFeasible(counts, totalCards) {
  const boardCount = counts.length;
  if (boardCount < 1) return false;
  const { lo, hi, hiSlots } = mfBoardLimits(totalCards, boardCount);
  if (counts.some((c) => c < 0 || c > hi)) return false;
  const assigned = counts.reduce((a, b) => a + b, 0);
  if (assigned > totalCards) return false;
  const unassigned = totalCards - assigned;
  if (hi > lo) {
    const atHi = counts.filter((c) => c >= hi).length;
    if (atHi > hiSlots) return false;
  }
  const maxPlaceable = counts.reduce((s, c) => s + (hi - c), 0);
  if (unassigned > maxPlaceable) return false;
  let minNeeded = 0;
  for (const c of counts) {
    if (c < lo) minNeeded += lo - c;
  }
  if (minNeeded > unassigned) return false;
  return true;
}

function mfAllocationCountsClient(allocation, boardCount) {
  const counts = [];
  for (let i = 0; i < boardCount; i++) {
    counts.push((allocation[i] || allocation[String(i)] || []).length);
  }
  return counts;
}

/** Would assigning `card` onto `boardIndex` (-1 = unassign) stay within the ±1 rule? */
function mfCanAssignClient(myHand, boardCount, card, boardIndex) {
  if (!myHand || myHand.locked) return false;
  const nextCounts = Array.from({ length: boardCount }, () => 0);
  for (let i = 0; i < boardCount; i++) {
    for (const c of myHand.allocation[i] || myHand.allocation[String(i)] || []) {
      if (c !== card) nextCounts[i] += 1;
    }
  }
  if (boardIndex !== null && boardIndex !== undefined && boardIndex !== -1) {
    nextCounts[boardIndex] += 1;
  }
  return mfCountsFeasible(nextCounts, myHand.cards.length);
}

function mfSelectCard(card) {
  if (!mfAllocData || !mfAllocData.myHand || mfAllocData.myHand.locked) return;
  mfSelectedCard = mfSelectedCard === card ? null : card;
  mfAllocError.textContent = '';
  renderMfAllocating(mfAllocData);
}

function mfTryAssignToBoard(boardIndex) {
  if (!mfSelectedCard || !mfAllocData || !mfAllocData.myHand || mfAllocData.myHand.locked) return;
  if (!mfCanAssignClient(mfAllocData.myHand, mfAllocData.boardCount || 2, mfSelectedCard, boardIndex)) {
    return;
  }
  mfAllocError.textContent = '';
  const card = mfSelectedCard;
  socket.emit('mfAssignCard', { card, boardIndex }, (res) => {
    if (res && !res.ok) mfAllocError.textContent = res.error;
    else mfSelectedCard = null;
  });
}

function mfTryRevealCard(boardIndex, part) {
  if (!isHost) return;
  mfAllocError.textContent = '';
  socket.emit('mfRevealCard', { boardIndex, part }, (res) => {
    if (res && !res.ok) mfAllocError.textContent = res.error;
  });
}

function renderMfAllocating(data) {
  mfAllocData = data;
  const boardCount = data.boardCount || 2;
  const locked = !!(data.myHand && data.myHand.locked);
  const inMatch = !!data.inMatch;
  const myHand = data.myHand;
  const allocation = (myHand && myHand.allocation) || {};

  if (mfSelectedCard && myHand && !myHand.cards.includes(mfSelectedCard)) {
    mfSelectedCard = null;
  }
  if (locked) mfSelectedCard = null;

  const selectedAssigned =
    mfSelectedCard != null ? boardIndexForCard(allocation, mfSelectedCard, boardCount) : -1;

  const revealing = mfAllLocked(data);

  mfAllocHint.classList.toggle('hidden', !revealing && (locked || !inMatch));
  mfAllocHint.textContent = revealing
    ? isHost
      ? 'Tap the face-down cards to reveal turn & river, one board at a time.'
      : 'Waiting for the host to reveal the boards…'
    : mfSelectedCard
      ? selectedAssigned >= 0
        ? 'Tap a board to move it, or Unassign to return it to your hand.'
        : 'Tap a board to assign the selected card.'
      : 'Tap a card, then tap a board. Tap Unassign to pull it back.';

  mfBoards.innerHTML = '';
  for (let i = 0; i < boardCount; i++) {
    const board = (data.boards && data.boards[i]) || {
      flop: [],
      turn: null,
      river: null,
      turnRevealed: false,
      riverRevealed: false,
    };
    const wrap = document.createElement('div');
    wrap.className = 'mf-board';
    const canAccept =
      !locked &&
      inMatch &&
      mfSelectedCard &&
      mfCanAssignClient(myHand, boardCount, mfSelectedCard, i);
    if (mfSelectedCard && !locked && inMatch && !canAccept) {
      wrap.classList.add('mf-board-disabled');
    } else if (canAccept) {
      wrap.classList.add('mf-board-target');
    }

    const title = document.createElement('p');
    title.className = 'mf-board-title';
    const hole = allocation[i] || allocation[String(i)] || [];
    title.textContent = `Board ${i + 1}${hole.length ? ` · ${hole.length} of yours` : ''}`;
    wrap.appendChild(title);

    const community = document.createElement('div');
    community.className = 'mf-card-row';
    (board.flop || []).forEach((c) => community.appendChild(makeMfCardEl(c)));

    const canRevealTurn = revealing && isHost && !board.turnRevealed;
    const turnEl = makeMfCardEl(board.turn, {
      hidden: !board.turnRevealed,
      interactive: canRevealTurn,
    });
    if (canRevealTurn) {
      turnEl.addEventListener('click', (e) => {
        e.stopPropagation();
        mfTryRevealCard(i, 'turn');
      });
    }
    community.appendChild(turnEl);

    const canRevealRiver = revealing && isHost && board.turnRevealed && !board.riverRevealed;
    const riverEl = makeMfCardEl(board.river, {
      hidden: !board.riverRevealed,
      interactive: canRevealRiver,
    });
    if (canRevealRiver) {
      riverEl.addEventListener('click', (e) => {
        e.stopPropagation();
        mfTryRevealCard(i, 'river');
      });
    }
    community.appendChild(riverEl);
    wrap.appendChild(community);

    const holeLabel = document.createElement('p');
    holeLabel.className = 'mf-hole-label';
    holeLabel.textContent = locked ? 'Your cards (locked)' : 'Your cards';
    wrap.appendChild(holeLabel);

    const holeRow = document.createElement('div');
    holeRow.className = 'mf-card-row mf-hole-row';
    if (hole.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'muted mf-hole-empty';
      empty.textContent = '—';
      holeRow.appendChild(empty);
    } else {
      mfSortCards(hole).forEach((card) => {
        const el = makeMfCardEl(card, {
          selected: mfSelectedCard === card,
          interactive: inMatch && !locked,
        });
        if (inMatch && !locked) {
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            mfSelectCard(card);
          });
        }
        holeRow.appendChild(el);
      });
    }
    wrap.appendChild(holeRow);

    if (!locked && inMatch) {
      wrap.addEventListener('click', () => mfTryAssignToBoard(i));
    }
    mfBoards.appendChild(wrap);
  }

  mfHand.innerHTML = '';
  if (!inMatch) {
    mfHand.innerHTML = '<p class="muted">Spectating this match</p>';
  } else if (!myHand) {
    mfHand.innerHTML = '<p class="muted">No hand</p>';
  } else {
    const unassigned = myHand.cards.filter(
      (c) => boardIndexForCard(allocation, c, boardCount) < 0
    );
    if (unassigned.length === 0) {
      const done = document.createElement('p');
      done.className = 'muted';
      done.textContent = locked
        ? 'All cards assigned (locked).'
        : 'All cards assigned — tap Lock when ready.';
      mfHand.appendChild(done);
    } else {
      const row = document.createElement('div');
      row.className = 'mf-card-row mf-hand-tap';
      mfSortCards(unassigned).forEach((card) => {
        const el = makeMfCardEl(card, {
          selected: mfSelectedCard === card,
          interactive: !locked,
        });
        if (!locked) el.addEventListener('click', () => mfSelectCard(card));
        row.appendChild(el);
      });
      mfHand.appendChild(row);
    }
  }

  mfUnassignBtn.classList.toggle(
    'hidden',
    locked || !inMatch || !mfSelectedCard || selectedAssigned < 0
  );
  mfLockedBadge.classList.toggle('hidden', !(inMatch && locked));
  mfLockedBadge.textContent = revealing
    ? isHost
      ? 'Locked — tap the boards above to reveal'
      : 'Locked — waiting for host to reveal'
    : 'Locked — waiting for others';

  mfLockStatus.innerHTML = '';
  (data.lockStatus || []).forEach((row) => {
    const li = document.createElement('li');
    const bits = [row.name];
    if (row.locked) bits.push('locked');
    else if (!row.connected) bits.push('disconnected');
    else bits.push('allocating');
    li.textContent = bits.join(' — ');
    if (!row.connected) li.classList.add('ts-disconnected');
    if (row.name === myName && row.locked) li.classList.add('mf-me-locked');
    mfLockStatus.appendChild(li);
  });

  const allAssigned =
    myHand &&
    mfAllocationCountsClient(allocation, boardCount).reduce((a, b) => a + b, 0) ===
      myHand.cards.length;
  mfLockBtn.classList.toggle('hidden', !inMatch || locked);
  mfLockBtn.disabled = !allAssigned;
  mfLockWaiting.classList.toggle('hidden', !(inMatch && locked));
  mfLockWaiting.textContent = revealing
    ? isHost
      ? 'Tap the face-down cards above to reveal them.'
      : 'Waiting for the host to reveal the boards…'
    : 'Waiting for everyone to lock…';
}

function applyMenifotState(data) {
  setHost(data.host);
  currentGame = 'menifot';
  mfError.textContent = '';

  mfReadyPanel.classList.add('hidden');
  mfAllocPanel.classList.add('hidden');
  mfResultsPanel.classList.add('hidden');
  mfGameoverPanel.classList.add('hidden');
  mfNextBtn.classList.add('hidden');
  mfNextWaiting.classList.add('hidden');
  mfPlayAgainBtn.classList.add('hidden');
  mfPlayAgainWaiting.classList.add('hidden');

  if (data.phase !== 'allocating') {
    mfSelectedCard = null;
    mfAllocData = null;
  }

  const awarded =
    data.phase === 'roundResults' || data.phase === 'gameover'
      ? (data.roundResults && data.roundResults.pointsAwarded) || null
      : null;
  renderMfScoresLine(data.scores, data.players, { awarded });

  if (data.phase === 'ready') {
    mfTitle.textContent = 'Menifot';
    mfSubtitle.textContent =
      data.roundNumber > 0 ? `Ready for round ${data.roundNumber + 1}` : 'First to 10 board wins';
    mfReadyPanel.classList.remove('hidden');

    mfPlayerList.innerHTML = '';
    const list = data.players && data.players.length ? data.players : [];
    if (list.length) {
      list.forEach((n) => {
        const li = document.createElement('li');
        li.textContent = n;
        mfPlayerList.appendChild(li);
      });
    } else {
      const li = document.createElement('li');
      li.textContent = 'Host will freeze the table when Start is pressed';
      mfPlayerList.appendChild(li);
    }

    mfStartBtn.textContent = data.roundNumber > 0 ? 'Next Round' : 'Start';
    mfStartBtn.classList.toggle('hidden', !isHost);
    mfStartBtn.disabled = !data.canStart;
    mfStartWaiting.classList.toggle('hidden', isHost);
    mfReadyError.textContent = '';
    return;
  }

  if (data.phase === 'allocating') {
    mfTitle.textContent = `Round ${data.roundNumber}`;
    mfSubtitle.textContent = lockedSubtitle(data);
    mfAllocPanel.classList.remove('hidden');
    renderMfAllocating(data);
    return;
  }

  if (data.phase === 'roundResults') {
    mfTitle.textContent = `Round ${data.roundNumber} Results`;
    mfSubtitle.textContent = 'Match scores update above · host starts the next hand';
    mfResultsPanel.classList.remove('hidden');
    renderMfRoundResults(data);
    mfNextBtn.classList.toggle('hidden', !isHost);
    mfNextWaiting.classList.toggle('hidden', isHost);
    return;
  }

  if (data.phase === 'gameover') {
    mfTitle.textContent = 'Match Over';
    mfSubtitle.textContent = '';
    mfGameoverPanel.classList.remove('hidden');
    const winners = data.matchWinners || [];
    mfChampion.textContent =
      winners.length === 0
        ? 'No champion'
        : winners.length === 1
          ? `${winners[0]} wins Menifot!`
          : `Co-champions: ${winners.join(' & ')}!`;

    mfStandings.innerHTML = '';
    renderMfCompetitionStandings(mfStandings, data.standings || [], winners);

    mfFinalRound.innerHTML = '';
    if (data.roundResults) {
      const heading = document.createElement('h2');
      heading.className = 'scoreboard-heading';
      heading.textContent = 'Final round';
      mfFinalRound.appendChild(heading);
      appendMfRevealContent(mfFinalRound, data);
    }

    renderScoreboard(mfScoreboard, data.scoreboard || []);
    mfPlayAgainBtn.classList.toggle('hidden', !isHost);
    mfPlayAgainWaiting.classList.toggle('hidden', isHost);
  }
}

function mfAllLocked(data) {
  return !!(data.lockStatus && data.lockStatus.length > 0 && data.lockStatus.every((r) => r.locked));
}

function lockedSubtitle(data) {
  if (mfAllLocked(data)) {
    return isHost
      ? 'Everyone is locked — tap the boards below to reveal'
      : 'Everyone is locked — waiting for the host to reveal';
  }
  if (data.myHand && data.myHand.locked) {
    return 'Your hand is locked — waiting for the rest of the table';
  }
  if (!data.inMatch) return 'Spectating allocation';
  return 'Tap cards onto boards (±1 split), then Lock';
}

function renderMfCompetitionStandings(listEl, standings, winners) {
  listEl.innerHTML = '';
  let i = 0;
  while (i < standings.length) {
    let j = i + 1;
    while (j < standings.length && standings[j].score === standings[i].score) j += 1;
    const rank = i + 1;
    for (let k = i; k < j; k++) {
      const row = standings[k];
      const li = document.createElement('li');
      li.textContent = `#${rank} ${row.name} — ${row.score}`;
      if ((winners || []).includes(row.name)) li.classList.add('ts-champion-row');
      listEl.appendChild(li);
    }
    i = j;
  }
}

function appendMfRevealContent(container, data) {
  const results = data.roundResults;
  if (!results) return;

  const boardCount = data.boardCount || 2;
  const boardsWrap = document.createElement('div');
  boardsWrap.className = 'mf-boards';

  for (let i = 0; i < boardCount; i++) {
    const board = (data.boards && data.boards[i]) || { flop: [], turn: null, river: null };
    const boardResult = (results.boards || []).find((b) => b.boardIndex === i) || {};
    const wrap = document.createElement('div');
    wrap.className = 'mf-board mf-board-revealed';

    const title = document.createElement('p');
    title.className = 'mf-board-title';
    title.textContent = `Board ${i + 1}`;
    wrap.appendChild(title);

    const row = document.createElement('div');
    row.className = 'mf-card-row';
    (board.flop || []).forEach((c) => row.appendChild(makeMfCardEl(c)));
    if (board.turn) row.appendChild(makeMfCardEl(board.turn));
    if (board.river) row.appendChild(makeMfCardEl(board.river));
    wrap.appendChild(row);

    const winLine = document.createElement('p');
    winLine.className = 'mf-winner-line';
    const winners = boardResult.winners || [];
    if (winners.length === 0) winLine.textContent = 'No winner';
    else if (winners.length === 1) winLine.textContent = `Winner: ${winners[0]}`;
    else {
      winLine.textContent = `Split (+1 each): ${winners.join(', ')}`;
      winLine.classList.add('mf-split');
    }
    wrap.appendChild(winLine);

    const rankings = document.createElement('ul');
    rankings.className = 'mf-rankings';
    (boardResult.rankings || []).forEach((r) => {
      const li = document.createElement('li');
      const won = winners.includes(r.name);
      li.className = won ? 'mf-rank-win' : '';

      const label = document.createElement('span');
      label.className = 'mf-rank-label';
      label.textContent = `${r.name}: ${r.descr}`;
      li.appendChild(label);

      if (r.holeUsed && r.holeUsed.length) {
        const usedRow = document.createElement('div');
        usedRow.className = 'mf-card-row mf-rank-cards';
        r.holeUsed.forEach((c) => {
          usedRow.appendChild(makeMfCardEl(c, { outcome: won ? 'win' : 'lose' }));
        });
        li.appendChild(usedRow);
      }

      rankings.appendChild(li);
    });
    wrap.appendChild(rankings);

    // Show this player's full allocation on this board, with the 2 cards that made
    // their best hand highlighted green (won) or red (lost).
    if (results.allocations && data.inMatch !== false && myName) {
      const mine = results.allocations[myName];
      const hole = mine && (mine[i] || mine[String(i)]);
      if (hole && hole.length) {
        const holeLabel = document.createElement('p');
        holeLabel.className = 'mf-hole-label';
        holeLabel.textContent = 'Your cards on this board';
        wrap.appendChild(holeLabel);
        const myRanking = (boardResult.rankings || []).find((r) => r.name === myName);
        const myUsed = new Set((myRanking && myRanking.holeUsed) || []);
        const myWon = winners.includes(myName);
        const holeRow = document.createElement('div');
        holeRow.className = 'mf-card-row';
        hole.forEach((c) => {
          holeRow.appendChild(
            makeMfCardEl(c, { outcome: myUsed.has(c) ? (myWon ? 'win' : 'lose') : null })
          );
        });
        wrap.appendChild(holeRow);
      }
    }

    boardsWrap.appendChild(wrap);
  }
  container.appendChild(boardsWrap);

  const burnWrap = document.createElement('div');
  burnWrap.className = 'mf-burn-row';
  const burnTitle = document.createElement('p');
  burnTitle.className = 'mf-board-title';
  burnTitle.textContent = 'Burned';
  burnWrap.appendChild(burnTitle);
  const burnCards = document.createElement('div');
  burnCards.className = 'mf-card-row';
  const burned = results.burned || data.burned || [];
  if (burned.length === 0) {
    const none = document.createElement('span');
    none.className = 'muted';
    none.textContent = 'None this round';
    burnCards.appendChild(none);
  } else {
    burned.forEach((c) => burnCards.appendChild(makeMfCardEl(c)));
  }
  burnWrap.appendChild(burnCards);
  container.appendChild(burnWrap);

  const pts = document.createElement('p');
  pts.className = 'mf-round-points';
  const awarded = results.pointsAwarded || {};
  pts.textContent =
    'Points this round: ' +
    (data.players || []).map((n) => `${n} +${awarded[n] || 0}`).join(' · ');
  container.appendChild(pts);
}

function renderMfRoundResults(data) {
  mfResultsBody.innerHTML = '';
  appendMfRevealContent(mfResultsBody, data);
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
