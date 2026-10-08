/**
 * Bluff client module.
 */

import { renderScoreboard } from '../shared/scoreboard.js';
import { confirmDialog } from '../shared/confirmDialog.js';

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
const bfCheckResult = document.getElementById('bf-check-result');
const bfCheckLabel = document.getElementById('bf-check-label');
const bfCheckCountdown = document.getElementById('bf-check-countdown');
const bfCheckOpenBtn = document.getElementById('bf-check-open-btn');
const bfCheckBuilder = document.getElementById('bf-check-builder');
const bfCheckTypes = document.getElementById('bf-check-types');
const bfCheckRankLabel = document.getElementById('bf-check-rank-label');
const bfCheckRanks = document.getElementById('bf-check-ranks');
const bfCheckRank2Label = document.getElementById('bf-check-rank2-label');
const bfCheckRanks2 = document.getElementById('bf-check-ranks2');
const bfCheckSuitLabel = document.getElementById('bf-check-suit-label');
const bfCheckSuits = document.getElementById('bf-check-suits');
const bfCheckCancelBtn = document.getElementById('bf-check-cancel-btn');
const bfCheckSubmitBtn = document.getElementById('bf-check-submit-btn');

// Hand types the host can call out, weakest first. Mirrors server/games/bluffHands.js -
// the server re-validates, this only drives which pickers to show.
const BF_HAND_TYPES = [
  { type: 'high', label: 'High card', rankLabel: 'Card' },
  { type: 'pair', label: 'Pair', rankLabel: 'Pair of' },
  { type: 'twopair', label: 'Two pair', rankLabel: 'First pair', rank2Label: 'Second pair' },
  { type: 'trips', label: 'Three of a kind', rankLabel: 'Three of' },
  { type: 'straight', label: 'Straight', rankLabel: 'Up to', straight: true },
  { type: 'flush', label: 'Flush', noRank: true, suit: true },
  { type: 'fullhouse', label: 'Full house', rankLabel: 'Three of', rank2Label: 'Over a pair of' },
  { type: 'quads', label: 'Four of a kind', rankLabel: 'Four of' },
  { type: 'straightflush', label: 'Straight flush', rankLabel: 'Up to', straight: true, suit: true },
];
const BF_RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const BF_SUITS = ['s', 'h', 'd', 'c'];
// Straights are named by their top card; the lowest is 5 (A-2-3-4-5).
const BF_MIN_STRAIGHT_TOP = BF_RANKS.indexOf('5');

let ctx = null;
let sliderDragging = false;

// Drives the two-phase highlight -> deal-animation sequence after a loser pick. Keyed by
// round+result so a re-render of the same payload (e.g. another player's offline badge
// flipping mid-highlight) doesn't restart the timers from zero.
let bfHighlightSeatName = null;
let bfDealing = false;
let bfHandledResultKey = null;
let bfSequenceTimers = [];

// Host's in-progress hand pick - kept across re-renders so a state update mid-pick
// (e.g. someone's offline badge) doesn't wipe it.
let bfBuilderOpen = false;
let bfPick = { type: null, rank: null, rank2: null, suit: null };
// Local 3-2-1 countdown for the current check, keyed by check id so re-renders don't restart it.
let bfCheckShownId = null;
let bfCheckTimer = null;
let bfCheckRevealAt = 0;
let bfCheckPresent = null;

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

async function trySelectLoser(name) {
  const ok = await confirmDialog(`Mark ${name} as this round's loser?`, {
    title: 'Round loser',
    confirmLabel: 'Mark loser',
  });
  if (!ok) return;
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
    const checkCounting = !!data.check && data.check.present === null;
    renderBfSeats(data.seats || [], { tappable: isHost && !checkCounting, highlightName: null });
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

function bfRankText(r) {
  return r === 'T' ? '10' : r;
}

function bfMakeChip(text, onClick, extraClass) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `level-btn bf-chip${extraClass ? ` ${extraClass}` : ''}`;
  btn.textContent = text;
  btn.addEventListener('click', onClick);
  return btn;
}

