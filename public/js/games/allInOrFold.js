/**
 * All-In or Fold client module.
 *
 * `aiofAtTable` is local-only state, independent of `currentGame` in main.js — see
 * implementation/all-in-or-fold-plan.md's architecture note. The `aiofState` broadcast is
 * sent to every connected player regardless of whether they're "at the table"; this module
 * only navigates to the table screen when `aiofAtTable` is true, so a player who has left
 * stays on the shared lobby screen even while state keeps arriving in the background.
 */

import { renderScoreboard } from '../shared/scoreboard.js';

const AIOF_SUIT_SYMBOL = { s: '♠', h: '♥', d: '♦', c: '♣' };
const AIOF_SUIT_CLASS = { s: 'aiof-suit-s', h: 'aiof-suit-h', d: 'aiof-suit-d', c: 'aiof-suit-c' };

const AIOF_SEAT_COUNT = 6;

const AIOF_REVEAL_LABELS = {
  revealingHoles: 'Hole Cards',
  revealingFlop: 'Flop',
  revealingTurn: 'Turn',
  revealingRiver: 'River',
};

// Simplified tiered chip stack — not a real denomination breakdown, just a value → (color,
// disc count) lookup so a bigger stack visibly looks bigger and a different color. `max` is
// exclusive; the last tier catches everything at or above its floor.
const AIOF_CHIP_TIERS = [
  { max: 100, cls: 'aiof-chip-disc-tier0', discs: 2 },
  { max: 500, cls: 'aiof-chip-disc-tier1', discs: 3 },
  { max: 1000, cls: 'aiof-chip-disc-tier2', discs: 4 },
  { max: 2000, cls: 'aiof-chip-disc-tier3', discs: 5 },
  { max: Infinity, cls: 'aiof-chip-disc-tier4', discs: 6 },
];

function makeAiofChipStackEl(value) {
  const tier = AIOF_CHIP_TIERS.find((t) => value < t.max) || AIOF_CHIP_TIERS[AIOF_CHIP_TIERS.length - 1];
  const el = document.createElement('span');
  el.className = 'aiof-chip-stack';
  for (let i = 0; i < tier.discs; i++) {
    const disc = document.createElement('span');
    disc.className = `aiof-chip-disc ${tier.cls}`;
    disc.style.bottom = `${i * 0.14}rem`;
    disc.style.zIndex = String(i);
    el.appendChild(disc);
  }
  return el;
}

const aiofSubtitle = document.getElementById('aiof-subtitle');
const aiofSeatsEl = document.getElementById('aiof-seats');
const aiofTableCenter = document.getElementById('aiof-table-center');
const aiofStartBtn = document.getElementById('aiof-start-btn');
const aiofStartWaiting = document.getElementById('aiof-start-waiting');
const aiofBuyinPicker = document.getElementById('aiof-buyin-picker');
const aiofBuyinSlider = document.getElementById('aiof-buyin-slider');
const aiofBuyinValue = document.getElementById('aiof-buyin-value');
const aiofBuyinConfirmBtn = document.getElementById('aiof-buyin-confirm-btn');
const aiofBuyinCancelBtn = document.getElementById('aiof-buyin-cancel-btn');
const aiofRebuySlider = document.getElementById('aiof-rebuy-slider');
const aiofRebuyValue = document.getElementById('aiof-rebuy-value');
const aiofHandPanel = document.getElementById('aiof-hand-panel');
const aiofPot = document.getElementById('aiof-pot');
const aiofBoard = document.getElementById('aiof-board');
const aiofHoleCards = document.getElementById('aiof-hole-cards');
const aiofTurnStatus = document.getElementById('aiof-turn-status');
const aiofDecisionBtns = document.getElementById('aiof-decision-btns');
const aiofAllInBtn = document.getElementById('aiof-allin-btn');
const aiofFoldBtn = document.getElementById('aiof-fold-btn');
const aiofResultsPanel = document.getElementById('aiof-results-panel');
const aiofResultsText = document.getElementById('aiof-results-text');
const aiofNextHandBtn = document.getElementById('aiof-nexthand-btn');
const aiofNextHandWaiting = document.getElementById('aiof-nexthand-waiting');
const aiofWaitingText = document.getElementById('aiof-waiting-text');
const aiofBustPanel = document.getElementById('aiof-bust-panel');
const aiofBustText = document.getElementById('aiof-bust-text');
const aiofBuyInBtn = document.getElementById('aiof-buyin-btn');
const aiofDeclineBuyInBtn = document.getElementById('aiof-declinebuyin-btn');
const aiofEndGameBtn = document.getElementById('aiof-endgame-btn');
const aiofGameoverPanel = document.getElementById('aiof-gameover-panel');
const aiofRankingBody = document.getElementById('aiof-ranking-body');
const aiofScoreboard = document.getElementById('aiof-scoreboard');
const aiofError = document.getElementById('aiof-error');
const aiofLeaveBtn = document.getElementById('aiof-leave-btn');
const aiofBackBtn = document.getElementById('aiof-back-btn');

