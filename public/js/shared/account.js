/**
 * Player Card + Google sign-in (lobby 👤 dropdown). Server side: server/accounts.js.
 *
 * Guests see the stats recorded for this browser and a "Sign in with Google" button;
 * signing in attaches those stats to the account. The whole feature stays hidden when
 * the server has no database or no GOOGLE_CLIENT_ID (GET /api/auth/config).
 */

import { confirmDialog } from './confirmDialog.js';
import { sfx, haptics } from '../fx.js';

const GAME_LABELS = {
  imposter: '🕵️ Imposter',
  codenames: '🔴🔵 Codenames',
  tenseconds: '⏱️ 10 Seconds',
  menifot: '🃏 Menifot',
  musictimeline: '🎵 Music Timeline',
  allinorfold: '🎰 All-In or Fold',
  mindmeld: '🧠 Mind Meld',
  bluff: '🂠 Bluff',
};

const cardBtn = document.getElementById('card-btn');
const cardDropdown = document.getElementById('card-dropdown');
const cardProfile = document.getElementById('card-profile');
const cardAvatar = document.getElementById('card-avatar');
const cardName = document.getElementById('card-name');
const cardSummary = document.getElementById('card-summary');
const cardGames = document.getElementById('card-games');
const cardGuest = document.getElementById('card-guest');
const googleBtnEl = document.getElementById('google-signin-btn');
const signOutBtn = document.getElementById('card-signout-btn');
const deleteBtn = document.getElementById('card-delete-btn');
const cardError = document.getElementById('card-error');
const rivalsHeading = document.getElementById('card-rivals-heading');
const rivalsList = document.getElementById('card-rivals');
const badgesHeading = document.getElementById('card-badges-heading');
const badgesGrid = document.getElementById('card-badges');
const badgeDetail = document.getElementById('card-badge-detail');

const TOAST_MS = 6000;

let getClientId = () => '';
let googleClientId = null;
let historyEnabled = false;
let googleReady = null;
let signedIn = false;
let lockListener = null;

/** cb(Map sticker -> badge name) whenever the set of locked stickers is (re)loaded. */
export function onLockedStickers(cb) {
  lockListener = cb;
}

function showError(msg) {
  cardError.textContent = msg || '';
  cardError.classList.toggle('hidden', !msg);
}

function loadGoogleScript() {
  if (!googleReady) {
    googleReady = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = resolve;
      s.onerror = () => {
        googleReady = null;
        reject(new Error('Could not load Google sign-in'));
      };
      document.head.appendChild(s);
    }).then(() => {
      window.google.accounts.id.initialize({
        client_id: googleClientId,
        callback: onGoogleCredential,
      });
    });
  }
  return googleReady;
}

async function renderGoogleButton() {
  try {
    await loadGoogleScript();
    if (googleBtnEl.childElementCount) return;
    window.google.accounts.id.renderButton(googleBtnEl, {
      theme: 'filled_black',
      size: 'large',
      shape: 'pill',
      text: 'continue_with',
    });
  } catch (err) {
    showError(err.message);
  }
}

async function onGoogleCredential({ credential }) {
  showError('');
  try {
    const res = await fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential, clientId: getClientId() }),
    });
    const data = await res.json();
    if (!data.ok) return showError(data.error || 'Sign-in failed');
    render(data.user, data.card);
    if (data.newBadges && data.newBadges.length) showBadgeToast(data.newBadges);
  } catch (err) {
    showError('Sign-in failed, check your connection');
  }
}

function rivalStatus(r) {
  if (r.wins > r.losses) return { icon: '👑', cls: 'ahead', text: 'You lead' };
  if (r.wins < r.losses) return { icon: '😤', cls: 'behind', text: 'They lead' };
  return { icon: '🤝', cls: '', text: 'Dead even' };
}

/** Head-to-head records; tap a rival to see the record per game. */
function renderRivals(rivals) {
  rivalsList.innerHTML = '';
  rivalsHeading.classList.toggle('hidden', !rivals.length);
  for (const r of rivals) {
    const status = rivalStatus(r);
    const li = document.createElement('li');
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'card-rival';

    const main = document.createElement('span');
    main.className = 'card-rival-main';
    const icon = document.createElement('span');
    icon.textContent = status.icon;
    const name = document.createElement('span');
    name.className = 'card-rival-name';
    name.textContent = `vs ${r.name}`;
    const record = document.createElement('span');
    record.className = `card-rival-record ${status.cls}`;
    record.textContent = `${r.wins}–${r.losses}`;
    main.append(icon, name, record);

    const sub = document.createElement('span');
    sub.className = 'card-rival-sub';
    sub.textContent = `${status.text} · ${r.games === 1 ? '1 game' : `${r.games} games`} together`;

    const games = document.createElement('ul');
    games.className = 'card-rival-games';
    Object.entries(r.byGame)
      .sort((a, b) => b[1].games - a[1].games)
      .forEach(([type, s]) => {
        const g = document.createElement('li');
        const label = document.createElement('span');
        label.textContent = GAME_LABELS[type] || type;
        const value = document.createElement('span');
        value.textContent = `${s.wins}–${s.losses}`;
        g.append(label, value);
        games.appendChild(g);
      });

    row.append(main, sub, games);
    row.addEventListener('click', () => row.classList.toggle('open'));
    li.appendChild(row);
    rivalsList.appendChild(li);
  }
}