function bfPickSpec() {
  return BF_HAND_TYPES.find((t) => t.type === bfPick.type) || null;
}

function bfPickComplete() {
  const spec = bfPickSpec();
  if (!spec) return false;
  if (!spec.noRank && !bfPick.rank) return false;
  if (spec.rank2Label && (!bfPick.rank2 || bfPick.rank2 === bfPick.rank)) return false;
  if (spec.suit && !bfPick.suit) return false;
  return true;
}

/** Syncs the chip highlights / visible pickers to bfPick. Chips are built once in init. */
function renderBuilder() {
  const spec = bfPickSpec();
  Array.from(bfCheckTypes.children).forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.type === bfPick.type);
  });

  const showRank = !!spec && !spec.noRank;
  bfCheckRankLabel.classList.toggle('hidden', !showRank);
  bfCheckRanks.classList.toggle('hidden', !showRank);
  if (showRank) bfCheckRankLabel.textContent = spec.rankLabel;
  Array.from(bfCheckRanks.children).forEach((btn, i) => {
    btn.disabled = !!spec && !!spec.straight && i < BF_MIN_STRAIGHT_TOP;
    btn.classList.toggle('selected', btn.dataset.rank === bfPick.rank);
  });

  const showRank2 = !!spec && !!spec.rank2Label;
  bfCheckRank2Label.classList.toggle('hidden', !showRank2);
  bfCheckRanks2.classList.toggle('hidden', !showRank2);
  if (showRank2) bfCheckRank2Label.textContent = spec.rank2Label;
  Array.from(bfCheckRanks2.children).forEach((btn) => {
    btn.disabled = btn.dataset.rank === bfPick.rank;
    btn.classList.toggle('selected', btn.dataset.rank === bfPick.rank2);
  });

  const showSuit = !!spec && !!spec.suit;
  bfCheckSuitLabel.classList.toggle('hidden', !showSuit);
  bfCheckSuits.classList.toggle('hidden', !showSuit);
  Array.from(bfCheckSuits.children).forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.suit === bfPick.suit);
  });

  bfCheckSubmitBtn.disabled = !bfPickComplete();
}

function buildBuilderChips() {
  BF_HAND_TYPES.forEach((t) => {
    const chip = bfMakeChip(t.label, () => {
      bfPick.type = t.type;
      // Drop picks the new type can't use (e.g. a 3 when switching to Straight).
      if (t.noRank) bfPick.rank = null;
      if (t.straight && bfPick.rank && BF_RANKS.indexOf(bfPick.rank) < BF_MIN_STRAIGHT_TOP) bfPick.rank = null;
      if (!t.rank2Label) bfPick.rank2 = null;
      if (!t.suit) bfPick.suit = null;
      renderBuilder();
    });
    chip.dataset.type = t.type;
    bfCheckTypes.appendChild(chip);
  });
  BF_RANKS.forEach((r) => {
    const chip = bfMakeChip(bfRankText(r), () => {
      bfPick.rank = r;
      if (bfPick.rank2 === r) bfPick.rank2 = null;
      renderBuilder();
    });
    chip.dataset.rank = r;
    bfCheckRanks.appendChild(chip);
    const chip2 = bfMakeChip(bfRankText(r), () => {
      bfPick.rank2 = r;
      renderBuilder();
    });
    chip2.dataset.rank = r;
    bfCheckRanks2.appendChild(chip2);
  });
  BF_SUITS.forEach((suitCode) => {
    const chip = bfMakeChip(BF_SUIT_SYMBOL[suitCode], () => {
      bfPick.suit = suitCode;
      renderBuilder();
    }, BF_SUIT_CLASS[suitCode]);
    chip.dataset.suit = suitCode;
    bfCheckSuits.appendChild(chip);
  });
}

function resetBuilder() {
  bfBuilderOpen = false;
  bfPick = { type: null, rank: null, rank2: null, suit: null };
  renderBuilder();
}

