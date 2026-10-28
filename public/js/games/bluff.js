/**
 * Bluff client module.
 */

import { renderScoreboard } from '../shared/scoreboard.js';
import { confirmDialog } from '../shared/confirmDialog.js';
import { emojiForName } from '../shared/playerEmoji.js';

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
const bfCountWheel = document.getElementById('bf-count-wheel');
const bfStartBtn = document.getElementById('bf-start-btn');
const bfStartWaiting = document.getElementById('bf-start-waiting');
const bfSeatingError = document.getElementById('bf-seating-error');
const bfBackBtn = document.getElementById('bf-back-btn');
const bfTablePanel = document.getElementById('bf-table-panel');
const bfRoundLabel = document.getElementById('bf-round-label');
const bfTableHint = document.getElementById('bf-table-hint');
const bfTableFelt = document.querySelector('.bf-table-felt');
const bfSeatsEl = document.getElementById('bf-seats');
const bfInPlayEl = document.getElementById('bf-in-play');
const bfHandEl = document.getElementById('bf-hand');
const bfTableError = document.getElementById('bf-table-error');
const bfHandHeading = document.getElementById('bf-hand-heading');
const bfSpectatorHands = document.getElementById('bf-spectator-hands');
const bfGameoverPanel = document.getElementById('bf-gameover-panel');
const bfChampion = document.getElementById('bf-champion');
const bfStandings = document.getElementById('bf-standings');
const bfScoreboard = document.getElementById('bf-scoreboard');
const bfResetBtn = document.getElementById('bf-reset-btn');
const bfResetError = document.getElementById('bf-reset-error');
const bfCheckResult = document.getElementById('bf-check-result');
const bfCheckLabel = document.getElementById('bf-check-label');
const bfCheckCountdown = document.getElementById('bf-check-countdown');
const bfCheckCards = document.getElementById('bf-check-cards');
const bfCheckStrongest = document.getElementById('bf-check-strongest');
const bfCheckOpenBtn = document.getElementById('bf-check-open-btn');
const bfCheckOpenLabel = document.getElementById('bf-check-open-label');
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

// Tokens & betting (plans/betting-implementation-plan.md) - Bluff only, inert whenever
// data.betting is null (BETTING_ENABLED off, or this viewer is a guest).
const bfBetBalance = document.getElementById('bf-bet-balance');
const bfOddsBoard = document.getElementById('bf-odds-board');
const bfOddsRows = document.getElementById('bf-odds-rows');
const bfOddsFoot = document.getElementById('bf-odds-foot');
const bfOddsError = document.getElementById('bf-odds-error');
const bfBetOthers = document.getElementById('bf-bet-others');
const bfBetSection = document.getElementById('bf-bet-section');
const bfBetIncoming = document.getElementById('bf-bet-incoming');
const bfBetProposal = document.getElementById('bf-bet-proposal');
const bfBetComposer = document.getElementById('bf-bet-composer');
const bfBetPickRow = document.getElementById('bf-bet-pick-row');
const bfBetStakeSlider = document.getElementById('bf-bet-stake-slider');
const bfBetStakeValue = document.getElementById('bf-bet-stake-value');
const bfBetTargetRow = document.getElementById('bf-bet-target-row');
const bfBetProposeBtn = document.getElementById('bf-bet-propose-btn');
const bfBetMine = document.getElementById('bf-bet-mine');
const bfBetError = document.getElementById('bf-bet-error');

const BF_RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
// Mirrors server/games/bluffHands.js - the server re-validates.
const BF_MAX_CALLED_CARDS = 20;

let ctx = null;
// Starting-count scroll wheel: must match .bf-wheel-item's height in style.css.
const BF_WHEEL_ITEM_PX = 44;
const BF_WHEEL_SETTLE_MS = 160;
let bfWheelBounds = null;
let bfWheelServerValue = null;
let bfWheelSettleTimer = null;
// Only scrolls the host actually caused (touch/wheel/keys/click) get sent to the server -
// layout or programmatic scrolls must never overwrite the pick.
let bfWheelUserScrolled = false;
// Where the wheel is headed - arrow keys step from this, not from a half-finished smooth scroll.
let bfWheelTarget = null;

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

