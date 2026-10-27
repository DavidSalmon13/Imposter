/**
 * Standalone account page (public/account.html) - opened in the same window from the
 * lobby's 👤 button (so an installed app keeps its sign-in), no socket/room involved. Shows match history, badges, rivals and, for
 * signed-in players, the FIFA Ultimate Team-style rating card. See
 * specs/account-page-specs.md for the full design; server side is server/accounts.js
 * (+ server/ratings.js for the card's stats).
 *
 * Identity: the device's clientId from localStorage (same value main.js uses, read
 * directly since it's the same origin) plus the shorot_session cookie (shared
 * cross-tab) for sign-in state.
 */

import { confirmDialog } from './shared/confirmDialog.js';
import { GAME_LABELS, renderBadges, renderRivals } from './shared/cardRender.js';

const STATS = ['SPD', 'COM', 'STR', 'TAC', 'NRV', 'DEC'];

const guestEl = document.getElementById('acct-guest');
const googleBtnEl = document.getElementById('acct-google-btn');
const nameEl = document.getElementById('acct-name');
const emailEl = document.getElementById('acct-email');
const walletEl = document.getElementById('acct-wallet');
const ratingCardEl = document.getElementById('acct-rating-card');
const ratingLockedEl = document.getElementById('acct-rating-locked');
const cardStickerEl = document.getElementById('acct-card-sticker');
const ovrEl = document.getElementById('acct-ovr');
const cardNameEl = document.getElementById('acct-card-name');
const stickerSwitcherEl = document.getElementById('acct-sticker-switcher');
const stickerGridEl = document.getElementById('acct-sticker-grid');
const stickerErrorEl = document.getElementById('acct-sticker-error');
const summaryEl = document.getElementById('acct-summary');
const historyBodyEl = document.getElementById('acct-history-body');
const badgesHeadingEl = document.getElementById('acct-badges-heading');
const badgesGridEl = document.getElementById('acct-badges');
const badgeDetailEl = document.getElementById('acct-badge-detail');
const rivalsHeadingEl = document.getElementById('acct-rivals-heading');
const rivalsListEl = document.getElementById('acct-rivals');
const signOutBtn = document.getElementById('acct-signout-btn');
const adminBtn = document.getElementById('acct-admin-btn');
const deleteBtn = document.getElementById('acct-delete-btn');
const errorEl = document.getElementById('acct-error');

function getClientId() {
  return localStorage.getItem('imposterClientId') || '';
}

function showError(msg) {
  errorEl.textContent = msg || '';
  errorEl.classList.toggle('hidden', !msg);
}

let googleClientId = null;
let signInEnabled = false;
let lockedStickers = new Set();
let allStickers = [];
let myAccountSticker = null;

async function loadGoogleScript() {
  if (window.google && window.google.accounts) return;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load Google sign-in'));
    document.head.appendChild(s);
  });
  window.google.accounts.id.initialize({ client_id: googleClientId, callback: onGoogleCredential });
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
    render(data.user, data.card, data.balance);
  } catch (err) {
    showError('Sign-in failed, check your connection');
  }
}

function renderRatingCard(user, card) {
  const signedIn = !!user;
  ratingCardEl.classList.toggle('hidden', !signedIn);
  ratingLockedEl.classList.toggle('hidden', signedIn);
  stickerSwitcherEl.classList.toggle('hidden', !signedIn);
  if (!signedIn) return;

  const ratings = (card && card.ratings) || { ovr: 50, tier: 'bronze', stats: {} };
  // "Strong gold" (OVR 85+) is a brighter variant of the same gold tier, not a separate
  // one - see specs/account-page-specs.md.
  const strongGold = ratings.tier === 'gold' && ratings.ovr >= 85;
  ratingCardEl.className = `rating-card rating-card-${ratings.tier}${strongGold ? ' rating-card-gold-strong' : ''}`;
  ovrEl.textContent = ratings.ovr;
  cardNameEl.textContent = user.name;
  myAccountSticker = user.sticker || null;
  cardStickerEl.src = myAccountSticker ? `images/stickers/${myAccountSticker}` : '';
  cardStickerEl.classList.toggle('hidden', !myAccountSticker);
  for (const stat of STATS) {
    document.getElementById(`acct-stat-${stat}`).textContent = ratings.stats[stat] ?? 50;
  }
  renderStickerGrid();
}

function renderStickerGrid() {
  stickerGridEl.innerHTML = '';
  for (const file of allStickers) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sticker-option';
    btn.classList.toggle('selected', file === myAccountSticker);
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
    }
    btn.addEventListener('click', () => chooseSticker(file));
    stickerGridEl.appendChild(btn);
  }
}