function stopCheckCountdown() {
  if (bfCheckTimer) clearInterval(bfCheckTimer);
  bfCheckTimer = null;
}

function renderCheckCountdown() {
  bfCheckResult.classList.remove('bf-check-present', 'bf-check-absent');
  const left = Math.ceil((bfCheckRevealAt - Date.now()) / 1000);
  if (bfCheckPresent === null) {
    // Server reveal may land a beat after our local clock hits zero - hold on "1" until it does.
    bfCheckCountdown.textContent = String(Math.max(1, left));
    return;
  }
  stopCheckCountdown();
  bfCheckResult.classList.add(bfCheckPresent ? 'bf-check-present' : 'bf-check-absent');
  bfCheckCountdown.textContent = bfCheckPresent ? '✅ It\'s there!' : '❌ Not there!';
}

/** Shows the called hand, a 3-2-1 countdown, then whether it's on the table. */
function applyCheck(check) {
  if (!check) {
    stopCheckCountdown();
    bfCheckShownId = null;
    bfCheckResult.classList.add('hidden');
    return;
  }
  bfCheckResult.classList.remove('hidden');
  bfCheckLabel.textContent = check.label;
  bfCheckPresent = check.present;
  if (check.id !== bfCheckShownId) {
    bfCheckShownId = check.id;
    bfCheckRevealAt = Date.now() + check.remainingMs;
    stopCheckCountdown();
    if (check.present === null) bfCheckTimer = setInterval(renderCheckCountdown, 200);
  }
  renderCheckCountdown();
}

function applyTable(data) {
  bfRoundLabel.textContent = `Round ${data.roundNumber}`;
  bfTableError.textContent = '';
  runResultSequence(data);
  applyCheck(data.check);

  // Host can check the called hand while a round is live and no check is counting down.
  const isHost = ctx.getIsHost();
  const checkCounting = !!data.check && data.check.present === null;
  const canCheck = isHost && !data.lastResult && !checkCounting;
  if (!canCheck && bfBuilderOpen) resetBuilder();
  bfCheckOpenBtn.classList.toggle('hidden', !canCheck || bfBuilderOpen);
  bfCheckOpenBtn.textContent = data.check ? '🔍 Check another hand' : '🔍 Check the last hand';
  bfCheckBuilder.classList.toggle('hidden', !canCheck || !bfBuilderOpen);

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
    applyCheck(null);
    if (bfBuilderOpen) resetBuilder();
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

    bfResetBtn.addEventListener('click', async () => {
      const ok = await confirmDialog('Everyone keeps their seat for a fresh game.', {
        title: 'Reset this match?',
        confirmLabel: 'Reset',
        danger: true,
      });
      if (!ok) return;
      bfResetError.textContent = '';
      socket.emit('bfResetGame', (res) => {
        if (res && !res.ok) bfResetError.textContent = res.error;
      });
    });

    buildBuilderChips();
    renderBuilder();

    bfCheckOpenBtn.addEventListener('click', () => {
      bfBuilderOpen = true;
      bfCheckOpenBtn.classList.add('hidden');
      bfCheckBuilder.classList.remove('hidden');
    });

    bfCheckCancelBtn.addEventListener('click', () => {
      resetBuilder();
      bfCheckBuilder.classList.add('hidden');
      bfCheckOpenBtn.classList.remove('hidden');
    });

    bfCheckSubmitBtn.addEventListener('click', () => {
      if (!bfPickComplete()) return;
      bfTableError.textContent = '';
      const hand = { ...bfPick };
      socket.emit('bfCheckHand', { hand }, (res) => {
        if (res && !res.ok) bfTableError.textContent = res.error;
      });
      resetBuilder();
      bfCheckBuilder.classList.add('hidden');
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
    applyCheck(null);
    resetBuilder();
    if (bfCheckBuilder) bfCheckBuilder.classList.add('hidden');
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