let ctx = null;
let aiofAtTable = false;
let lastData = null;

function trySitSeat(seatIndex) {
  aiofError.textContent = '';
  ctx.socket.emit('aiofSitSeat', { seatIndex }, (res) => {
    if (res && !res.ok) aiofError.textContent = res.error;
  });
}

function formatAiofCard(code) {
  if (!code) return '??';
  const rank = code.slice(0, -1);
  const suit = code.slice(-1);
  const displayRank = rank === 'T' ? '10' : rank;
  return `${displayRank}${AIOF_SUIT_SYMBOL[suit] || suit}`;
}

function aiofCornerEl(rank, pip, position) {
  const corner = document.createElement('span');
  corner.className = `aiof-card-corner aiof-card-corner-${position}`;
  const rankEl = document.createElement('span');
  rankEl.className = 'aiof-card-rank';
  rankEl.textContent = rank;
  const pipEl = document.createElement('span');
  pipEl.className = 'aiof-card-pip';
  pipEl.textContent = pip;
  corner.appendChild(rankEl);
  corner.appendChild(pipEl);
  return corner;
}

function makeAiofCardEl(code) {
  const el = document.createElement('span');
  el.className = 'aiof-card';
  const rank = code.slice(0, -1) === 'T' ? '10' : code.slice(0, -1);
  const suit = code.slice(-1);
  const pip = AIOF_SUIT_SYMBOL[suit] || suit;
  const suitClass = AIOF_SUIT_CLASS[suit];
  if (suitClass) el.classList.add(suitClass);
  el.appendChild(aiofCornerEl(rank, pip, 'tl'));
  const center = document.createElement('span');
  center.className = 'aiof-card-center';
  center.textContent = pip;
  el.appendChild(center);
  el.appendChild(aiofCornerEl(rank, pip, 'br'));
  el.setAttribute('aria-label', formatAiofCard(code));
  return el;
}

function renderAiofCardRow(container, cards, emptyText) {
  container.innerHTML = '';
  if (!cards || !cards.length) {
    const span = document.createElement('span');
    span.className = 'muted';
    span.textContent = emptyText;
    container.appendChild(span);
    return;
  }
  cards.forEach((code) => container.appendChild(makeAiofCardEl(code)));
}

function formatAiofResults(results) {
  if (!results) return '';
  if (results.uncontested) {
    return `${results.winners[0]} wins the pot uncontested (+${results.potTotal})`;
  }
  const parts = (results.pots || []).map(
    (pot, i) => `Pot ${i + 1} (${pot.amount}): ${pot.winners.join(' & ')}`
  );
  return parts.join(' · ') || 'Hand complete';
}

/** Cards visible at a seat right now: the live hand's revealedHands while a hand is active
 * (null during the 'deciding' stage — see server), falling back to the last hand's
 * results.holeCards during the between-hands pause so the reveal doesn't vanish the instant
 * the pot is awarded. Folded players and pre-reveal hands have nothing to show. */
function seatCardsFor(data, name) {
  if (data.hand && data.hand.revealedHands) return data.hand.revealedHands[name] || null;
  if (!data.hand && data.results) return (data.results.holeCards || {})[name] || null;
  return null;
}

/** Union, across every pot layer, of the hole cards `name` actually used in their best hand
 * — used to highlight those 2-of-6 cards once results are in. Empty/absent outside results. */
function usedCardsFor(results, name) {
  const set = new Set();
  if (!results || !results.pots) return set;
  results.pots.forEach((pot) => {
    (pot.rankings || []).forEach((r) => {
      if (r.name === name) (r.holeUsed || []).forEach((code) => set.add(code));
    });
  });
  return set;
}

/** Colors equity relative to the field, not an absolute threshold: whoever's currently
 * most likely to win shows green, everyone else red — except when two or more players are
 * tied for the lead, in which case those tied leaders show gray instead (ambiguous who's
 * "winning"), while non-leaders stay red. */
