/**
 * Lobby-side slice of accounts: shows/hides the 👤 button (which opens the full
 * account page, public/account.html, in a new tab - see
 * specs/account-page-specs.md), keeps the sticker pickers' lock data fresh, and pops
 * up badge/rivalry toasts as they happen live over the socket. Everything else
 * (profile, card, sign-in/out, badges/rivals/history rendering) lives in
 * public/js/account-page.js now; this file has no DOM of its own beyond the toasts.
 *
 * The whole feature stays inert when the server has no database (GET /api/auth/config).
 */

import { badgeArt, buildRatingCard } from './cardRender.js';
import { sfx, haptics } from '../fx.js';

const cardBtn = document.getElementById('card-btn');
const adminBtn = document.getElementById('admin-btn');

const TOAST_MS = 6000;

let getClientId = () => '';
let historyEnabled = false;
let signedIn = false;
let lockListener = null;
let socketRef = null;

/** cb(Map sticker -> badge name) whenever the set of locked stickers is (re)loaded. */
export function onLockedStickers(cb) {
  lockListener = cb;
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
    notes.push(badges.length === 1 ? 'Sticker unlocked! Wear it from Account in the lobby.' : 'Stickers unlocked! Wear them from Account in the lobby.');
  }
  if (!signedIn && !cardBtn.classList.contains('hidden')) {
    notes.push('Open your Account page from the lobby to sign in and keep it forever.');
  }
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

/**
 * A global or side bet resolving (or, for a side bet, being voided by a host edit) -
 * see plans/betting-implementation-plan.md S8 for the betResolved payload shape.
 * Reuses this same toast queue rather than a second notification system, per
 * specs/betting-specs.md "Cross-cutting UX".
 */
function showBetResolvedToast({ kind, won, stake, payout, pick, opponentName, voided }) {
  let title;
  let text;
  if (voided) {
    title = '↩️ Bet voided';
    text = `Your ${stake}-token bet on ${pick} was refunded - that round got edited.`;
  } else if (won) {
    title = kind === 'global' ? '🏆 Bet won!' : '🤝 Bet won!';
    text = kind === 'side' && opponentName
      ? `You won ${payout} tokens off ${opponentName} - ${pick} really did lose that round!`
      : `You won ${payout} tokens! Your bet on ${pick} paid off.`;
  } else {
    title = '💸 Bet lost';
    text = kind === 'side' && opponentName
      ? `Lost your ${stake}-token bet on ${pick} to ${opponentName}.`
      : `Lost your ${stake}-token bet on ${pick}.`;
  }
  const toast = makeToast(title);
  if (!voided) toast.classList.add(won ? 'rivalry-win' : 'rivalry-loss');
  const line = document.createElement('p');
  line.className = 'rivalry-toast-text';
  line.textContent = text;
  toast.appendChild(line);
  queueToast(toast, () => (won && !voided ? sfx.scoreUp() : sfx.scoreDown()));
}

/**
 * Re-fetches /api/me - on startup and whenever a badge is earned - purely to keep the
 * sticker pickers' lock data and the `signedIn` toast-copy flag current. No DOM render:
 * the full card lives on the account page, fetched independently from there.
 */
export async function refreshCard() {
  if (!historyEnabled) return;
  try {
    const res = await fetch(`/api/me?clientId=${encodeURIComponent(getClientId())}`);
    const data = await res.json();
    if (data.ok === false) return;
    signedIn = !!data.user;
    if (lockListener) {
      const locked = new Map();
      const card = data.card;
      for (const sticker of (card && card.lockedStickers) || []) {
        const badge = ((card && card.badges) || []).find((b) => b.sticker === sticker);
        locked.set(sticker, badge ? badge.name : '');
      }
      lockListener(locked);
    }
  } catch (err) {
    // Offline or server restarting - keep whatever locks we already have.
  }
}

/** Closes any open player-card popup, if one is showing. */
function closePlayerCardModal() {
  const existing = document.querySelector('.player-card-overlay');
  if (existing) existing.remove();
}

function showPlayerCardModal(user, card) {
  closePlayerCardModal();
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay player-card-overlay';

  const panel = document.createElement('div');
  panel.className = 'confirm-panel player-card-panel';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'player-card-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', closePlayerCardModal);
  panel.appendChild(closeBtn);

  panel.appendChild(buildRatingCard(user, card));
  overlay.appendChild(panel);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closePlayerCardModal();
  });
  function onKey(e) {
    if (e.key !== 'Escape') return;
    document.removeEventListener('keydown', onKey);
    closePlayerCardModal();
  }
  document.addEventListener('keydown', onKey);

  document.body.appendChild(overlay);
}

/**
 * Opens a popup with `name`'s rating card - called when a lobby player taps a glowing
 * (signed-in) avatar, see renderLobby in public/js/main.js. No-ops quietly if the
 * player isn't signed in or the card can't be loaded (e.g. they just disconnected).
 */
export function openPlayerCard(name) {
  if (!socketRef) return;
  socketRef.emit('viewPlayerCard', name, (res) => {
    if (!res || !res.ok) return;
    showPlayerCardModal(res.user, res.card);
  });
}

export async function initAccount(clientIdGetter, socket) {
  getClientId = clientIdGetter;
  socketRef = socket;

  socket.on('badgesEarned', ({ badges }) => {
    if (badges && badges.length) showBadgeToast(badges);
  });
  socket.on('rivalryUpdate', (update) => {
    if (update && update.text) showRivalryToast(update);
  });
  socket.on('betResolved', (payload) => {
    if (payload) showBetResolvedToast(payload);
  });

  // Same window, not a new tab: an installed iPhone app opens new tabs in Safari, which
  // doesn't share the app's sign-in cookie. Both pages link back to '/', and the saved
  // session rejoins the room on return.
  cardBtn.addEventListener('click', () => {
    window.location.href = '/account.html';
  });
  adminBtn.addEventListener('click', () => {
    window.location.href = '/admin';
  });

  try {
    const res = await fetch('/api/auth/config');
    const config = await res.json();
    historyEnabled = !!config.history;
    if (config.enabled) cardBtn.classList.remove('hidden');
    // Load up front: badge pop-ups need to know whether we're signed in, and the
    // sticker picker needs the locks.
    await refreshCard();
    // Only shown to the account(s) in the server's ADMIN_EMAILS (see server/admin.js).
    const admin = await (await fetch('/api/admin/me')).json();
    adminBtn.classList.toggle('hidden', !admin.admin);
  } catch (err) {
    // No config = no accounts this session; the lobby works as before.
  }
}