async function chooseSticker(sticker) {
  stickerErrorEl.classList.add('hidden');
  const next = sticker === myAccountSticker ? null : sticker;
  try {
    const res = await fetch('/api/account/sticker', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sticker: next }),
    });
    const data = await res.json();
    if (!data.ok) {
      stickerErrorEl.textContent = data.error || 'Could not update your sticker';
      stickerErrorEl.classList.remove('hidden');
      return;
    }
    myAccountSticker = data.sticker;
    cardStickerEl.src = myAccountSticker ? `images/stickers/${myAccountSticker}` : '';
    cardStickerEl.classList.toggle('hidden', !myAccountSticker);
    renderStickerGrid();
  } catch (err) {
    stickerErrorEl.textContent = 'Could not update your sticker, check your connection';
    stickerErrorEl.classList.remove('hidden');
  }
}

function renderHistoryTable(byGame) {
  historyBodyEl.innerHTML = '';
  const rows = Object.entries(byGame || {}).sort((a, b) => b[1].played - a[1].played);
  for (const [type, s] of rows) {
    const tr = document.createElement('tr');
    const label = document.createElement('td');
    label.textContent = GAME_LABELS[type] || type;
    const played = document.createElement('td');
    played.textContent = s.played;
    const won = document.createElement('td');
    won.textContent = s.won;
    const lost = document.createElement('td');
    lost.textContent = s.played - s.won;
    tr.append(label, played, won, lost);
    historyBodyEl.appendChild(tr);
  }
}

function render(user, card, balance) {
  guestEl.classList.toggle('hidden', !!user || !signInEnabled);
  nameEl.classList.toggle('hidden', !user);
  signOutBtn.classList.toggle('hidden', !user);
  deleteBtn.classList.toggle('hidden', !user);
  if (user) nameEl.textContent = user.name;
  // Shows which Google account this is - the one ADMIN_EMAILS has to list.
  emailEl.classList.toggle('hidden', !(user && user.email));
  if (user && user.email) emailEl.textContent = `Signed in as ${user.email}`;
  else if (signInEnabled) renderGoogleButton();

  // null (not a number) means no wallet to show at all - no account, or BETTING_ENABLED
  // is off (see server/accounts.js's /api/me and /api/auth/google).
  walletEl.classList.toggle('hidden', balance == null);
  if (balance != null) walletEl.textContent = `🪙 ${balance} token${balance === 1 ? '' : 's'}`;

  renderRatingCard(user, card);
  refreshAdminBtn(!!user);

  const played = (card && card.gamesPlayed) || 0;
  if (!played) {
    summaryEl.textContent = user ? 'No games recorded yet - go play!' : 'Play a game to start your history.';
  } else {
    const wins = card.wins === 1 ? '1 win' : `${card.wins} wins`;
    const games = played === 1 ? '1 game' : `${played} games`;
    summaryEl.textContent = user
      ? `${games} · ${wins} · ${card.points} pts`
      : `On this device: ${games} · ${wins} · ${card.points} pts`;
  }

  renderHistoryTable((card && card.byGame) || {});
  renderBadges(badgesGridEl, badgesHeadingEl, badgeDetailEl, (card && card.badges) || []);
  renderRivals(rivalsListEl, rivalsHeadingEl, (card && card.rivals) || []);

  lockedStickers = new Set((card && card.lockedStickers) || []);
}

// Only the account(s) in the server's ADMIN_EMAILS see this - the installed app has no
// address bar, so this is how the owner gets to /admin.
async function refreshAdminBtn(signedIn) {
  let admin = false;
  if (signedIn) {
    try {
      admin = !!(await (await fetch('/api/admin/me')).json()).admin;
    } catch (err) {
      // No admin button is the safe fallback.
    }
  }
  adminBtn.classList.toggle('hidden', !admin);
}

adminBtn.addEventListener('click', () => {
  window.location.href = '/admin';
});

// The installed app has no browser back button; the lobby's saved session rejoins the room.
document.getElementById('acct-back-btn').addEventListener('click', () => {
  window.location.href = '/';
});

signOutBtn.addEventListener('click', async () => {
  showError('');
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
    if (window.google) window.google.accounts.id.disableAutoSelect();
  } catch (err) {
    return showError('Sign-out failed, check your connection');
  }
  refresh();
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
  refresh();
});

async function refresh() {
  try {
    const res = await fetch(`/api/me?clientId=${encodeURIComponent(getClientId())}`);
    const data = await res.json();
    if (data.ok === false) return showError(data.error);
    render(data.user, data.card, data.balance);
  } catch (err) {
    showError('Could not load your account, check your connection');
  }
}

async function init() {
  try {
    const stickersRes = await fetch('/api/stickers');
    allStickers = ((await stickersRes.json()).stickers) || [];
  } catch (err) {
    allStickers = [];
  }
  try {
    const res = await fetch('/api/auth/config');
    const config = await res.json();
    if (!config.history) {
      const screen = document.querySelector('.account-screen');
      const backBtn = document.getElementById('acct-back-btn');
      screen.innerHTML =
        '<h1 class="account-title">My Account</h1><p class="muted">Accounts aren\'t set up for this server.</p>';
      // Keep the way back to the lobby (same element, so its click handler survives).
      screen.prepend(backBtn);
      return;
    }
    signInEnabled = !!config.enabled;
    googleClientId = config.googleClientId;
    await refresh();
  } catch (err) {
    showError('Could not reach the server');
  }
}

init();