function equityTonesFor(equities) {
  const tones = {};
  if (!equities) return tones;
  const entries = Object.entries(equities);
  if (entries.length === 0) return tones;
  const maxPct = Math.max(...entries.map(([, pct]) => pct));
  const leaderCount = entries.filter(([, pct]) => pct === maxPct).length;
  entries.forEach(([name, pct]) => {
    tones[name] = pct === maxPct ? (leaderCount > 1 ? 'even' : 'positive') : 'negative';
  });
  return tones;
}

function renderHand(data) {
  const hand = data.hand;
  const results = data.results;
  aiofHandPanel.classList.toggle('hidden', !hand);
  aiofResultsPanel.classList.toggle('hidden', !(!hand && results));

  // The board stays open in the middle of the table through the results pause (not just
  // while `hand` is live) — cards shouldn't vanish the instant a showdown resolves.
  const boardCards = hand ? hand.board : results ? results.board : null;
  aiofTableCenter.classList.toggle('hidden', !boardCards);
  renderAiofCardRow(aiofBoard, boardCards, 'Not yet revealed');
  aiofPot.classList.toggle('hidden', !hand);

  if (!hand) {
    if (results) aiofResultsText.textContent = formatAiofResults(results);
    const isHost = ctx.getIsHost();
    aiofNextHandBtn.classList.toggle('hidden', !(isHost && data.canDealNextHand));
    aiofNextHandWaiting.classList.toggle('hidden', !(!isHost && data.canDealNextHand));
    return;
  }

  aiofPot.innerHTML = '';
  aiofPot.appendChild(makeAiofChipStackEl(hand.potTotal));
  const potText = document.createElement('span');
  potText.textContent = `Pot: ${hand.potTotal}`;
  aiofPot.appendChild(potText);
  renderAiofCardRow(
    aiofHoleCards,
    hand.myHoleCards,
    data.mySeatIndex >= 0 ? 'You folded — no cards shown' : 'Spectating this hand'
  );

  aiofTurnStatus.textContent =
    hand.stage === 'deciding'
      ? hand.actingName
        ? `${hand.actingName}'s decision`
        : ''
      : `Revealing: ${AIOF_REVEAL_LABELS[hand.stage] || hand.stage}`;

  aiofDecisionBtns.classList.toggle('hidden', !(hand.isMyTurn && hand.stage === 'deciding'));
}

function renderBustPrompt(data) {
  const mySeat = data.mySeatIndex >= 0 ? data.seats[data.mySeatIndex] : null;
  const busted = data.phase === 'playing' && !!mySeat && mySeat.stack === 0;
  aiofBustPanel.classList.toggle('hidden', !busted);
  if (!busted) return;

  aiofBustText.textContent = mySeat.sittingOut
    ? "You're sitting out. Buy back in anytime to rejoin the next hand."
    : "You're out of chips! Rebuy or sit out?";
  aiofDeclineBuyInBtn.classList.toggle('hidden', !!mySeat.sittingOut);

  // Only resets the slider to the default when it isn't the one currently focused — avoids
  // clobbering an in-progress drag every time a broadcast arrives mid-decision.
  if (document.activeElement !== aiofRebuySlider) {
    aiofRebuySlider.value = '150';
    aiofRebuyValue.textContent = aiofRebuySlider.value;
  }
}

/** Pre-Start buy-in slider: only for a seated player before the host clicks Start. Syncs
 * from the server-known stack (their pending buy-in, since nothing's been wagered yet)
 * unless the slider is the currently-focused element, so a live drag isn't overwritten by
 * the next broadcast. */
function renderBuyinPicker(data) {
  const hasSeat = data.mySeatIndex != null && data.mySeatIndex >= 0;
  const show = data.phase === 'seating' && hasSeat;
  aiofBuyinPicker.classList.toggle('hidden', !show);
  if (!show) return;

  if (document.activeElement !== aiofBuyinSlider) {
    const stack = data.seats[data.mySeatIndex].stack;
    aiofBuyinSlider.value = String(stack);
    aiofBuyinValue.textContent = String(stack);
  }
}

function renderGameover(data) {
  aiofGameoverPanel.classList.toggle('hidden', data.phase !== 'gameover');
  if (data.phase !== 'gameover') return;

  aiofRankingBody.innerHTML = '';
  (data.ranking || []).forEach((row) => {
    const tr = document.createElement('tr');
    const netText = row.netProfit > 0 ? `+${row.netProfit}` : `${row.netProfit}`;
    [row.name, row.stack, row.totalBoughtIn, netText, row.points].forEach((value) => {
      const td = document.createElement('td');
      td.textContent = value;
      tr.appendChild(td);
    });
    aiofRankingBody.appendChild(tr);
  });

  renderScoreboard(aiofScoreboard, data.scoreboard || []);
}

