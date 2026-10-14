/**
 * Player Card + Google sign-in (lobby 👤 dropdown). Server side: server/accounts.js.
 *
 * Guests see the stats recorded for this browser and a "Sign in with Google" button;
 * signing in attaches those stats to the account. The whole feature stays hidden when
 * the server has no database or no GOOGLE_CLIENT_ID (GET /api/auth/config).
 */

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
const cardError = document.getElementById('card-error');

let getClientId = () => '';
let googleClientId = null;
let googleReady = null;

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
  } catch (err) {
    showError('Sign-in failed, check your connection');
  }
}

function render(user, card) {
  cardProfile.classList.toggle('hidden', !user);
  cardGuest.classList.toggle('hidden', !!user);
  signOutBtn.classList.toggle('hidden', !user);
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

  if (!user) renderGoogleButton();
}

/** Re-fetches the card while its dropdown is open (on open, and on returning to the lobby). */
export async function refreshCard() {
  if (!googleClientId || !cardDropdown.classList.contains('open')) return;
  try {
    const res = await fetch(`/api/me?clientId=${encodeURIComponent(getClientId())}`);
    const data = await res.json();
    if (data.ok === false) return showError(data.error);
    render(data.user, data.card);
  } catch (err) {
    // Offline or server restarting - keep showing whatever we had.
  }
}

export async function initAccount(clientIdGetter) {
  getClientId = clientIdGetter;

  cardBtn.addEventListener('click', () => {
    const open = cardDropdown.classList.toggle('open');
    cardBtn.classList.toggle('open', open);
    if (open) refreshCard();
  });

  signOutBtn.addEventListener('click', async () => {
    showError('');
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      if (window.google) window.google.accounts.id.disableAutoSelect();
    } catch (err) {
      return showError('Sign-out failed, check your connection');
    }
    refreshCard();
  });

  try {
    const res = await fetch('/api/auth/config');
    const config = await res.json();
    if (!config.enabled) return;
    googleClientId = config.googleClientId;
    cardBtn.classList.remove('hidden');
  } catch (err) {
    // No config = no accounts this session; the lobby works as before.
  }
}
