/**
 * Client bootstrap: socket, lobby/join/create, screen routing, game module inits.
 */

import { Imposter } from './games/imposter.js';
import { Codenames } from './games/codenames.js';
import { TensSeconds } from './games/tenseconds.js';
import { Menifot } from './games/menifot.js';
import { MusicTimeline } from './games/musicTimeline.js';
import { AllInOrFold } from './games/allInOrFold.js';
import { MindMeld } from './games/mindMeld.js';
import { Bluff } from './games/bluff.js';
import { Warfront } from './games/warfront.js';
import { sfx, haptics, isMuted, toggleMuted } from './fx.js';
import { screens, showScreen, showGenerating, selectChip } from './shared/dom.js';
import { renderScoreboard } from './shared/scoreboard.js';
import { confirmDialog } from './shared/confirmDialog.js';
import { emojiForName } from './shared/playerEmoji.js';
import { initAccount, refreshCard, onLockedStickers, openPlayerCard } from './shared/account.js';
import { initReactions } from './shared/reactions.js';
import { initInstallButtons } from './shared/installApp.js';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
initInstallButtons([document.getElementById('install-app-btn'), document.getElementById('lobby-install-btn')]);

// clientId lets the server count unique daily visitors (server/stats.js) - see getClientId.
const socket = io({ auth: { clientId: getClientId() } });

// iOS Safari only applies :active (the pressed look) when a touchstart listener exists, so
// without this a tap shows no feedback until the click lands.
document.addEventListener('touchstart', () => {}, { passive: true });

// Surfaces socket connectivity instead of leaving actions (like the Join button)
// looking dead while a drop is being retried - see CLAUDE.md's note that reconnect
// logic is the most likely thing to silently regress. Debounced so a reconnect
// that lands within 800ms (the common case) never flashes the banner, and escalates
// wording after 8s so a real outage reads differently from a normal blip.
const connStatus = document.getElementById('conn-status');
let connDownSince = null;
let connStatusInterval = null;

function updateConnStatus() {
  const downMs = Date.now() - connDownSince;
  if (downMs < 800) {
    connStatus.classList.add('hidden');
    return;
  }
  const stale = downMs > 8000;
  connStatus.textContent = stale ? 'Still trying to reconnect…' : 'Reconnecting…';
  connStatus.classList.toggle('offline', stale);
  connStatus.classList.remove('hidden');
}

function connLost() {
  if (connDownSince) return;
  connDownSince = Date.now();
  updateConnStatus();
  connStatusInterval = setInterval(updateConnStatus, 500);
}

function connRestored() {
  connDownSince = null;
  clearInterval(connStatusInterval);
  connStatus.classList.add('hidden');
}

if (!socket.connected) connLost();
socket.on('disconnect', connLost);
socket.on('connect_error', connLost);
socket.on('connect', connRestored);

const MIN_PLAYERS = 3;
const CN_MIN_PLAYERS = 4;
const TS_MIN_PLAYERS = 2;
const AIOF_MIN_PLAYERS = 2;
const MM_MIN_PLAYERS = 3;
const BF_MIN_PLAYERS = 2;
const MF_MIN_PLAYERS = 2;
const WF_MIN_PLAYERS = 2;

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

// A non-host tapping a host-only lobby control (game tile, language, reset) - checked
// client-side for an instant response; the server enforces the same rule.
function flashHostOnly(msg) {
  sfx.error();
  haptics.warn();
  flashChooseError(msg);
}

const bgChangeBtn = document.getElementById('bg-change-btn');
const bgClearBtn = document.getElementById('bg-clear-btn');
const bgFileInput = document.getElementById('bg-file-input');
const bgError = document.getElementById('bg-error');
const muteBtn = document.getElementById('mute-btn');

const nameInput = document.getElementById('name-input');
const joinBtn = document.getElementById('join-btn');
const joinError = document.getElementById('join-error');
const joinStickerGrid = document.getElementById('join-sticker-grid');

