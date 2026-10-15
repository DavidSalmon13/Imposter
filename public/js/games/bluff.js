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
const bfCheckPicked = document.getElementById('bf-check-picked');
const bfCheckRanks = document.getElementById('bf-check-ranks');
const bfCheckCancelBtn = document.getElementById('bf-check-cancel-btn');
const bfCheckSubmitBtn = document.getElementById('bf-check-submit-btn');
const bfEditOpenBtn = document.getElementById('bf-edit-open-btn');
const bfEditPanel = document.getElementById('bf-edit-panel');
const bfEditHint = document.getElementById('bf-edit-hint');
const bfEditList = document.getElementById('bf-edit-list');
const bfEditError = document.getElementById('bf-edit-error');
const bfEditActions = document.getElementById('bf-edit-actions');
const bfEditCancelBtn = document.getElementById('bf-edit-cancel-btn');
const bfEditReadyBtn = document.getElementById('bf-edit-ready-btn');

const BF_RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
// Mirrors server/games/bluffHands.js - the server re-validates.
const BF_MAX_CALLED_CARDS = 20;

let ctx = null;
let sliderDragging = false;

// Drives the two-phase highlight -> deal-animation sequence after a loser pick. Keyed by
// round+result so a re-render of the same payload (e.g. another player's offline badge
// flipping mid-highlight) doesn't restart the timers from zero.
let bfHighlightSeatName = null;
let bfDealing = false;
let bfHandledResultKey = null;
let bfSequenceTimers = [];

// Host's in-progress pick of called card values - kept across re-renders so a state update
// mid-pick (e.g. someone's offline badge) doesn't wipe it.
let bfBuilderOpen = false;
let bfPick = [];
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

function bfPickCount(rank) {
  return bfPick.filter((r) => r === rank).length;
}

/** Shows the picked values (sorted) and disables values already picked four times. */
function renderBuilder() {
  bfCheckPicked.innerHTML = '';
  if (bfPick.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'muted';
    empty.textContent = 'No cards picked yet';
    bfCheckPicked.appendChild(empty);
  }
  const sorted = bfPick.slice().sort((a, b) => BF_RANKS.indexOf(a) - BF_RANKS.indexOf(b));
  sorted.forEach((r) => {
    bfCheckPicked.appendChild(
      bfMakeChip(bfRankText(r), () => {
        bfPick.splice(bfPick.indexOf(r), 1);
        renderBuilder();
      }, 'selected')
    );
  });

  const full = bfPick.length >= BF_MAX_CALLED_CARDS;
  Array.from(bfCheckRanks.children).forEach((btn) => {
    btn.disabled = full || bfPickCount(btn.dataset.rank) >= 4;
  });
  bfCheckSubmitBtn.disabled = bfPick.length === 0;
}

function buildBuilderChips() {
  BF_RANKS.forEach((r) => {
    const chip = bfMakeChip(bfRankText(r), () => {
      if (bfPickCount(r) >= 4 || bfPick.length >= BF_MAX_CALLED_CARDS) return;
      bfPick.push(r);
      renderBuilder();
    });
    chip.dataset.rank = r;
    bfCheckRanks.appendChild(chip);
  });
}

function resetBuilder() {
  bfBuilderOpen = false;
  bfPick = [];
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

/** Shows the called cards, a 3-2-1 countdown, then whether they're on the table. */
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

/** name -> current draft count +/- buttons post to, while an edit is in progress. */
function adjustEditCount(name, delta) {
  bfEditError.textContent = '';
  ctx.socket.emit('bfAdjustEditCount', { name, delta }, (res) => {
    if (res && !res.ok) bfEditError.textContent = res.error;
  });
}

/** Host-only "Edit card counts" entry button + the draft list, visible to everyone once open. */
function renderEditPanel(data) {
  const isHost = ctx.getIsHost();
  bfEditOpenBtn.classList.toggle('hidden', !data.canEdit || bfBuilderOpen);

  if (!data.editing) {
    bfEditPanel.classList.add('hidden');
    return;
  }
  bfEditPanel.classList.remove('hidden');
  bfEditHint.textContent = isHost
    ? 'Tap − / + to adjust, then Ready to deal the next round.'
    : 'The host is adjusting card counts…';
  bfEditActions.classList.toggle('hidden', !isHost);

  const counts = data.editCounts || {};
  bfEditList.innerHTML = '';
  (data.seats || []).forEach((seat) => {
    const li = document.createElement('li');
    li.className = 'bf-edit-row';
    const name = document.createElement('span');
    name.className = 'bf-edit-name';
    name.textContent = seat.name;
    li.appendChild(name);

    if (isHost) {
      const minus = document.createElement('button');
      minus.type = 'button';
      minus.className = 'bf-edit-step-btn';
      minus.textContent = '−';
      minus.addEventListener('click', () => adjustEditCount(seat.name, -1));
      li.appendChild(minus);
    }

    const count = document.createElement('span');
    count.className = 'bf-edit-count';
    count.textContent = counts[seat.name] || 0;
    li.appendChild(count);

    if (isHost) {
      const plus = document.createElement('button');
      plus.type = 'button';
      plus.className = 'bf-edit-step-btn';
      plus.textContent = '+';
      plus.addEventListener('click', () => adjustEditCount(seat.name, 1));
      li.appendChild(plus);
    }

    bfEditList.appendChild(li);
  });
}

function applyTable(data) {
  bfRoundLabel.textContent = `Round ${data.roundNumber}`;
  bfTableError.textContent = '';
  bfEditError.textContent = '';
  runResultSequence(data);
  applyCheck(data.check);
  renderEditPanel(data);

  // Host can check the called cards while a round is live, no check is counting down,
  // and no card-count edit is in progress (bfEditing blocks bfCheckHand server-side too).
  const isHost = ctx.getIsHost();
  const checkCounting = !!data.check && data.check.present === null;
  const canCheck = isHost && !data.lastResult && !checkCounting && !data.editing;
  if (!canCheck && bfBuilderOpen) resetBuilder();
  bfCheckOpenBtn.classList.toggle('hidden', !canCheck || bfBuilderOpen);
  bfCheckOpenBtn.textContent = data.check ? '🔍 Check other cards' : '🔍 Check the called cards';
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
    bfEditOpenBtn.classList.add('hidden');
    bfEditPanel.classList.add('hidden');
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
      if (bfPick.length === 0) return;
      bfTableError.textContent = '';
      const ranks = bfPick.slice();
      socket.emit('bfCheckHand', { ranks }, (res) => {
        if (res && !res.ok) bfTableError.textContent = res.error;
      });
      resetBuilder();
      bfCheckBuilder.classList.add('hidden');
    });

    bfEditOpenBtn.addEventListener('click', () => {
      bfEditError.textContent = '';
      socket.emit('bfStartEdit', (res) => {
        if (res && !res.ok) bfEditError.textContent = res.error;
      });
    });

    bfEditCancelBtn.addEventListener('click', () => {
      socket.emit('bfCancelEdit', () => {});
    });

    bfEditReadyBtn.addEventListener('click', () => {
      bfEditError.textContent = '';
      socket.emit('bfConfirmEdit', (res) => {
        if (res && !res.ok) bfEditError.textContent = res.error;
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
    if (bfEditError) bfEditError.textContent = '';
    if (bfEditOpenBtn) bfEditOpenBtn.classList.add('hidden');
    if (bfEditPanel) bfEditPanel.classList.add('hidden');
  },
};
