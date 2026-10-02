/**
 * Bluff client module.
 */

import { renderScoreboard } from '../shared/scoreboard.js';

const BF_SUIT_SYMBOL = { s: '♠', h: '♥', d: '♦', c: '♣' };
const BF_SUIT_CLASS = { s: 'bf-suit-s', h: 'bf-suit-h', d: 'bf-suit-d', c: 'bf-suit-c' };
const BF_RANK_ORDER = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  T: 10, J: 11, Q: 12, K: 13, A: 14,
};
// Mirrors the server's constants (bluff-specs.md) - purely cosmetic timing on this side,
// the server is what actually decides when the next round lands.
const BF_LOSER_HIGHLIGHT_MS = 1500;
const BF_DEAL_ANIMATION_MS = 2200;

const bfSeatingPanel = document.getElementById('bf-seating-panel');
const bfCountSlider = document.getElementById('bf-count-slider');
const bfCountValue = document.getElementById('bf-count-value');
const bfStartBtn = document.getElementById('bf-start-btn');
const bfStartWaiting = document.getElementById('bf-start-waiting');
const bfSeatingError = document.getElementById('bf-seating-error');
const bfBackBtn = document.getElementById('bf-back-btn');
const bfTablePanel = document.getElementById('bf-table-panel');
const bfRoundLabel = document.getElementById('bf-round-label');
const bfTableHint = document.getElementById('bf-table-hint');
const bfTableFelt = document.querySelector('.bf-table-felt');
const bfSeatsEl = document.getElementById('bf-seats');
const bfHandEl = document.getElementById('bf-hand');
const bfTableError = document.getElementById('bf-table-error');
const bfGameoverPanel = document.getElementById('bf-gameover-panel');
const bfChampion = document.getElementById('bf-champion');
const bfStandings = document.getElementById('bf-standings');
const bfScoreboard = document.getElementById('bf-scoreboard');
const bfResetBtn = document.getElementById('bf-reset-btn');
const bfResetError = document.getElementById('bf-reset-error');

let ctx = null;
let sliderDragging = false;

// Drives the two-phase highlight -> deal-animation sequence after a loser pick. Keyed by
// round+result so a re-render of the same payload (e.g. another player's offline badge
// flipping mid-highlight) doesn't restart the timers from zero.
let bfHighlightSeatName = null;
let bfDealing = false;
let bfHandledResultKey = null;
let bfSequenceTimers = [];

function bfClearSequenceTimers() {
  bfSequenceTimers.forEach((t) => clearTimeout(t));
  bfSequenceTimers = [];
}

function bfResultKey(data) {
  if (!data.lastResult) return null;
  return `${data.roundNumber}:${data.lastResult.loserName}:${data.lastResult.newCount}`;
}

function bfCardRankValue(code) {
  const rank = code && code.slice(0, -1);
  return BF_RANK_ORDER[rank] || 0;
}

function bfSortCards(cards) {
  return (cards || []).slice().sort((a, b) => bfCardRankValue(a) - bfCardRankValue(b));
}

function bfCardCornerEl(rank, pip, position) {
  const corner = document.createElement('span');
  corner.className = `bf-card-corner bf-card-corner-${position}`;
  const rankEl = document.createElement('span');
  rankEl.className = 'bf-card-rank';
  rankEl.textContent = rank;
  const pipEl = document.createElement('span');
  pipEl.className = 'bf-card-pip';
  pipEl.textContent = pip;
  corner.appendChild(rankEl);
  corner.appendChild(pipEl);
  return corner;
}

function makeBfCardEl(code) {
  const el = document.createElement('span');
  el.className = 'bf-card';
  const rank = code.slice(0, -1) === 'T' ? '10' : code.slice(0, -1);
  const suit = code.slice(-1);
  const pip = BF_SUIT_SYMBOL[suit] || suit;
  const suitClass = BF_SUIT_CLASS[suit];
  if (suitClass) el.classList.add(suitClass);
  el.appendChild(bfCardCornerEl(rank, pip, 'tl'));
  const center = document.createElement('span');
  center.className = 'bf-card-center';
  center.textContent = pip;
  el.appendChild(center);
  el.appendChild(bfCardCornerEl(rank, pip, 'br'));
  el.setAttribute('aria-label', `${rank}${pip}`);
  return el;
}