const lobbyList = document.getElementById('lobby-list');
const lobbyCount = document.getElementById('lobby-count');
const renameBtn = document.getElementById('rename-btn');
const stickerBtn = document.getElementById('sticker-btn');
const stickerDropdown = document.getElementById('sticker-dropdown');
const lobbyStickerGrid = document.getElementById('lobby-sticker-grid');
const stickerFileInput = document.getElementById('sticker-file-input');
const stickerError = document.getElementById('sticker-error');
const scoreboardToggleBtn = document.getElementById('scoreboard-toggle-btn');
const scoreboardDropdown = document.getElementById('scoreboard-dropdown');
const scoreboardList = document.getElementById('scoreboard-list');
const resetScoreboardBtn = document.getElementById('reset-scoreboard-btn');
const chooseError = document.getElementById('choose-error');
const chooseImposterBtn = document.getElementById('choose-imposter-btn');
const chooseCodenamesBtn = document.getElementById('choose-codenames-btn');
const chooseTensSecondsBtn = document.getElementById('choose-tenseconds-btn');
const chooseMenifotBtn = document.getElementById('choose-menifot-btn');
const chooseWarfrontBtn = document.getElementById('choose-warfront-btn');
const chooseMindMeldBtn = document.getElementById('choose-mindmeld-btn');
const chooseBluffBtn = document.getElementById('choose-bluff-btn');
const chooseAllInOrFoldBtn = document.getElementById('choose-allinorfold-btn');
const chooseAllInOrFoldName = document.getElementById('choose-allinorfold-name');
const exitLobbyBtn = document.getElementById('exit-lobby-btn');
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
const mmBackBtn = document.getElementById('mm-back-btn');
const bfBackBtn = document.getElementById('bf-back-btn');

let myName = localStorage.getItem('imposterName') || '';
let myRoomCode = localStorage.getItem('imposterRoom') || '';
let mySticker = localStorage.getItem('imposterSticker') || null;

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

// Populated from GET /api/stickers (and kept fresh by 'stickersUpdated') so the picker
// never hardcodes filenames - dropping a new .webp into public/images/stickers/, or a
// player uploading one, is enough to add it here too.
let stickerFiles = [];
// sticker -> badge name, for stickers that are badge art this player hasn't earned yet
// (from the Player Card, see shared/account.js). Empty when accounts are off.
let lockedStickers = new Map();

function markSelectedSticker(container) {
  Array.from(container.children).forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.sticker === mySticker);
  });
}

function buildStickerGrid(container, onPick, onAdd, errorEl) {
  container.innerHTML = '';
  stickerFiles.forEach((file) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sticker-option';
    btn.dataset.sticker = file;
    const img = document.createElement('img');
    img.src = `images/stickers/${file}`;
    img.alt = '';
    btn.appendChild(img);
    if (lockedStickers.has(file)) {
      btn.classList.add('locked');
      const lock = document.createElement('span');
      lock.className = 'sticker-lock';
      lock.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
      btn.appendChild(lock);
      btn.addEventListener('click', () => {
        const badge = lockedStickers.get(file);
        errorEl.textContent = badge
          ? `🔒 Earn the "${badge}" badge to unlock this sticker`
          : '🔒 Earn its badge to unlock this sticker';
        errorEl.classList.remove('hidden');
      });
      container.appendChild(btn);
      return;
    }
    btn.addEventListener('click', () => {
      // Tapping the already-selected sticker clears it back to the emoji fallback.
      onPick(mySticker === file ? null : file);
    });
    container.appendChild(btn);
  });
  if (onAdd) {
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'sticker-option sticker-add';
    addBtn.title = 'Add a sticker to the bank';
    addBtn.setAttribute('aria-label', 'Add a sticker to the bank');
    addBtn.textContent = '+';
    addBtn.addEventListener('click', onAdd);
    container.appendChild(addBtn);
  }
  markSelectedSticker(container);
}

function selectJoinSticker(sticker) {
  mySticker = sticker;
  if (sticker) localStorage.setItem('imposterSticker', sticker);
  else localStorage.removeItem('imposterSticker');
  markSelectedSticker(joinStickerGrid);
}

function pickLobbySticker(sticker) {
  socket.emit('changeSticker', { sticker }, (res) => {
    if (!res) return;
    if (!res.ok) {
      stickerError.textContent = res.error || 'Could not change sticker';
      stickerError.classList.remove('hidden');
      return;
    }
    stickerError.classList.add('hidden');
    mySticker = res.sticker;
    if (res.sticker) localStorage.setItem('imposterSticker', res.sticker);
    else localStorage.removeItem('imposterSticker');
    markSelectedSticker(joinStickerGrid);
    markSelectedSticker(lobbyStickerGrid);
    stickerDropdown.classList.remove('open');
    stickerBtn.classList.remove('open');
  });
}

