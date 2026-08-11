/**
 * Client bootstrap: socket, lobby/join/create, screen routing, game module inits.
 */

import { KartRace } from './games/kartRace.js';
import { Imposter } from './games/imposter.js';
import { Codenames } from './games/codenames.js';
import { TensSeconds } from './games/tenseconds.js';
import { Menifot } from './games/menifot.js';
import { MusicTimeline } from './games/musicTimeline.js';
import { sfx, haptics, isMuted, toggleMuted } from './fx.js';
import { showScreen, showGenerating } from './shared/dom.js';
import { renderScoreboard } from './shared/scoreboard.js';

const socket = io();

const MIN_PLAYERS = 3;
const CN_MIN_PLAYERS = 4;
const TS_MIN_PLAYERS = 2;
const KR_MIN_PLAYERS = 2;
const MT_MIN_PLAYERS = 2;

const bgChangeBtn = document.getElementById('bg-change-btn');
const bgClearBtn = document.getElementById('bg-clear-btn');
const bgFileInput = document.getElementById('bg-file-input');
const bgError = document.getElementById('bg-error');
const muteBtn = document.getElementById('mute-btn');

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
const chooseMusicTimelineBtn = document.getElementById('choose-musictimeline-btn');
const exitLobbyBtn = document.getElementById('exit-lobby-btn');
const wordLanguageSection = document.getElementById('word-language-section');
const wordLanguageBtns = Array.from(document.querySelectorAll('.word-lang-btn'));
const wordThemeSection = document.getElementById('word-theme-section');
const wordThemeInput = document.getElementById('word-theme-input');

// Fat setHost still toggles per-game chrome (deferred thin-down).
const endRoundBtn = document.getElementById('end-round-btn');
const playAgainBtn = document.getElementById('play-again-btn');
const playAgainWaiting = document.getElementById('play-again-waiting');
const votingBackBtn = document.getElementById('voting-back-btn');
const cnBackBtn = document.getElementById('cn-back-btn');
const cnTeamBackBtn = document.getElementById('cn-team-back-btn');
const tsBackBtn = document.getElementById('ts-back-btn');
const mfBackBtn = document.getElementById('mf-back-btn');
const krBackBtn = document.getElementById('kr-back-btn');
const mtBackBtn = document.getElementById('mt-back-btn');
const imposterResultsBackBtn = document.getElementById('imposter-results-back-btn');

let myName = localStorage.getItem('imposterName') || '';
let myRoomCode = localStorage.getItem('imposterRoom') || '';
let isHost = false;
let currentHostName = null;
let currentGame = null;
let wordLanguage = 'english';
let wordTheme = '';

function getMyName() {
  return myName;
}

function getIsHost() {
  return isHost;
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
  mtBackBtn.classList.remove('hidden');
  imposterResultsBackBtn.classList.remove('hidden');
  resetScoreboardBtn.classList.toggle('hidden', !isHost);
  wordLanguageSection.classList.toggle('hidden', !isHost);
  wordThemeSection.classList.toggle('hidden', !isHost);
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
  chooseMusicTimelineBtn.disabled = players.length < MT_MIN_PLAYERS;
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

const gameCtx = {
  socket,
  showScreen,
  showGenerating,
  setHost,
  getMyName,
  getIsHost,
  applyWordTheme,
};

KartRace.init(socket);
Imposter.init(gameCtx);
Codenames.init(gameCtx);
TensSeconds.init(gameCtx);
Menifot.init(gameCtx);
MusicTimeline.init(gameCtx);

const GAMES = {
  imposter: Imposter,
  codenames: Codenames,
  tenseconds: TensSeconds,
  menifot: Menifot,
  musictimeline: MusicTimeline,
  kartrace: {
    applyJoin(res) {
      KartRace.applyState(res);
      showScreen('kartRace');
    },
    stop() {
      KartRace.stop();
    },
  },
};

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

  if (res.game === 'codenames' && res.phase === 'generating') {
    showGenerating('codenames');
    return;
  }

  const game = GAMES[res.game];
  if (game && game.applyJoin) {
    game.applyJoin(res);
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

chooseMusicTimelineBtn.addEventListener('click', () => {
  chooseError.textContent = '';
  socket.emit('chooseGame', 'musictimeline', (res) => {
    if (!res.ok) chooseError.textContent = res.error;
  });
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

socket.on('generating', ({ game }) => {
  showGenerating(game || currentGame);
});

socket.on('krState', (data) => {
  KartRace.applyState(data);
  showScreen('kartRace');
});

socket.on('backToLobby', () => {
  currentGame = null;
  chooseError.textContent = '';
  Object.values(GAMES).forEach((game) => {
    if (game && typeof game.stop === 'function') game.stop();
  });
  showScreen('lobby');
});

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