function applySeating(data) {
  const isHost = ctx.getIsHost();
  const bounds = data.startCountBounds || { min: 1, max: 1 };

  bfCountSlider.min = bounds.min;
  bfCountSlider.max = bounds.max;
  bfCountSlider.disabled = !isHost;
  if (!sliderDragging) {
    bfCountSlider.value = data.pendingStartCount || bounds.max;
  }
  bfCountValue.textContent = bfCountSlider.value;

  bfStartBtn.classList.toggle('hidden', !isHost);
  bfStartBtn.disabled = !data.canStart;
  bfStartWaiting.classList.toggle('hidden', isHost);
}

function trySelectLoser(name) {
  if (!confirm(`Mark ${name} as this round's loser?`)) return;
  bfTableError.textContent = '';
  ctx.socket.emit('bfSelectLoser', { name }, (res) => {
    if (res && !res.ok) bfTableError.textContent = res.error;
  });
}

/** Places each seat on a circle, seat 0 at the top, clockwise - seatCount is fixed for
 * the whole match (bfPlayers never reflows), so this is safe to recompute every render. */
function renderBfSeats(seats, { tappable, highlightName } = {}) {
  bfSeatsEl.innerHTML = '';
  const n = seats.length;
  const radius = 42;
  seats.forEach((seat, i) => {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2;
    const left = 50 + radius * Math.cos(angle);
    const top = 50 + radius * Math.sin(angle);

    const seatEl = document.createElement(tappable && !seat.eliminated ? 'button' : 'div');
    seatEl.className = 'bf-seat';
    if (tappable && !seat.eliminated) seatEl.type = 'button';
    seatEl.style.left = `${left}%`;
    seatEl.style.top = `${top}%`;
    seatEl.style.transform = 'translate(-50%, -50%)';
    if (!seat.connected) seatEl.classList.add('bf-seat-offline');
    if (seat.eliminated) seatEl.classList.add('bf-seat-eliminated');
    if (seat.name === highlightName) seatEl.classList.add('bf-seat-highlight');
    if (tappable && !seat.eliminated) {
      seatEl.classList.add('bf-seat-tappable');
      seatEl.addEventListener('click', () => trySelectLoser(seat.name));
    }

    const number = document.createElement('span');
    number.className = 'bf-seat-number';
    number.textContent = `#${seat.seatIndex + 1}`;
    seatEl.appendChild(number);

    const name = document.createElement('span');
    name.className = 'bf-seat-name';
    name.textContent = seat.name;
    seatEl.appendChild(name);

    const count = document.createElement('span');
    count.className = 'bf-seat-count';
    count.textContent = seat.count;
    seatEl.appendChild(count);

    bfSeatsEl.appendChild(seatEl);
  });
}

function renderTableHint(isHost, lastResult) {
  if (lastResult) {
    bfTableHint.textContent = isHost
      ? 'Dealing the next round…'
      : 'Waiting for the next round…';
  } else {
    bfTableHint.textContent = isHost
      ? "Tap a player who lost this round."
      : "Waiting for the host to mark this round's loser…";
  }
}

/** Starts (once per unique result) the highlight -> deal-animation sequence, then
 * re-renders seats with the right tappable/highlight state for the current phase. */
function runResultSequence(data) {
  const key = bfResultKey(data);
  const isHost = ctx.getIsHost();

  if (key === null) {
    bfClearSequenceTimers();
    bfHighlightSeatName = null;
    bfDealing = false;
    bfHandledResultKey = null;
    bfTableFelt.classList.remove('bf-dealing');
    renderBfSeats(data.seats || [], { tappable: isHost, highlightName: null });
    renderTableHint(isHost, null);
    return;
  }

  if (key !== bfHandledResultKey) {
    bfHandledResultKey = key;
    bfClearSequenceTimers();
    bfHighlightSeatName = data.lastResult.loserName;
    bfDealing = false;
    bfTableFelt.classList.remove('bf-dealing');

    bfSequenceTimers.push(
      setTimeout(() => {
        bfHighlightSeatName = null;
        bfDealing = true;
        bfTableFelt.classList.add('bf-dealing');
        renderBfSeats(data.seats || [], { tappable: false, highlightName: null });
      }, BF_LOSER_HIGHLIGHT_MS)
    );
    bfSequenceTimers.push(
      setTimeout(() => {
        bfDealing = false;
        bfTableFelt.classList.remove('bf-dealing');
      }, BF_LOSER_HIGHLIGHT_MS + BF_DEAL_ANIMATION_MS)
    );
  }

  renderBfSeats(data.seats || [], { tappable: false, highlightName: bfHighlightSeatName });
  renderTableHint(isHost, data.lastResult);
}