function renderStickerGrids() {
  buildStickerGrid(joinStickerGrid, selectJoinSticker, null, joinError);
  // Uploading needs to be a player in the room, so the "+" tile only lives in the lobby picker.
  buildStickerGrid(lobbyStickerGrid, pickLobbySticker, () => stickerFileInput.click(), stickerError);
}

onLockedStickers((locked) => {
  lockedStickers = locked;
  // A saved choice that's locked here (e.g. picked before badges existed) would just be
  // dropped by the server on join, so forget it locally too.
  if (mySticker && lockedStickers.has(mySticker)) {
    mySticker = null;
    localStorage.removeItem('imposterSticker');
  }
  renderStickerGrids();
});

function applyStickerFiles(files) {
  stickerFiles = files || [];
  renderStickerGrids();
}

fetch('/api/stickers')
  .then((r) => r.json())
  .then((data) => applyStickerFiles(data.stickers))
  .catch(() => {});

// Someone added a sticker - everyone's picker grows to include it.
socket.on('stickersUpdated', ({ stickers }) => applyStickerFiles(stickers));

stickerFileInput.addEventListener('change', async () => {
  const file = stickerFileInput.files[0];
  stickerFileInput.value = '';
  if (!file || !myName) return;

  stickerError.textContent = '';
  stickerError.classList.add('hidden');
  try {
    // WebP keeps transparency (cut-out stickers); browsers that can't encode it fall back to PNG.
    const blob = await resizeImage(file, 256, 0.85, 'image/webp');
    const res = await fetch(`/api/stickers?name=${encodeURIComponent(myName)}`, {
      method: 'POST',
      headers: { 'Content-Type': blob.type },
      body: blob,
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Upload failed');
    // The stickersUpdated broadcast may land after this response, so make sure it's in the grid.
    if (!stickerFiles.includes(data.sticker)) applyStickerFiles([...stickerFiles, data.sticker]);
    pickLobbySticker(data.sticker);
  } catch (err) {
    stickerError.textContent = err.message === 'The sticker bank is full'
      ? err.message
      : 'Could not add sticker - try a smaller or different image.';
    stickerError.classList.remove('hidden');
  }
});

function setHost(hostName) {
  currentHostName = hostName || null;
  isHost = !!hostName && hostName === myName;
  // Every player sees the host's lobby (game tiles, language, reset); non-hosts get an
  // "only the host" error when they tap a host-only control instead of not seeing it.
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
  mmBackBtn.classList.remove('hidden');
  bfBackBtn.classList.remove('hidden');
  wordThemeSection.classList.toggle('hidden', !isHost);
}

function applyBackground(url) {
  document.body.style.setProperty('--bg-image', url ? `url("${url}")` : '');
  bgClearBtn.classList.toggle('hidden', !url);
}

function resizeImage(file, maxDim, quality, type = 'image/jpeg') {
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
          type,
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
let knownLobbyNames = null;

function updateAiofTile() {
  const rejoin = currentGame === 'allinorfold';
  chooseAllInOrFoldName.textContent = rejoin ? 'Rejoin All-In or Fold' : 'All-In or Fold';
  chooseAllInOrFoldBtn.classList.toggle('tile-underfilled', !rejoin && lastLobbyPlayerCount < AIOF_MIN_PLAYERS);
}

// Tiny version of the player's rating card (tier colour, sticker, overall) shown at the
// end of their lobby row; tapping it opens the full card, same as the glowing avatar.
function buildMiniCard(name, rating, sticker) {
  const btn = document.createElement('button');
  btn.type = 'button';
  const strong = rating.tier === 'gold' && rating.ovr >= 85;
  btn.className = `mini-card mini-card-${rating.tier}${strong ? ' mini-card-gold-strong' : ''}`;
  btn.setAttribute('aria-label', `${name}'s card: ${rating.ovr} overall, ${rating.tier}`);
  const ovr = document.createElement('span');
  ovr.className = 'mini-card-ovr';
  ovr.textContent = rating.ovr;
  btn.appendChild(ovr);
  if (sticker) {
    const img = document.createElement('img');
    img.className = 'mini-card-photo';
    img.src = `images/stickers/${sticker}`;
    img.alt = '';
    btn.appendChild(img);
  } else {
    const initial = document.createElement('span');
    initial.className = 'mini-card-initial';
    initial.textContent = name.charAt(0).toUpperCase();
    btn.appendChild(initial);
  }
  btn.addEventListener('click', () => openPlayerCard(name));
  return btn;
}

// Host-only "remove from room" button appended to a lobby row. Pushes itself to the
// row's right edge with margin-left:auto only when there's no mini rating card already
// doing that job - otherwise it just trails the mini-card at the same right edge.
function buildKickButton(name, pushRight) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'lobby-kick-btn';
  if (pushRight) btn.style.marginLeft = 'auto';
  btn.title = `Remove ${name}`;
  btn.setAttribute('aria-label', `Remove ${name} from the room`);
  btn.textContent = '✕';
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const ok = await confirmDialog(`${name} will be removed from the room.`, {
      title: `Remove ${name}?`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    socket.emit('kickPlayer', name, (res) => {
      if (!res || !res.ok) alert((res && res.error) || 'Could not remove player');
    });
  });
  return btn;
}

function renderLobby(players, scoreboard, playerStickers, playerSignedIn, playerRatings) {
  // First render after a join/reconnect shouldn't animate anyone in — only
  // players who arrive while this client is already sitting in the lobby.
  const isFirstRender = knownLobbyNames === null;
  const newNames = isFirstRender ? new Set() : new Set(players.filter((n) => !knownLobbyNames.has(n)));
  knownLobbyNames = new Set(players);

  lobbyList.innerHTML = '';
  players.forEach((n) => {
    const li = document.createElement('li');
    if (newNames.has(n)) li.classList.add('lobby-join-in');
    const sticker = playerStickers && playerStickers[n];
    let avatar;
    if (sticker) {
      avatar = document.createElement('img');
      avatar.className = 'player-emoji-img';
      avatar.src = `images/stickers/${sticker}`;
      avatar.alt = '';
    } else {
      avatar = document.createElement('span');
      avatar.className = 'player-emoji';
      avatar.textContent = emojiForName(n);
    }
    if (playerSignedIn && playerSignedIn[n]) {
      avatar.classList.add('player-avatar-signedin');
      avatar.setAttribute('role', 'button');
      avatar.setAttribute('tabindex', '0');
      avatar.title = `View ${n}'s card`;
      avatar.addEventListener('click', () => openPlayerCard(n));
      avatar.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        openPlayerCard(n);
      });
    }
    const label = document.createElement('span');
    label.textContent = n === currentHostName ? `${n} (host)` : n;
    li.appendChild(avatar);
    li.appendChild(label);
    const rating = playerSignedIn && playerSignedIn[n] && playerRatings && playerRatings[n];
    if (rating) li.appendChild(buildMiniCard(n, rating, sticker));
    if (isHost && n !== myName) li.appendChild(buildKickButton(n, !rating));
    lobbyList.appendChild(li);
  });
  lobbyCount.textContent = `${players.length} joined`;
  chooseImposterBtn.classList.toggle('tile-underfilled', players.length < MIN_PLAYERS);
  chooseCodenamesBtn.classList.toggle('tile-underfilled', players.length < CN_MIN_PLAYERS);
  chooseTensSecondsBtn.classList.toggle('tile-underfilled', players.length < TS_MIN_PLAYERS);
  chooseMenifotBtn.classList.toggle('tile-underfilled', players.length < MF_MIN_PLAYERS);
  chooseMindMeldBtn.classList.toggle('tile-underfilled', players.length < MM_MIN_PLAYERS);
  chooseBluffBtn.classList.toggle('tile-underfilled', players.length < BF_MIN_PLAYERS);
  chooseWarfrontBtn.classList.toggle('tile-underfilled', players.length < WF_MIN_PLAYERS);
  lastLobbyPlayerCount = players.length;
  updateAiofTile();

  const scoreMap = new Map((scoreboard || []).map((e) => [e.name, e.points]));
  const names = new Set(players);
  (scoreboard || []).forEach((e) => names.add(e.name));
  const entries = Array.from(names)
    .map((name) => ({ name, points: scoreMap.get(name) || 0 }))
    .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
  renderScoreboard(scoreboardList, entries);
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
MindMeld.init(gameCtx);
Bluff.init(gameCtx);
Warfront.init(gameCtx);

const GAMES = {
  imposter: Imposter,
  codenames: Codenames,
  tenseconds: TensSeconds,
  menifot: Menifot,
  musictimeline: MusicTimeline,
  allinorfold: AllInOrFold,
  mindmeld: MindMeld,
  bluff: Bluff,
  warfront: Warfront,
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
  socket.emit('join', { name, clientId: getClientId(), sticker: mySticker }, (res) => handleJoinResult(res, name));
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
  renderLobby(res.players || [], res.scoreboard || [], res.playerStickers || {}, res.playerSignedIn || {}, res.playerRatings || {});
  showScreen('lobby');
}

function readName() {
  return nameInput.value.trim();
}

function refreshMuteBtn() {
  const muted = isMuted();
  muteBtn.classList.toggle('muted', muted);
  muteBtn.title = muted ? 'Unmute sound' : 'Mute sound';
}

muteBtn.addEventListener('click', () => {
  toggleMuted();
  refreshMuteBtn();
});
refreshMuteBtn();

// Light tap feedback on every button press. Fires on pointerdown (finger touching the
// glass) rather than click, which on touchscreens only fires after the finger lifts.
let lastPointerTap = 0;
function tapFeedback(e) {
  const btn = e.target.closest && e.target.closest('button');
  if (!btn || btn.disabled) return;
  sfx.click();
  haptics.tap();
}
document.addEventListener(
  'pointerdown',
  (e) => {
    // Only the primary finger / left mouse button, so a second finger or right-click doesn't re-fire.
    if (!e.isPrimary || e.button !== 0) return;
    lastPointerTap = Date.now();
    tapFeedback(e);
  },
  { passive: true }
);
// Keyboard-activated buttons (Enter/Space) never get a pointerdown. Some mobile browsers
// also report detail 0 on the click that follows a tap, so ignore clicks right after one.
document.addEventListener('click', (e) => {
  if (e.detail !== 0 || Date.now() - lastPointerTap < 1000) return;
  tapFeedback(e);
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

stickerBtn.addEventListener('click', () => {
  const open = stickerDropdown.classList.toggle('open');
  stickerBtn.classList.toggle('open', open);
});

initAccount(getClientId, socket);
initReactions(socket);

function chooseGame(game) {
  flashChooseError('');
  if (!isHost) {
    flashHostOnly('Only the host can pick a game');
    return;
  }
  socket.emit('chooseGame', game, (res) => {
    if (!res.ok) flashChooseError(res.error);
  });
}

chooseImposterBtn.addEventListener('click', () => chooseGame('imposter'));
chooseCodenamesBtn.addEventListener('click', () => chooseGame('codenames'));
chooseTensSecondsBtn.addEventListener('click', () => chooseGame('tenseconds'));
chooseMenifotBtn.addEventListener('click', () => chooseGame('menifot'));
chooseWarfrontBtn.addEventListener('click', () => chooseGame('warfront'));
chooseMindMeldBtn.addEventListener('click', () => chooseGame('mindmeld'));
chooseBluffBtn.addEventListener('click', () => chooseGame('bluff'));

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
  if (!isHost) {
    flashHostOnly('Only the host can pick a game');
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

resetScoreboardBtn.addEventListener('click', async () => {
  if (!isHost) {
    flashHostOnly('Only the host can reset the scoreboard');
    return;
  }
  const ok = await confirmDialog('Everyone in this room goes back to zero.', {
    title: 'Reset the scoreboard?',
    confirmLabel: 'Reset',
    danger: true,
  });
  if (!ok) return;
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

exitLobbyBtn.addEventListener('click', async () => {
  const ok = await confirmDialog('Leave this room?', { confirmLabel: 'Leave', danger: true });
  if (!ok) return;
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
    knownLobbyNames = null;
    showScreen('join');
  });
});

wordLanguageBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!isHost) {
      flashHostOnly('Only the host can change the language');
      return;
    }
    selectChip(wordLanguageBtns, btn);
    socket.emit('setWordLanguage', btn.dataset.lang, (res) => {
      if (res && res.ok === false) applyWordLanguage(wordLanguage);
    });
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

socket.on('lobbyUpdate', ({ players, host, scoreboard, wordLanguage: lang, wordTheme: theme, playerStickers, playerSignedIn, playerRatings }) => {
  setHost(host);
  applyWordLanguage(lang);
  applyWordTheme(theme);
  renderLobby(players, scoreboard, playerStickers, playerSignedIn, playerRatings);
});

const adminNotice = document.getElementById('admin-notice');
let adminNoticeTimer = null;
adminNotice.addEventListener('click', () => adminNotice.classList.add('hidden'));

// Tapping the banner (its × included) closes it. `sticky` notices stay until then.
function showNotice(text, { sticky = false } = {}) {
  clearTimeout(adminNoticeTimer);
  document.getElementById('admin-notice-text').textContent = text;
  adminNotice.classList.remove('hidden');
  if (!sticky) adminNoticeTimer = setTimeout(() => adminNotice.classList.add('hidden'), 10000);
}

socket.on('adminAnnouncement', ({ message }) => {
  showNotice(`📣 ${message}`);
  haptics.warn();
});

// Set just before the 'serverBuild' listener below reloads onto a new deploy's code.
try {
  if (sessionStorage.getItem('showUpdateNotice')) {
    sessionStorage.removeItem('showUpdateNotice');
    showNotice('✨ Update for the latest version', { sticky: true });
  }
} catch (e) {}

// Removed (or banned) from the admin page. The server drops this socket right after, and
// socket.io doesn't auto-reconnect a server-side disconnect, so this stays on the join
// form until the player rejoins by hand - which a ban then refuses.
socket.on('kicked', ({ reason }) => {
  Object.values(GAMES).forEach((game) => {
    if (game && typeof game.stop === 'function') game.stop();
  });
  localStorage.removeItem('imposterRoom');
  myRoomCode = '';
  // Cleared in memory only (the name stays prefilled), so the reconnect below doesn't
  // auto-rejoin via the 'connect' handler.
  myName = '';
  currentHostName = null;
  isHost = false;
  currentGame = null;
  applyBackground(null);
  joinError.textContent = reason || 'You were removed from the room';
  showScreen('join');
  // Reconnect the socket (but don't rejoin) so the join button works again.
  socket.once('disconnect', () => setTimeout(() => socket.connect(), 500));
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
  refreshCard();
});

if (myName) nameInput.value = myName;

// Re-sync on every connect, not just the first one - phones suspend the socket when the
// screen locks or the tab backgrounds, and on reconnect we need to catch back up to the
// current phase/screen rather than being stuck on whatever was last rendered.
socket.on('connect', () => {
  if (myName) attemptJoin(myName);
});

// index.html swaps in the loading screen for a returning player before first paint. If the
// rejoin hasn't landed after a while (server down, slow network), fall back to the join form
// with the name prefilled rather than spinning forever; a late rejoin still routes normally.
if (myName) {
  setTimeout(() => {
    if (screens.restoring && !screens.restoring.classList.contains('hidden')) showScreen('join');
  }, 8000);
}

// A phone that kept the tab open across a deploy reconnects its socket to the new server
// while still running the old JS - which silently ignores any new game's events (e.g. a
// newly added game's state broadcasts), leaving that player stuck. Reload onto the new
// code instead; the saved session rejoins automatically after the reload. The page's own
// build (stamped into index.html by server.js) also catches a page that loaded stale code.
const pageBuildMeta = document.querySelector('meta[name="server-build"]');
let loadedServerBuild =
  pageBuildMeta && pageBuildMeta.content !== '__SERVER_BUILD__' ? pageBuildMeta.content : null;
socket.on('serverBuild', (build) => {
  if (loadedServerBuild && build !== loadedServerBuild) {
    // Reload at most once per build, so a cache that keeps serving old files can't loop.
    let alreadyTried = false;
    try {
      alreadyTried = sessionStorage.getItem('reloadedForBuild') === build;
      sessionStorage.setItem('reloadedForBuild', build);
    } catch (e) {}
    if (!alreadyTried) {
      try {
        sessionStorage.setItem('showUpdateNotice', '1');
      } catch (e) {}
      window.location.reload();
      return;
    }
  }
  loadedServerBuild = build;
});
