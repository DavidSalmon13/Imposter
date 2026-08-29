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

const aiofSubtitle = document.getElementById('aiof-subtitle');
const aiofSeatsEl = document.getElementById('aiof-seats');
const aiofTableCenter = document.getElementById('aiof-table-center');
const aiofStartBtn = document.getElementById('aiof-start-btn');
const aiofStartWaiting = document.getElementById('aiof-start-waiting');
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
    return;
  }

  aiofPot.textContent = `Pot: ${hand.potTotal}`;
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
      : `Revealing: ${hand.stage.replace('revealing', '')}`;

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
}

function renderGameover(data) {
  aiofGameoverPanel.classList.toggle('hidden', data.phase !== 'gameover');
  if (data.phase !== 'gameover') return;

  aiofRankingBody.innerHTML = '';
  (data.ranking || []).forEach((row) => {
    const tr = document.createElement('tr');
    const netText = row.netProfit > 0 ? `+${row.netProfit}` : `${row.netProfit}`;
    [row.name, row.stack, netText, row.points].forEach((value) => {
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
      const chipIcon = document.createElement('span');
      chipIcon.className = 'aiof-chip-icon';
      const stackEl = document.createElement('span');
      stackEl.className = 'aiof-seat-stack';
      stackEl.textContent = `${seat.stack}`;
      chipsEl.appendChild(chipIcon);
      chipsEl.appendChild(stackEl);
      el.appendChild(chipsEl);

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
      socket.emit('aiofBuyIn', (res) => {
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
