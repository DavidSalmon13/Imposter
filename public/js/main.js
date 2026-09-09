/**
 * Client bootstrap: socket, lobby/join/create, screen routing, game module inits.
 */

import { Imposter } from './games/imposter.js';
import { Codenames } from './games/codenames.js';
import { TensSeconds } from './games/tenseconds.js';
import { Menifot } from './games/menifot.js';
import { MusicTimeline } from './games/musicTimeline.js';
import { AllInOrFold } from './games/allInOrFold.js';
import { sfx, haptics, isMuted, toggleMuted } from './fx.js';
import { showScreen, showGenerating } from './shared/dom.js';
import { renderScoreboard } from './shared/scoreboard.js';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

const socket = io();

const MIN_PLAYERS = 3;
const CN_MIN_PLAYERS = 4;
const TS_MIN_PLAYERS = 2;
const MT_MIN_PLAYERS = 2;
const AIOF_MIN_PLAYERS = 2;

// Deterministic per-name emoji so the lobby list feels alive without any server-side state.
const PLAYER_EMOJIS = ['🦊', '🐼', '🐸', '🐵', '🐯', '🐨', '🐷', '🐙', '🦁', '🐮', '🐰', '🐻', '🐔', '🦄', '🐢', '🦉', '🐝', '🐳', '🦋', '🐺'];
function emojiForName(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return PLAYER_EMOJIS[hash % PLAYER_EMOJIS.length];
}

// Choose-game errors (e.g. "Need at least N players") should flash briefly, not sit
// on screen permanently — see lobby fix 2.
let chooseErrorTimer = null;
function flashChooseError(msg) {
  clearTimeout(chooseErrorTimer);
  chooseError.textContent = msg || '';
  if (msg) {
    chooseErrorTimer = setTimeout(() => {
      chooseError.textContent = '';
    }, 3000);
  }
}

const bgChangeBtn = document.getElementById('bg-change-btn');
const bgClearBtn = document.getElementById('bg-clear-btn');
const bgFileInput = document.getElementById('bg-file-input');
const bgError = document.getElementById('bg-error');
const muteBtn = document.getElementById('mute-btn');

const nameInput = document.getElementById('name-input');
const joinBtn = document.getElementById('join-btn');
const joinError = document.getElementById('join-error');

const lobbyList = document.getElementById('lobby-list');
const lobbyCount = document.getElementById('lobby-count');
const renameBtn = document.getElementById('rename-btn');
const scoreboardToggleBtn = document.getElementById('scoreboard-toggle-btn');
const scoreboardDropdown = document.getElementById('scoreboard-dropdown');
const scoreboardList = document.getElementById('scoreboard-list');
const resetScoreboardBtn = document.getElementById('reset-scoreboard-btn');
const gameChoice = document.getElementById('game-choice');
const chooseWaiting = document.getElementById('choose-waiting');
const chooseError = document.getElementById('choose-error');
const chooseImposterBtn = document.getElementById('choose-imposter-btn');
const chooseCodenamesBtn = document.getElementById('choose-codenames-btn');
const chooseTensSecondsBtn = document.getElementById('choose-tenseconds-btn');
const chooseMenifotBtn = document.getElementById('choose-menifot-btn');
const chooseMusicTimelineBtn = document.getElementById('choose-musictimeline-btn');
const chooseAllInOrFoldBtn = document.getElementById('choose-allinorfold-btn');
const chooseAllInOrFoldName = document.getElementById('choose-allinorfold-name');
const aiofTileWrap = document.getElementById('aiof-tile-wrap');
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
const mtBackBtn = document.getElementById('mt-back-btn');
const imposterResultsBackBtn = document.getElementById('imposter-results-back-btn');
const aiofBackBtn = document.getElementById('aiof-back-btn');

let myName = localStorage.getItem('imposterName') || '';
let myRoomCode = localStorage.getItem('imposterRoom') || '';

// Persistent per-browser id so the server can tell "this device reconnecting"
// apart from "a different device using the same name" when a dropped socket
// hasn't been noticed as dead yet.
function getClientId() {
  let id = localStorage.getItem('imposterClientId');
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem('imposterClientId', id);
  }
  return id;
}
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

function rememberSession(name, roomCode) {
  myName = name;
  myRoomCode = roomCode;
  localStorage.setItem('imposterName', name);
  localStorage.setItem('imposterRoom', roomCode);
}