function render(data) {
  const isHost = ctx.getIsHost();
  const hasSeat = data.mySeatIndex != null && data.mySeatIndex >= 0;

  aiofSubtitle.textContent =
    data.phase === 'seating' ? 'Pick an open seat, then the host starts the match.' : '';

  // Rotates the table so the viewer's own seat always renders at the bottom slot (slot 0),
  // like a real poker client — everyone sees themselves "sitting" at the same table, just
  // from their own side of it. Spectators (no seat yet) get the unrotated, natural order.
  const rotationOffset = hasSeat ? data.mySeatIndex : 0;
  const actingName = data.hand ? data.hand.actingName : null;
  const foldedNames = data.hand ? data.hand.foldedNames || [] : [];
  const equities = data.hand ? data.hand.equities : null;
  const equityTones = equityTonesFor(equities);

  aiofSeatsEl.innerHTML = '';
  (data.seats || []).forEach((seat, i) => {
    const interactive = !seat && !hasSeat;
    const el = document.createElement(interactive ? 'button' : 'div');
    const slot = (i - rotationOffset + AIOF_SEAT_COUNT) % AIOF_SEAT_COUNT;
    el.className = `aiof-seat aiof-seat-slot-${slot}`;
    if (seat && i === data.dealerSeat) el.classList.add('aiof-seat-dealer');

    if (seat) {
      el.classList.add('aiof-seat-occupied');
      if (seat.sittingOut) el.classList.add('aiof-seat-sitting-out');
      if (seat.name === actingName) el.classList.add('aiof-seat-turn');
      if (foldedNames.includes(seat.name)) el.classList.add('aiof-seat-folded');

      const nameEl = document.createElement('span');
      nameEl.className = 'aiof-seat-name';
      nameEl.textContent = seat.name;
      el.appendChild(nameEl);

      const chipsEl = document.createElement('span');
      chipsEl.className = 'aiof-seat-chips';
      const chipIcon = makeAiofChipStackEl(seat.stack);
      const stackEl = document.createElement('span');
      stackEl.className = 'aiof-seat-stack';
      stackEl.textContent = `${seat.stack}`;
      chipsEl.appendChild(chipIcon);
      chipsEl.appendChild(stackEl);
      el.appendChild(chipsEl);

      const seatCards = seatCardsFor(data, seat.name);
      if (seatCards) {
        el.classList.add('aiof-seat-showing-cards');
        const usedSet = usedCardsFor(data.results, seat.name);
        const cardsEl = document.createElement('span');
        cardsEl.className = 'aiof-seat-cards';
        seatCards.forEach((code) => {
          const cardEl = makeAiofCardEl(code);
          if (usedSet.has(code)) cardEl.classList.add('aiof-card-used');
          cardsEl.appendChild(cardEl);
        });
        el.appendChild(cardsEl);
      }

      // During an active hand's reveal stages, the corner badge shows this seat's live win
      // probability instead of their net win/loss — swaps back once the hand ends (results
      // never carry equities forward, unlike hole cards/board, since river already showed
      // the final 0%/100% split).
      const equityPct = equities ? equities[seat.name] : null;
      const badge = document.createElement('span');
      if (equityPct != null) {
        const tone = equityTones[seat.name] || 'even';
        badge.className = `aiof-seat-net-badge aiof-seat-net-badge-${tone}`;
        badge.textContent = `${equityPct}%`;
      } else {
        const net = seat.netProfit || 0;
        const netTone = net > 0 ? 'positive' : net < 0 ? 'negative' : 'even';
        badge.className = `aiof-seat-net-badge aiof-seat-net-badge-${netTone}`;
        badge.textContent = net > 0 ? `+${net}` : `${net}`;
      }
      el.appendChild(badge);

      if (seat.sittingOut) {
        const outEl = document.createElement('span');
        outEl.className = 'aiof-seat-out-label';
        outEl.textContent = 'sitting out';
        el.appendChild(outEl);
      }
    } else {
      el.textContent = `Seat ${i + 1}`;
      if (interactive) {
        el.type = 'button';
        el.addEventListener('click', () => trySitSeat(i));
      } else {
        el.classList.add('aiof-seat-disabled');
      }
    }

    if (seat && i === data.dealerSeat) {
      const badge = document.createElement('span');
      badge.className = 'aiof-seat-dealer-badge';
      badge.textContent = 'D';
      el.appendChild(badge);
    }

    aiofSeatsEl.appendChild(el);
  });

  aiofStartBtn.classList.toggle('hidden', !(isHost && data.phase === 'seating'));
  aiofStartBtn.disabled = !data.canStart;
  aiofStartWaiting.classList.toggle('hidden', isHost || data.phase !== 'seating');

  renderBuyinPicker(data);
  renderHand(data);
  renderBustPrompt(data);
  aiofWaitingText.classList.toggle('hidden', !data.waitingForPlayers);
  aiofEndGameBtn.classList.toggle('hidden', !(isHost && data.phase === 'playing'));
  aiofEndGameBtn.disabled = !data.canEndGame;
  renderGameover(data);
}