/**
 * A badge's picture: its sticker from the app's sticker bank, or its emoji if the
 * sticker is gone. Locked badges show the sticker as a dark silhouette with a lock.
 */
function badgeArt(b, locked, className) {
  const wrap = document.createElement('span');
  wrap.className = className;
  if (b.sticker) {
    const img = document.createElement('img');
    img.src = `images/stickers/${b.sticker}`;
    img.alt = '';
    img.loading = 'lazy';
    wrap.appendChild(img);
  } else {
    wrap.textContent = b.emoji;
  }
  if (locked) {
    const lock = document.createElement('span');
    lock.className = 'badge-lock';
    lock.textContent = '🔒';
    wrap.appendChild(lock);
  }
  return wrap;
}

function renderBadges(badges) {
  badgesGrid.innerHTML = '';
  badgeDetail.classList.add('hidden');
  badgesHeading.classList.toggle('hidden', !badges.length);
  if (!badges.length) return;
  const earnedCount = badges.filter((b) => b.earned).length;
  badgesHeading.textContent = `Badges ${earnedCount}/${badges.length}`;
  // Earned first, then locked, each keeping the server's order.
  const ordered = [...badges.filter((b) => b.earned), ...badges.filter((b) => !b.earned)];
  for (const b of ordered) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = `card-badge${b.earned ? '' : ' locked'}`;
    const name = document.createElement('span');
    name.textContent = b.name;
    tile.append(badgeArt(b, !b.earned, 'card-badge-art'), name);
    tile.addEventListener('click', () => {
      const wasSelected = tile.classList.contains('selected');
      badgesGrid.querySelectorAll('.card-badge.selected').forEach((t) => t.classList.remove('selected'));
      if (wasSelected) return badgeDetail.classList.add('hidden');
      tile.classList.add('selected');
      badgeDetail.textContent = `${b.earned ? '' : '🔒 '}${b.name} - ${b.description}`;
      badgeDetail.classList.remove('hidden');
    });
    badgesGrid.appendChild(tile);
  }
}

// Pop-ups (badges, rivalry news) show one at a time, each until tapped or TOAST_MS.
const toastQueue = [];
let toastShowing = false;

function queueToast(toast, onShow) {
  toastQueue.push({ toast, onShow });
  if (!toastShowing) showNextToast();
}

function showNextToast() {
  const next = toastQueue.shift();
  if (!next) {
    toastShowing = false;
    return;
  }
  toastShowing = true;
  let done = false;
  const dismiss = () => {
    if (done) return;
    done = true;
    next.toast.remove();
    showNextToast();
  };
  next.toast.addEventListener('click', dismiss);
  document.body.appendChild(next.toast);
  if (next.onShow) next.onShow();
  setTimeout(dismiss, TOAST_MS);
}

function makeToast(titleText) {
  const toast = document.createElement('div');
  toast.className = 'badge-toast';
  toast.setAttribute('role', 'status');
  const title = document.createElement('p');
  title.className = 'badge-toast-title';
  title.textContent = titleText;
  toast.appendChild(title);
  return toast;
}

/** Celebrates freshly earned badges over whatever screen is showing. */
function showBadgeToast(badges) {
  const toast = makeToast(badges.length === 1 ? '🏅 Badge earned!' : `🏅 ${badges.length} badges earned!`);
  const row = document.createElement('div');
  row.className = 'badge-toast-row';
  for (const b of badges) {
    const item = document.createElement('div');
    item.className = 'badge-toast-badge';
    const name = document.createElement('span');
    name.textContent = b.name;
    item.append(badgeArt(b, false, 'badge-toast-art'), name);
    row.appendChild(item);
  }
  toast.appendChild(row);
  const notes = [];
  if (badges.some((b) => b.sticker)) {
    notes.push(badges.length === 1 ? 'Sticker unlocked! Wear it from 🧸 in the lobby.' : 'Stickers unlocked! Wear them from 🧸 in the lobby.');
  }
  if (!signedIn && googleClientId) notes.push('Sign in with Google from 👤 in the lobby to keep it forever.');
  for (const text of notes) {
    const note = document.createElement('p');
    note.className = 'badge-toast-note';
    note.textContent = text;
    toast.appendChild(note);
  }
  queueToast(toast, () => {
    sfx.win();
    haptics.success();
  });
  // The badge's sticker is now unlocked - refresh the picker's locks.
  refreshCard();
}