function applyTable(data) {
  bfRoundLabel.textContent = `Round ${data.roundNumber}`;
  bfTableError.textContent = '';
  runResultSequence(data);

  bfHandEl.innerHTML = '';
  if (!data.myHand) {
    const spectating = document.createElement('p');
    spectating.className = 'muted';
    spectating.textContent = 'No hand this round';
    bfHandEl.appendChild(spectating);
  } else {
    bfSortCards(data.myHand).forEach((card) => bfHandEl.appendChild(makeBfCardEl(card)));
  }
}

function applyGameover(data) {
  const ranking = data.ranking || [];
  const champion = ranking[0];
  bfChampion.textContent = champion ? `${champion.name} wins Bluff!` : 'No champion';

  bfStandings.innerHTML = '';
  ranking.forEach((row, i) => {
    const li = document.createElement('li');
    li.textContent = `#${i + 1} ${row.name} — ${row.points}`;
    if (i === 0) li.classList.add('ts-champion-row');
    bfStandings.appendChild(li);
  });

  renderScoreboard(bfScoreboard, data.scoreboard || []);
}

function applyState(data) {
  ctx.setHost(data.host);
  bfSeatingError.textContent = '';
  bfResetBtn.classList.toggle('hidden', !data.canResetGame);

  bfSeatingPanel.classList.toggle('hidden', data.phase !== 'seating');
  bfTablePanel.classList.toggle('hidden', data.phase !== 'playing');
  bfGameoverPanel.classList.toggle('hidden', data.phase !== 'gameover');

  if (data.phase !== 'playing') {
    bfClearSequenceTimers();
    bfHighlightSeatName = null;
    bfDealing = false;
    bfHandledResultKey = null;
    bfTableFelt.classList.remove('bf-dealing');
  }

  if (data.phase === 'seating') {
    applySeating(data);
  } else if (data.phase === 'playing') {
    applyTable(data);
  } else if (data.phase === 'gameover') {
    applyGameover(data);
  }
}

export const Bluff = {
  init(nextCtx) {
    ctx = nextCtx;
    const { socket } = ctx;

    bfCountSlider.addEventListener('input', () => {
      sliderDragging = true;
      bfCountValue.textContent = bfCountSlider.value;
    });

    bfCountSlider.addEventListener('change', () => {
      sliderDragging = false;
      socket.emit('bfSetStartingCount', { count: Number(bfCountSlider.value) }, (res) => {
        if (res && !res.ok) bfSeatingError.textContent = res.error;
      });
    });

    bfStartBtn.addEventListener('click', () => {
      bfSeatingError.textContent = '';
      socket.emit('startBluffMatch', (res) => {
        if (res && !res.ok) bfSeatingError.textContent = res.error;
      });
    });

    bfResetBtn.addEventListener('click', () => {
      if (!confirm('Reset this match? Everyone keeps their seat for a fresh game.')) return;
      bfResetError.textContent = '';
      socket.emit('bfResetGame', (res) => {
        if (res && !res.ok) bfResetError.textContent = res.error;
      });
    });

    bfBackBtn.addEventListener('click', () => {
      socket.emit('backToLobby', () => {});
    });

    socket.on('bluffState', (data) => {
      applyState(data);
      ctx.showScreen('bluff');
    });
  },

  applyState,

  applyJoin(res) {
    applyState(res);
    ctx.showScreen('bluff');
  },

  stop() {
    sliderDragging = false;
    bfClearSequenceTimers();
    bfHighlightSeatName = null;
    bfDealing = false;
    bfHandledResultKey = null;
    if (bfTableFelt) bfTableFelt.classList.remove('bf-dealing');
    if (bfSeatingError) bfSeatingError.textContent = '';
    if (bfTableError) bfTableError.textContent = '';
    if (bfResetError) bfResetError.textContent = '';
  },
};