function applyState(data) {
  lastData = data;
  ctx.setHost(data.host);
  aiofError.textContent = '';
  render(data);
  if (!aiofAtTable) return;
  ctx.showScreen('allInOrFold');
}

export const AllInOrFold = {
  init(nextCtx) {
    ctx = nextCtx;
    const { socket } = ctx;

    aiofBackBtn.addEventListener('click', () => {
      socket.emit('backToLobby', () => {});
    });

    aiofLeaveBtn.addEventListener('click', () => {
      aiofError.textContent = '';
      socket.emit('aiofLeaveTable', (res) => {
        if (res && !res.ok) {
          aiofError.textContent = res.error;
          return;
        }
        aiofAtTable = false;
        ctx.showScreen('lobby');
      });
    });

    aiofStartBtn.addEventListener('click', () => {
      aiofError.textContent = '';
      socket.emit('startAllInOrFold', (res) => {
        if (res && !res.ok) aiofError.textContent = res.error;
      });
    });

    aiofBuyinSlider.addEventListener('input', () => {
      aiofBuyinValue.textContent = aiofBuyinSlider.value;
    });

    aiofBuyinConfirmBtn.addEventListener('click', () => {
      aiofError.textContent = '';
      socket.emit('aiofSetBuyIn', { amount: Number(aiofBuyinSlider.value) }, (res) => {
        if (res && !res.ok) aiofError.textContent = res.error;
      });
    });

    aiofBuyinCancelBtn.addEventListener('click', () => {
      if (!lastData || lastData.mySeatIndex < 0) return;
      const stack = lastData.seats[lastData.mySeatIndex].stack;
      aiofBuyinSlider.value = String(stack);
      aiofBuyinValue.textContent = String(stack);
    });

    aiofRebuySlider.addEventListener('input', () => {
      aiofRebuyValue.textContent = aiofRebuySlider.value;
    });

    aiofNextHandBtn.addEventListener('click', () => {
      aiofError.textContent = '';
      socket.emit('aiofNextHand', (res) => {
        if (res && !res.ok) aiofError.textContent = res.error;
      });
    });

    aiofAllInBtn.addEventListener('click', () => {
      aiofError.textContent = '';
      socket.emit('aiofDecision', { decision: 'ALL_IN' }, (res) => {
        if (res && !res.ok) aiofError.textContent = res.error;
      });
    });

    aiofFoldBtn.addEventListener('click', () => {
      aiofError.textContent = '';
      socket.emit('aiofDecision', { decision: 'FOLD' }, (res) => {
        if (res && !res.ok) aiofError.textContent = res.error;
      });
    });

    aiofBuyInBtn.addEventListener('click', () => {
      aiofError.textContent = '';
      socket.emit('aiofBuyIn', { amount: Number(aiofRebuySlider.value) }, (res) => {
        if (res && !res.ok) aiofError.textContent = res.error;
      });
    });

    aiofDeclineBuyInBtn.addEventListener('click', () => {
      aiofError.textContent = '';
      socket.emit('aiofDeclineBuyIn', (res) => {
        if (res && !res.ok) aiofError.textContent = res.error;
      });
    });

    aiofEndGameBtn.addEventListener('click', () => {
      aiofError.textContent = '';
      socket.emit('endAllInOrFoldGame', (res) => {
        if (res && !res.ok) aiofError.textContent = res.error;
      });
    });

    socket.on('aiofState', (data) => {
      applyState(data);
    });
  },

  applyState,

  applyJoin(res) {
    aiofAtTable = true;
    applyState(res);
  },

  /** Called after a successful chooseGame/enterAllInOrFold so the next/cached aiofState navigates. */
  setAtTable(atTable) {
    aiofAtTable = atTable;
    if (atTable && lastData) {
      ctx.showScreen('allInOrFold');
    }
  },

  isAtTable() {
    return aiofAtTable;
  },

  stop() {
    aiofAtTable = false;
    lastData = null;
  },
};