// Betting UI state, kept across re-renders (e.g. the pushBettingViews follow-up
// correction) so an in-progress pick survives every broadcast.
let bfOddsOpenName = null; // odds-board row whose stake picker is open
let bfOddsStake = 50; // chosen stake in that picker
let bfLastSeats = []; // seats from the last render, for picker-driven re-renders
let bfBetPick = null; // chosen loser-pick in the side-bet composer
let bfBetTarget = null; // chosen target name in the side-bet composer, null = open

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

  renderWheelItems(bounds);
  bfCountWheel.classList.toggle('bf-wheel-disabled', !isHost);
  bfCountWheel.tabIndex = isHost ? 0 : -1;
  bfWheelServerValue = data.pendingStartCount || bounds.max;
  // Don't yank the wheel out from under the host's finger mid-scroll.
  if (!bfWheelSettleTimer && !bfWheelUserScrolled) scrollWheelTo(bfWheelServerValue, 'auto');

  bfStartBtn.classList.toggle('hidden', !isHost);
  bfStartBtn.disabled = !data.canStart;
  bfStartWaiting.classList.toggle('hidden', isHost);
}

/** Rebuilds the wheel's numbers only when the allowed range changes (player count moved). */
function renderWheelItems(bounds) {
  if (bfWheelBounds && bfWheelBounds.min === bounds.min && bfWheelBounds.max === bounds.max) return;
  bfWheelBounds = { min: bounds.min, max: bounds.max };
  bfCountWheel.innerHTML = '';
  for (let n = bounds.min; n <= bounds.max; n++) {
    const item = document.createElement('div');
    item.className = 'bf-wheel-item';
    item.setAttribute('role', 'option');
    item.dataset.value = String(n);
    item.textContent = String(n);
    bfCountWheel.appendChild(item);
  }
}

function wheelValueAtScroll() {
  if (!bfWheelBounds) return null;
  const idx = Math.round(bfCountWheel.scrollTop / BF_WHEEL_ITEM_PX);
  return Math.min(bfWheelBounds.max, Math.max(bfWheelBounds.min, bfWheelBounds.min + idx));
}