/** Head-to-head news after a game, e.g. "You beat Dana again: 15–9 all-time". */
function showRivalryToast({ text, beat }) {
  const toast = makeToast(beat ? '⚔️ Rivalry' : '😤 Rivalry');
  toast.classList.add(beat ? 'rivalry-win' : 'rivalry-loss');
  const line = document.createElement('p');
  line.className = 'rivalry-toast-text';
  line.textContent = text;
  toast.appendChild(line);
  queueToast(toast, () => (beat ? sfx.scoreUp() : sfx.scoreDown()));
}

function render(user, card) {
  signedIn = !!user;
  cardProfile.classList.toggle('hidden', !user);
  cardGuest.classList.toggle('hidden', !!user);
  signOutBtn.classList.toggle('hidden', !user);
  deleteBtn.classList.toggle('hidden', !user);
  if (user) {
    cardName.textContent = user.name;
    cardAvatar.classList.toggle('hidden', !user.avatar);
    if (user.avatar) cardAvatar.src = user.avatar;
  }

  const played = (card && card.gamesPlayed) || 0;
  if (!played) {
    cardSummary.textContent = user ? 'No games recorded yet - go play!' : 'Play a game to start your card.';
  } else {
    const wins = card.wins === 1 ? '1 win' : `${card.wins} wins`;
    const games = played === 1 ? '1 game' : `${played} games`;
    cardSummary.textContent = user
      ? `${games} · ${wins} · ${card.points} pts`
      : `On this device: ${games} · ${wins} · ${card.points} pts`;
  }

  cardGames.innerHTML = '';
  const byGame = (card && card.byGame) || {};
  Object.entries(byGame)
    .sort((a, b) => b[1].played - a[1].played)
    .forEach(([type, s]) => {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = GAME_LABELS[type] || type;
      const value = document.createElement('span');
      value.textContent = `${s.won}/${s.played} won`;
      li.append(label, value);
      cardGames.appendChild(li);
    });

  renderRivals((card && card.rivals) || []);
  renderBadges((card && card.badges) || []);

  if (!user && cardDropdown.classList.contains('open')) renderGoogleButton();

  if (lockListener) {
    // sticker -> name of a badge that unlocks it, for the picker's "earn X" hint.
    const locked = new Map();
    for (const sticker of (card && card.lockedStickers) || []) {
      const badge = ((card && card.badges) || []).find((b) => b.sticker === sticker);
      locked.set(sticker, badge ? badge.name : '');
    }
    lockListener(locked);
  }
}

/**
 * Re-fetches the card (on opening it, returning to the lobby, earning a badge, and at
 * startup) - it also carries which stickers are still locked.
 */
export async function refreshCard() {
  if (!historyEnabled) return;
  try {
    const res = await fetch(`/api/me?clientId=${encodeURIComponent(getClientId())}`);
    const data = await res.json();
    if (data.ok === false) return showError(data.error);
    render(data.user, data.card);
  } catch (err) {
    // Offline or server restarting - keep showing whatever we had.
  }
}

export async function initAccount(clientIdGetter, socket) {
  getClientId = clientIdGetter;

  socket.on('badgesEarned', ({ badges }) => {
    if (badges && badges.length) showBadgeToast(badges);
  });
  socket.on('rivalryUpdate', (update) => {
    if (update && update.text) showRivalryToast(update);
  });

  deleteBtn.addEventListener('click', async () => {
    showError('');
    const ok = await confirmDialog(
      'Your account, all your game history and stats will be erased for good. This cannot be undone.',
      { title: 'Delete your account?', confirmLabel: 'Delete forever', danger: true }
    );
    if (!ok) return;
    try {
      const res = await fetch('/api/account', { method: 'DELETE' });
      const data = await res.json();
      if (!data.ok) return showError(data.error || 'Could not delete your account');
      if (window.google) window.google.accounts.id.disableAutoSelect();
    } catch (err) {
      return showError('Could not delete your account, check your connection');
    }
    refreshCard();
  });

  cardBtn.addEventListener('click', () => {
    const open = cardDropdown.classList.toggle('open');
    cardBtn.classList.toggle('open', open);
    if (open) refreshCard();
  });

  signOutBtn.addEventListener('click', async () => {
    showError('');
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      signedIn = false;
      if (window.google) window.google.accounts.id.disableAutoSelect();
    } catch (err) {
      return showError('Sign-out failed, check your connection');
    }
    refreshCard();
  });

  try {
    const res = await fetch('/api/auth/config');
    const config = await res.json();
    historyEnabled = !!config.history;
    if (config.enabled) {
      googleClientId = config.googleClientId;
      cardBtn.classList.remove('hidden');
    }
    // Load up front: badge pop-ups need to know whether we're signed in, and the
    // sticker picker needs the locks.
    await refreshCard();
  } catch (err) {
    // No config = no accounts this session; the lobby works as before.
  }
}