function setHost(hostName) {
  currentHostName = hostName || null;
  isHost = !!hostName && hostName === myName;
  gameChoice.classList.toggle('hidden', !isHost);
  updateAiofTile();
  endRoundBtn.classList.toggle('hidden', !isHost);
  playAgainWaiting.classList.toggle('hidden', isHost);
  // Returning to the lobby is available to every player, not just the host.
  playAgainBtn.classList.remove('hidden');
  cnBackBtn.classList.remove('hidden');
  votingBackBtn.classList.remove('hidden');
  cnTeamBackBtn.classList.remove('hidden');
  tsBackBtn.classList.remove('hidden');
  mfBackBtn.classList.remove('hidden');
  mtBackBtn.classList.remove('hidden');
  imposterResultsBackBtn.classList.remove('hidden');
  aiofBackBtn.classList.remove('hidden');
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

let lastLobbyPlayerCount = 0;

function updateAiofTile() {
  const rejoin = currentGame === 'allinorfold';
  chooseAllInOrFoldName.textContent = rejoin ? 'Rejoin All-In or Fold' : 'All-In or Fold';
  chooseAllInOrFoldBtn.classList.toggle('tile-underfilled', !rejoin && lastLobbyPlayerCount < AIOF_MIN_PLAYERS);
  // Every other game's tile is host-only and disappears once picked (the whole room
  // navigates away together). AIOF is the one game where non-host players can stay behind
  // on the shared lobby screen (see implementation/all-in-or-fold-plan.md's architecture
  // note), so its tile must stay visible/actionable to them too once the host has started
  // the table — otherwise they're stuck seeing "waiting for the host" forever.
  aiofTileWrap.classList.toggle('hidden', !(isHost || rejoin));
  chooseWaiting.classList.toggle('hidden', isHost || rejoin);
}

function renderLobby(players, scoreboard) {
  lobbyList.innerHTML = '';
  players.forEach((n) => {
    const li = document.createElement('li');
    const emoji = document.createElement('span');
    emoji.className = 'player-emoji';
    emoji.textContent = emojiForName(n);
    const label = document.createElement('span');
    label.textContent = n === currentHostName ? `${n} (host)` : n;
    li.appendChild(emoji);
    li.appendChild(label);
    lobbyList.appendChild(li);
  });
  lobbyCount.textContent = `${players.length} joined`;
  chooseImposterBtn.classList.toggle('tile-underfilled', players.length < MIN_PLAYERS);
  chooseCodenamesBtn.classList.toggle('tile-underfilled', players.length < CN_MIN_PLAYERS);
  chooseTensSecondsBtn.classList.toggle('tile-underfilled', players.length < TS_MIN_PLAYERS);
  chooseMusicTimelineBtn.classList.toggle('tile-underfilled', players.length < MT_MIN_PLAYERS);
  lastLobbyPlayerCount = players.length;
  updateAiofTile();

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

Imposter.init(gameCtx);
Codenames.init(gameCtx);
TensSeconds.init(gameCtx);
Menifot.init(gameCtx);
MusicTimeline.init(gameCtx);
AllInOrFold.init(gameCtx);

const GAMES = {
  imposter: Imposter,
  codenames: Codenames,
  tenseconds: TensSeconds,
  menifot: Menifot,
  musictimeline: MusicTimeline,
  allinorfold: AllInOrFold,
};

function handleJoinResult(res, name) {
  if (!res.ok) {
    sfx.error();
    haptics.warn();
    joinError.textContent = res.error;
    showScreen('join');
    return;
  }
  sfx.join();
  haptics.success();
  rememberSession(name, res.roomCode);
  applyBackground(res.background || null);
  routeFromJoin(res);
}

function attemptJoin(name) {
  socket.emit('join', { name, clientId: getClientId() }, (res) => handleJoinResult(res, name));
}

function routeFromJoin(res) {
  currentGame = res.game || null;
  setHost(res.host);

  if (res.game === 'codenames' && res.phase === 'generating') {
    showGenerating('codenames');
    return;
  }

  // AIOF's reconnectPayload deliberately reports `game: 'allinorfold'` (so the dual-entry
  // tile shows "Rejoin") but still wants the shared lobby screen, not the table — see its
  // architecture note in implementation/all-in-or-fold-plan.md.
  const game = GAMES[res.game];
  if (game && game.applyJoin && !res.atLobby) {
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

// Light tap feedback on every button press.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn || btn.disabled) return;
  sfx.click();
  haptics.tap();
});

joinBtn.addEventListener('click', () => {
  const name = readName();
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

scoreboardToggleBtn.addEventListener('click', () => {
  const open = scoreboardDropdown.classList.toggle('open');
  scoreboardToggleBtn.classList.toggle('open', open);
});

chooseImposterBtn.addEventListener('click', () => {
  flashChooseError('');
  socket.emit('chooseGame', 'imposter', (res) => {
    if (!res.ok) flashChooseError(res.error);
  });
});

chooseCodenamesBtn.addEventListener('click', () => {
  flashChooseError('');
  socket.emit('chooseGame', 'codenames', (res) => {
    if (!res.ok) flashChooseError(res.error);
  });
});

chooseTensSecondsBtn.addEventListener('click', () => {
  flashChooseError('');
  socket.emit('chooseGame', 'tenseconds', (res) => {
    if (!res.ok) flashChooseError(res.error);
  });
});

chooseMenifotBtn.addEventListener('click', () => {
  flashChooseError('');
  socket.emit('chooseGame', 'menifot', (res) => {
    if (!res.ok) flashChooseError(res.error);
  });
});

chooseMusicTimelineBtn.addEventListener('click', () => {
  flashChooseError('');
  socket.emit('chooseGame', 'musictimeline', (res) => {
    if (!res.ok) flashChooseError(res.error);
  });
});

chooseAllInOrFoldBtn.addEventListener('click', () => {
  flashChooseError('');
  if (currentGame === 'allinorfold') {
    socket.emit('enterAllInOrFold', (res) => {
      if (!res || !res.ok) {
        flashChooseError((res && res.error) || 'Could not enter');
        return;
      }
      AllInOrFold.applyJoin(res);
    });
    return;
  }
  socket.emit('chooseGame', 'allinorfold', (res) => {
    if (!res.ok) {
      flashChooseError(res.error);
      return;
    }
    AllInOrFold.setAtTable(true);
  });
});

resetScoreboardBtn.addEventListener('click', () => {
  if (!confirm('Reset the scoreboard to zero for everyone in this room?')) return;
  socket.emit('resetScoreboard', () => {});
});

renameBtn.addEventListener('click', () => {
  const newName = ((prompt('New name:', myName) || '').trim()).slice(0, 20);
  if (!newName || newName === myName) return;
  socket.emit('renameSelf', { name: newName }, (res) => {
    if (!res || !res.ok) {
      alert((res && res.error) || 'Could not change name');
      return;
    }
    myName = res.name;
    localStorage.setItem('imposterName', myName);
    nameInput.value = myName;
    // The room-wide lobbyUpdate broadcast this triggers may land before this ack
    // (it carries our old name in isHost's `=== myName` check at the time it's
    // handled), so recompute host status here now that myName is current.
    setHost(res.host);
  });
});

exitLobbyBtn.addEventListener('click', () => {
  if (!confirm('Leave this room?')) return;
  socket.emit('leaveLobby', (res) => {
    if (!res || !res.ok) {
      alert((res && res.error) || 'Could not leave');
      return;
    }
    localStorage.removeItem('imposterRoom');
    myRoomCode = '';
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

socket.on('lobbyUpdate', ({ players, host, scoreboard, wordLanguage: lang, wordTheme: theme }) => {
  setHost(host);
  applyWordLanguage(lang);
  applyWordTheme(theme);
  renderLobby(players, scoreboard);
});

socket.on('hostUpdate', ({ host }) => {
  setHost(host);
});

socket.on('gameChosen', ({ game }) => {
  currentGame = game;
  updateAiofTile();
});

socket.on('generating', ({ game }) => {
  showGenerating(game || currentGame);
});

socket.on('backToLobby', () => {
  currentGame = null;
  chooseError.textContent = '';
  Object.values(GAMES).forEach((game) => {
    if (game && typeof game.stop === 'function') game.stop();
  });
  showScreen('lobby');
});

if (myName) nameInput.value = myName;

// Re-sync on every connect, not just the first one - phones suspend the socket when the
// screen locks or the tab backgrounds, and on reconnect we need to catch back up to the
// current phase/screen rather than being stuck on whatever was last rendered.
socket.on('connect', () => {
  if (myName) attemptJoin(myName);
});