function markWheelSelected(value) {
  bfCountWheel.querySelectorAll('.bf-wheel-item').forEach((item) => {
    const selected = Number(item.dataset.value) === value;
    item.classList.toggle('bf-wheel-selected', selected);
    item.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
}

function scrollWheelTo(value, behavior) {
  if (!bfWheelBounds) return;
  bfWheelTarget = value;
  bfCountWheel.scrollTo({ top: (value - bfWheelBounds.min) * BF_WHEEL_ITEM_PX, behavior });
  markWheelSelected(value);
}

/** Once the wheel stops moving, the number under the center line is the host's pick. */
function onWheelSettled() {
  bfWheelSettleTimer = null;
  const value = wheelValueAtScroll();
  bfWheelTarget = value;
  if (!bfWheelUserScrolled) {
    // Not the host's doing: snap back to the server's value.
    if (bfWheelServerValue !== null && value !== bfWheelServerValue) scrollWheelTo(bfWheelServerValue, 'auto');
    return;
  }
  bfWheelUserScrolled = false;
  if (value === null || !ctx.getIsHost() || value === bfWheelServerValue) return;
  bfWheelServerValue = value;
  ctx.socket.emit('bfSetStartingCount', { count: value }, (res) => {
    if (res && !res.ok) bfSeatingError.textContent = res.error;
  });
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

/** Places each seat on an oval around the stadium table, seat 0 at the bottom, clockwise -
 * seatCount is fixed for the whole match (bfPlayers never reflows), so this is safe to
 * recompute every render. Each seat shows the player's lobby icon (sticker, or their
 * name-hashed emoji), with the lobby's gold ring when signed in. For the host, tapping
 * any active player's icon marks them as the round's loser - signed in or not, it never
 * opens their player card here. */
function renderBfSeats(seats, { tappable, highlightName } = {}) {
  bfSeatsEl.innerHTML = '';
  const n = seats.length;
  const radiusX = 37;
  const radiusY = 41;
  let inPlay = 0;
  seats.forEach((seat, i) => {
    inPlay += seat.count || 0;
    const angle = (2 * Math.PI * i) / n + Math.PI / 2;
    const left = 50 + radiusX * Math.cos(angle);
    const top = 50 + radiusY * Math.sin(angle);
    const canTap = tappable && !seat.eliminated;

    const seatEl = document.createElement('div');
    seatEl.className = 'bf-seat';
    seatEl.style.left = `${left}%`;
    seatEl.style.top = `${top}%`;
    if (!seat.connected) seatEl.classList.add('bf-seat-offline');
    if (seat.eliminated) seatEl.classList.add('bf-seat-eliminated');
    if (seat.name === highlightName) seatEl.classList.add('bf-seat-highlight');

    const avatar = document.createElement(canTap ? 'button' : 'div');
    avatar.className = 'bf-seat-avatar';
    if (seat.signedIn) avatar.classList.add('bf-seat-avatar-signedin');
    if (canTap) {
      avatar.type = 'button';
      avatar.classList.add('bf-seat-tappable');
      avatar.setAttribute('aria-label', `Mark ${seat.name} as this round's loser`);
      avatar.addEventListener('click', () => trySelectLoser(seat.name));
    }
    if (seat.sticker) {
      const img = document.createElement('img');
      img.src = `images/stickers/${seat.sticker}`;
      img.alt = '';
      avatar.appendChild(img);
    } else {
      const emoji = document.createElement('span');
      emoji.className = 'bf-seat-emoji';
      emoji.textContent = emojiForName(seat.name);
      avatar.appendChild(emoji);
    }
    seatEl.appendChild(avatar);

    const chip = document.createElement('div');
    chip.className = 'bf-seat-chip';
    const count = document.createElement('span');
    count.className = 'bf-seat-count';
    count.textContent = seat.count;
    const name = document.createElement('span');
    name.className = 'bf-seat-name';
    name.textContent = seat.name;
    chip.append(count, name);
    seatEl.appendChild(chip);

    let tag = '';
    if (seat.eliminated) tag = 'Out';
    else if (seat.name === highlightName) tag = '−1 card';
    else if (!seat.connected) tag = 'Offline';
    if (tag) {
      const tagEl = document.createElement('span');
      tagEl.className = 'bf-seat-tag';
      tagEl.textContent = tag;
      seatEl.appendChild(tagEl);
    }

    bfSeatsEl.appendChild(seatEl);
  });
  if (bfInPlayEl) bfInPlayEl.textContent = inPlay;
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

function bfMakeStaticChip(text, extraClass) {
  const span = document.createElement('span');
  span.className = `bf-chip bf-chip-static${extraClass ? ` ${extraClass}` : ''}`;
  span.textContent = text;
  return span;
}

/** One chip per called card, green if it was there and red if it wasn't - repeats of the
 * same value can split across both (e.g. calling three 7s with only two on the table marks
 * the first two present and the third missing). */
function renderCheckCards(perCard) {
  bfCheckCards.innerHTML = '';
  if (!perCard || !perCard.length) {
    bfCheckCards.classList.add('hidden');
    return;
  }
  perCard.forEach(({ rank, present }) => {
    bfCheckCards.appendChild(
      bfMakeStaticChip(bfRankText(rank), present ? 'bf-chip-present' : 'bf-chip-missing')
    );
  });
  bfCheckCards.classList.remove('hidden');
}

/** The best pair/two pair/set/full house/four of a kind sitting across every active
 * player's cards pooled together, regardless of what was actually called. */
function renderCheckStrongest(strongest) {
  bfCheckStrongest.textContent = strongest
    ? `Strongest hand: ${strongest.label}`
    : 'No pairs on the table right now.';
  bfCheckStrongest.classList.remove('hidden');
}

/** Shows the called cards, a 3-2-1 countdown, then which were there (and which weren't)
 * plus the strongest hand sitting on the table. */
function applyCheck(check) {
  if (!check) {
    stopCheckCountdown();
    bfCheckShownId = null;
    bfCheckResult.classList.add('hidden');
    bfCheckCards.classList.add('hidden');
    bfCheckCards.innerHTML = '';
    bfCheckStrongest.classList.add('hidden');
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

  if (check.present === null) {
    bfCheckCards.classList.add('hidden');
    bfCheckStrongest.classList.add('hidden');
  } else {
    renderCheckCards(check.perCard);
    renderCheckStrongest(check.strongest);
  }
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

// --- Tokens & betting (plans/betting-implementation-plan.md section 5) ---

let lastBettingData = null;

const BF_ODDS_QUICK_STAKES = [10, 50, 100];

/** "x2.7" for a 3-player window - mirrors resolveGlobalBets' stake * eligible * (1 - edge). */
function bfPayoutMultiplier(win, houseEdge) {
  const mult = win.eligible.length * (1 - houseEdge);
  return `×${Number.isInteger(mult) ? mult : mult.toFixed(1)}`;
}

/** Stake options for the expanded row: the quick amounts this balance covers, plus all-in. */
function bfOddsStakeOptions(balance, minStake) {
  const options = BF_ODDS_QUICK_STAKES.filter((v) => v >= minStake && v < balance);
  if (balance >= minStake) options.push(balance);
  return options;
}

function bfOddsStakeLabel(value, balance) {
  return value === balance ? `All ${value}` : String(value);
}

/** The inline stake picker under the row being backed - quick stakes, then Cancel/Place. */
function bfOddsPicker(win, name, balance, minStake) {
  const options = bfOddsStakeOptions(balance, minStake);
  if (!options.includes(bfOddsStake)) bfOddsStake = options.includes(50) ? 50 : options[0];

  const picker = document.createElement('div');
  picker.className = 'bf-odds-picker';
  const stakes = document.createElement('div');
  stakes.className = 'bf-odds-stakes';
  options.forEach((value) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `bf-odds-stake${value === bfOddsStake ? ' selected' : ''}`;
    chip.textContent = bfOddsStakeLabel(value, balance);
    chip.addEventListener('click', () => {
      bfOddsStake = value;
      renderOddsBoard(lastBettingData, bfLastSeats);
    });
    stakes.appendChild(chip);
  });
  picker.appendChild(stakes);

  const houseEdge = lastBettingData.houseEdge || 0;
  const payout = Math.floor(bfOddsStake * win.eligible.length * (1 - houseEdge));
  const actions = document.createElement('div');
  actions.className = 'bf-odds-actions';
  const summary = document.createElement('p');
  summary.className = 'bf-odds-summary';
  summary.textContent = `Pays ${payout} if ${name} wins`;
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'secondary';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => {
    bfOddsOpenName = null;
    renderOddsBoard(lastBettingData, bfLastSeats);
  });
  const place = document.createElement('button');
  place.type = 'button';
  place.textContent = `Place ${bfOddsStake}`;
  place.addEventListener('click', () => {
    place.disabled = true;
    bfOddsError.textContent = '';
    ctx.socket.emit('betPlaceGlobal', { trigger: win.trigger, pick: name, stake: bfOddsStake }, (res) => {
      if (res && !res.ok) {
        bfOddsError.textContent = res.error;
        place.disabled = false;
        return;
      }
      bfOddsOpenName = null;
    });
  });
  actions.append(summary, cancel, place);
  picker.appendChild(actions);
  return picker;
}

/**
 * The odds board: every seat ranked by cards left, what a match-winner bet on them pays,
 * and a Back button that opens a stake picker on that row. Replaces a pop-up offer, so
 * there's nothing to dismiss and lose - the board stays put while a window is open to
 * this viewer (match start, or their own elimination), and doubles as a card-count
 * standings view after they've bet.
 */
function renderOddsBoard(betting, seats) {
  bfLastSeats = seats;
  const win = (betting.openGlobalWindows || [])[0] || null;
  const { balance, minStake } = betting;
  const canAfford = balance >= minStake;
  if (!win || !win.eligible.includes(bfOddsOpenName) || !canAfford) bfOddsOpenName = null;

  const backedTotals = {};
  (betting.myGlobalBets || []).forEach((bet) => {
    backedTotals[bet.pick] = (backedTotals[bet.pick] || 0) + bet.stake;
  });

  const ranked = seats.slice().sort((a, b) => (a.eliminated - b.eliminated) || (b.count - a.count));
  bfOddsRows.innerHTML = '';
  ranked.forEach((seat) => {
    const eligible = !!win && win.eligible.includes(seat.name);
    const row = document.createElement('div');
    row.className = 'bf-odds-row';
    if (seat.eliminated) row.classList.add('bf-odds-out');
    if (seat.name === bfOddsOpenName) row.classList.add('bf-odds-open');

    const who = document.createElement('span');
    who.className = 'bf-odds-who';
    const name = document.createElement('span');
    name.className = 'bf-odds-name';
    name.textContent = seat.name;
    who.appendChild(name);
    if (backedTotals[seat.name]) {
      const mine = document.createElement('span');
      mine.className = 'bf-odds-mine';
      mine.textContent = `🎲 ${backedTotals[seat.name]}`;
      who.appendChild(mine);
    }
    const cards = document.createElement('span');
    cards.className = 'bf-odds-cards';
    cards.textContent = seat.eliminated ? 'Out' : String(seat.count);
    const pays = document.createElement('span');
    pays.className = 'bf-odds-pays';
    pays.textContent = eligible ? bfPayoutMultiplier(win, betting.houseEdge || 0) : '—';
    row.append(who, cards, pays);

    if (eligible) {
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'bf-odds-back';
      back.textContent = 'Back';
      back.disabled = !canAfford;
      back.addEventListener('click', () => {
        bfOddsOpenName = bfOddsOpenName === seat.name ? null : seat.name;
        bfOddsError.textContent = '';
        renderOddsBoard(lastBettingData, bfLastSeats);
      });
      row.appendChild(back);
    } else {
      row.appendChild(document.createElement('span'));
    }
    bfOddsRows.appendChild(row);
    if (seat.name === bfOddsOpenName) bfOddsRows.appendChild(bfOddsPicker(win, seat.name, balance, minStake));
  });

  if (win && !canAfford) {
    bfOddsFoot.textContent = `You have ${balance} tokens — the minimum bet is ${minStake}.`;
  } else if (win && win.trigger === 'start') {
    bfOddsFoot.textContent = 'Back who wins the match. One bet per match, open until it ends.';
  } else if (win) {
    bfOddsFoot.textContent = "You're out — back who wins from here.";
  } else {
    bfOddsFoot.textContent = Object.keys(backedTotals).length ? '' : 'No match-winner bet open to you.';
  }
  bfOddsFoot.classList.toggle('hidden', !bfOddsFoot.textContent);
  bfOddsBoard.classList.remove('hidden');
}

/** Proposals this viewer could accept - targeted at them, or open to the table. */
function renderIncomingOffers(offers) {
  bfBetIncoming.innerHTML = '';
  offers.forEach((offer) => {
    const row = document.createElement('div');
    row.className = 'bf-bet-offer';
    const text = document.createElement('p');
    text.textContent = `${offer.bettorName} bets ${offer.stake} tokens that ${offer.pick} loses this round`;
    row.appendChild(text);
    const acceptBtn = document.createElement('button');
    acceptBtn.type = 'button';
    acceptBtn.textContent = 'Accept';
    acceptBtn.addEventListener('click', () => {
      bfBetError.textContent = '';
      ctx.socket.emit('betAcceptSide', { proposalId: offer.id }, (res) => {
        if (res && !res.ok) bfBetError.textContent = res.error;
      });
    });
    row.appendChild(acceptBtn);
    bfBetIncoming.appendChild(row);
  });
}

/** The side-bet composer: pick who loses, a stake, and an optional target. Hidden
 * while this viewer already has an unaccepted proposal open (server allows only one). */
function renderComposer(seats, minStake, balance) {
  const active = seats.filter((s) => !s.eliminated);
  const myName = ctx.getMyName();

  if (bfBetPick && !active.some((s) => s.name === bfBetPick)) bfBetPick = null;
  const targetable = active.filter((s) => s.signedIn && s.name !== myName);
  if (bfBetTarget && !targetable.some((s) => s.name === bfBetTarget)) bfBetTarget = null;

  bfBetPickRow.innerHTML = '';
  active.forEach((seat) => {
    const chip = bfMakeChip(seat.name, () => {
      bfBetPick = seat.name;
      renderComposer(seats, minStake, balance);
    }, seat.name === bfBetPick ? 'selected' : '');
    bfBetPickRow.appendChild(chip);
  });

  bfBetTargetRow.innerHTML = '';
  const openChip = bfMakeChip('Open to the table', () => {
    bfBetTarget = null;
    renderComposer(seats, minStake, balance);
  }, bfBetTarget === null ? 'selected' : '');
  bfBetTargetRow.appendChild(openChip);
  targetable.forEach((seat) => {
    const chip = bfMakeChip(seat.name, () => {
      bfBetTarget = seat.name;
      renderComposer(seats, minStake, balance);
    }, seat.name === bfBetTarget ? 'selected' : '');
    bfBetTargetRow.appendChild(chip);
  });

  const canAfford = balance >= minStake;
  bfBetStakeSlider.min = String(minStake);
  bfBetStakeSlider.max = String(Math.max(minStake, balance));
  bfBetStakeSlider.step = String(minStake);
  bfBetStakeSlider.disabled = !canAfford;
  if (Number(bfBetStakeSlider.value) < minStake) bfBetStakeSlider.value = String(minStake);
  bfBetStakeValue.textContent = bfBetStakeSlider.value;

  bfBetProposeBtn.disabled = !bfBetPick || !canAfford;
}

/** Waiting-for-acceptance status for this viewer's own open proposal, if any - the
 * composer is hidden while one is open (the server allows only one at a time). */
function renderMyProposal(proposal, seats, minStake, balance) {
  if (proposal) {
    bfBetProposal.classList.remove('hidden');
    bfBetComposer.classList.add('hidden');
    bfBetProposal.innerHTML = '';
    const text = document.createElement('p');
    text.textContent = proposal.targetName
      ? `Waiting for ${proposal.targetName} to accept your ${proposal.stake}-token bet on ${proposal.pick}…`
      : `Waiting for someone to accept your ${proposal.stake}-token bet on ${proposal.pick}…`;
    bfBetProposal.appendChild(text);
    return;
  }
  bfBetProposal.classList.add('hidden');
  bfBetComposer.classList.remove('hidden');
  renderComposer(seats, minStake, balance);
}

/** Bets already placed/accepted - a quick confirmation list, not a full history. */
function renderMyBets(globalBets, sideBets) {
  bfBetMine.innerHTML = '';
  globalBets.forEach((bet) => {
    const li = document.createElement('li');
    const label = bet.trigger === 'start' ? 'to win the match' : 'to win from here';
    li.textContent = `🎲 ${bet.stake} tokens on ${bet.pick} ${label}`;
    bfBetMine.appendChild(li);
  });
  sideBets.forEach((bet) => {
    const li = document.createElement('li');
    const vs = bet.opponentName ? ` vs. ${bet.opponentName}` : '';
    li.textContent = `🤝 ${bet.stake} tokens that ${bet.pick} loses this round${vs}`;
    bfBetMine.appendChild(li);
  });
}

/** Ambient view for eliminated spectators: every other eliminated player's bets (see
 * betting-specs.md "Who can see whose bets") - empty, and the block hidden, otherwise. */
function renderOthersBets(others) {
  if (!others.length) {
    bfBetOthers.classList.add('hidden');
    return;
  }
  bfBetOthers.classList.remove('hidden');
  bfBetOthers.innerHTML = '';
  const heading = document.createElement('p');
  heading.textContent = "Other spectators' bets:";
  bfBetOthers.appendChild(heading);
  others.forEach((bet) => {
    const p = document.createElement('p');
    if (bet.kind === 'global') {
      p.textContent = `${bet.bettorName}: ${bet.stake} tokens on ${bet.pick}`;
    } else {
      p.textContent = `${bet.bettorName} vs. ${bet.opponentName}: ${bet.stake} tokens on ${bet.pick} to lose`;
    }
    bfBetOthers.appendChild(p);
  });
}

/** Everything betting-shaped on the table screen - inert (hidden, no-op) whenever
 * `betting` is null (BETTING_ENABLED off, or this viewer is a guest). */
function renderBetting(betting, seats) {
  // `undefined` means "this frame carried no betting info" - a synchronous broadcast that
  // precedes the pushBettingViews follow-up (server omits the key, see bluffStatePayload).
  // Leave the current betting UI (and any open stake picker) exactly as-is; tearing it down
  // and rebuilding it on every broadcast would wipe the player's in-progress pick/stake.
  // `null` (betting off, or a guest) still falls through to the hide path below.
  if (betting === undefined) return;
  lastBettingData = betting;
  if (!betting) {
    bfBetBalance.classList.add('hidden');
    bfBetSection.classList.add('hidden');
    bfBetOthers.classList.add('hidden');
    bfOddsBoard.classList.add('hidden');
    bfOddsOpenName = null;
    return;
  }

  bfBetBalance.classList.remove('hidden');
  bfBetBalance.textContent = `🪙 ${betting.balance} token${betting.balance === 1 ? '' : 's'}`;

  renderOddsBoard(betting, seats || []);

  bfBetSection.classList.remove('hidden');
  renderIncomingOffers(betting.incomingSideOffers || []);
  renderMyProposal(betting.mySideProposal, seats || [], betting.minStake, betting.balance);
  renderMyBets(betting.myGlobalBets || [], betting.mySideBets || []);
  renderOthersBets(betting.visibleOthersBets || []);
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
  bfCheckOpenLabel.textContent = data.check ? 'Check other cards' : 'Check the called cards';
  bfCheckBuilder.classList.toggle('hidden', !canCheck || !bfBuilderOpen);

  renderHandOrSpectator(data);
  renderBetting(data.betting, data.seats);
}

/** Eliminated players have no hand of their own - instead they see every active player's
 * cards, since there's nothing left for them to bluff about. */
function renderHandOrSpectator(data) {
  bfHandEl.innerHTML = '';
  bfSpectatorHands.innerHTML = '';

  if (data.isSpectator) {
    bfHandHeading.textContent = "You're out — spectating";
    bfHandEl.classList.add('hidden');
    bfSpectatorHands.classList.remove('hidden');
    (data.allHands || []).forEach((hand) => {
      const row = document.createElement('div');
      row.className = 'bf-spectator-row';
      const name = document.createElement('p');
      name.className = 'bf-spectator-name';
      name.textContent = hand.name;
      row.appendChild(name);
      const cards = document.createElement('div');
      cards.className = 'mf-card-row bf-hand';
      bfSortCards(hand.cards).forEach((card) => cards.appendChild(makeBfCardEl(card)));
      row.appendChild(cards);
      bfSpectatorHands.appendChild(row);
    });
    return;
  }

  bfHandHeading.textContent = 'Your hand';
  bfHandEl.classList.remove('hidden');
  bfSpectatorHands.classList.add('hidden');
  if (!data.myHand) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No hand this round';
    bfHandEl.appendChild(empty);
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
    renderBetting(null, []);
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

    bfCountWheel.addEventListener('scroll', () => {
      markWheelSelected(wheelValueAtScroll());
      clearTimeout(bfWheelSettleTimer);
      bfWheelSettleTimer = setTimeout(onWheelSettled, BF_WHEEL_SETTLE_MS);
    });

    ['pointerdown', 'touchstart', 'wheel'].forEach((type) => {
      bfCountWheel.addEventListener(type, () => { bfWheelUserScrolled = true; }, { passive: true });
    });

    // The wheel can't scroll while its screen is hidden, so position it once it has a size.
    new ResizeObserver(() => {
      if (bfCountWheel.clientHeight && bfWheelServerValue !== null && !bfWheelSettleTimer) {
        scrollWheelTo(bfWheelServerValue, 'auto');
      }
    }).observe(bfCountWheel);

    bfCountWheel.addEventListener('click', (e) => {
      const item = e.target.closest('.bf-wheel-item');
      if (!item || !ctx.getIsHost()) return;
      bfWheelUserScrolled = true;
      scrollWheelTo(Number(item.dataset.value), 'smooth');
    });

    bfCountWheel.addEventListener('keydown', (e) => {
      if (!ctx.getIsHost() || !bfWheelBounds) return;
      const delta = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
      if (!delta) return;
      e.preventDefault();
      bfWheelUserScrolled = true;
      const next = Math.min(bfWheelBounds.max, Math.max(bfWheelBounds.min, (bfWheelTarget ?? wheelValueAtScroll()) + delta));
      scrollWheelTo(next, 'smooth');
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

    bfBetStakeSlider.addEventListener('input', () => {
      bfBetStakeValue.textContent = bfBetStakeSlider.value;
    });

    bfBetProposeBtn.addEventListener('click', () => {
      if (!bfBetPick) return;
      bfBetError.textContent = '';
      socket.emit(
        'betProposeSide',
        { pick: bfBetPick, stake: Number(bfBetStakeSlider.value), targetName: bfBetTarget },
        (res) => {
          if (res && !res.ok) {
            bfBetError.textContent = res.error;
            return;
          }
          bfBetPick = null;
          bfBetTarget = null;
        }
      );
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
    lastBettingData = null;
    bfOddsOpenName = null;
    bfLastSeats = [];
    if (bfOddsBoard) bfOddsBoard.classList.add('hidden');
    if (bfOddsError) bfOddsError.textContent = '';
    bfBetPick = null;
    bfBetTarget = null;
    if (bfBetError) bfBetError.textContent = '';
  },
};
