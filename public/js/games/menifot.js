/**
 * Menifot client module — extracted from public/client.js.
 */

import { renderScoreboard } from '../shared/scoreboard.js';

const MF_SUIT_SYMBOL = { s: '♠', h: '♥', d: '♦', c: '♣' };
const MF_SUIT_CLASS = { s: 'mf-suit-s', h: 'mf-suit-h', d: 'mf-suit-d', c: 'mf-suit-c' };
// Mirrors MF_TARGET_SCORE in server/games/menifot.js (only used to draw the race bars).
const MF_TARGET_SCORE = 10;
const MF_RANK_ORDER = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  T: 10, J: 11, Q: 12, K: 13, A: 14,
};

const mfTitle = document.getElementById('mf-title');
const mfSubtitle = document.getElementById('mf-subtitle');
const mfScores = document.getElementById('mf-scores');
const mfReadyPanel = document.getElementById('mf-ready-panel');
const mfPlayerList = document.getElementById('mf-player-list');
const mfStartBtn = document.getElementById('mf-start-btn');
const mfStartWaiting = document.getElementById('mf-start-waiting');
const mfReadyError = document.getElementById('mf-ready-error');
const mfAllocPanel = document.getElementById('mf-alloc-panel');
const mfBoards = document.getElementById('mf-boards');
const mfHand = document.getElementById('mf-hand');
const mfAllocHint = document.getElementById('mf-alloc-hint');
const mfUnassignBtn = document.getElementById('mf-unassign-btn');
const mfLockedBadge = document.getElementById('mf-locked-badge');
const mfLockStatus = document.getElementById('mf-lock-status');
const mfLockBtn = document.getElementById('mf-lock-btn');
const mfLockWaiting = document.getElementById('mf-lock-waiting');
const mfAllocError = document.getElementById('mf-alloc-error');
const mfResultsPanel = document.getElementById('mf-results-panel');
const mfResultsBody = document.getElementById('mf-results-body');
const mfNextBtn = document.getElementById('mf-next-btn');
const mfNextWaiting = document.getElementById('mf-next-waiting');
const mfGameoverPanel = document.getElementById('mf-gameover-panel');
const mfChampion = document.getElementById('mf-champion');
const mfStandings = document.getElementById('mf-standings');
const mfFinalRound = document.getElementById('mf-final-round');
const mfScoreboard = document.getElementById('mf-scoreboard');
const mfPlayAgainBtn = document.getElementById('mf-play-again-btn');
const mfPlayAgainWaiting = document.getElementById('mf-play-again-waiting');
const mfBackBtn = document.getElementById('mf-back-btn');
const mfError = document.getElementById('mf-error');

let ctx = null;
let mfSelectedCard = null;
let mfAllocData = null;

function formatMfCard(code) {
  if (!code) return '?';
  const rank = code.slice(0, -1);
  const suit = code.slice(-1);
  const displayRank = rank === 'T' ? '10' : rank;
  return `${displayRank}${MF_SUIT_SYMBOL[suit] || suit}`;
}

function mfCardSuitClass(code) {
  const suit = code && code.slice(-1);
  return MF_SUIT_CLASS[suit] || '';
}

function mfCardRankValue(code) {
  const rank = code && code.slice(0, -1);
  return MF_RANK_ORDER[rank] || 0;
}

function mfSortCards(cards) {
  return (cards || []).slice().sort((a, b) => mfCardRankValue(a) - mfCardRankValue(b));
}

function mfCornerEl(rank, pip, position) {
  const corner = document.createElement('span');
  corner.className = `mf-card-corner mf-card-corner-${position}`;
  const rankEl = document.createElement('span');
  rankEl.className = 'mf-card-rank';
  rankEl.textContent = rank;
  const pipEl = document.createElement('span');
  pipEl.className = 'mf-card-pip';
  pipEl.textContent = pip;
  corner.appendChild(rankEl);
  corner.appendChild(pipEl);
  return corner;
}

function makeMfCardEl(code, { hidden = false, selected = false, interactive = false, outcome = null } = {}) {
  const el = document.createElement(interactive ? 'button' : 'span');
  if (interactive) {
    el.type = 'button';
    el.className = 'mf-card mf-card-btn';
  } else {
    el.className = 'mf-card';
  }
  if (hidden) {
    el.classList.add('hidden-card');
  } else {
    const rank = code ? (code.slice(0, -1) === 'T' ? '10' : code.slice(0, -1)) : '?';
    const suit = code ? code.slice(-1) : '';
    const pip = MF_SUIT_SYMBOL[suit] || suit;
    const suitClass = mfCardSuitClass(code);
    if (suitClass) el.classList.add(suitClass);
    el.appendChild(mfCornerEl(rank, pip, 'tl'));
    const center = document.createElement('span');
    center.className = 'mf-card-center';
    center.textContent = pip;
    el.appendChild(center);
    el.appendChild(mfCornerEl(rank, pip, 'br'));
    el.setAttribute('aria-label', formatMfCard(code));
  }
  if (selected) el.classList.add('selected');
  if (outcome === 'win') el.classList.add('mf-card-win');
  else if (outcome === 'lose') el.classList.add('mf-card-lose');
  return el;
}

function renderMfScoresLine(scores, players, { awarded = null } = {}) {
  mfScores.innerHTML = '';
  const list = players || [];
  if (!list.length) return;
  const myName = ctx.getMyName();
  const totals = list.map((n) => (scores && scores[n] != null ? scores[n] : 0));
  const top = Math.max(...totals);
  list.forEach((n, i) => {
    const total = totals[i];
    const seat = document.createElement('div');
    seat.className = 'mf-sb-seat';
    if (n === myName) seat.classList.add('mf-sb-me');
    if (top > 0 && total === top) seat.classList.add('mf-sb-leader');

    const avatar = document.createElement('span');
    avatar.className = `mf-sb-avatar mf-sb-tone${i % 6}`;
    avatar.textContent = (n || '?').trim().charAt(0).toUpperCase();
    seat.appendChild(avatar);

    const name = document.createElement('span');
    name.className = 'mf-sb-name';
    name.textContent = n;
    seat.appendChild(name);

    const score = document.createElement('span');
    score.className = 'mf-sb-score';
    score.textContent = total;
    seat.appendChild(score);

    if (awarded && awarded[n]) {
      const gain = document.createElement('span');
      gain.className = 'mf-sb-gain';
      gain.textContent = `+${awarded[n]}`;
      seat.appendChild(gain);
    }

    const track = document.createElement('span');
    track.className = 'mf-sb-track';
    const fill = document.createElement('span');
    fill.className = 'mf-sb-fill';
    fill.style.width = `${Math.min(100, (total / MF_TARGET_SCORE) * 100)}%`;
    track.appendChild(fill);
    seat.appendChild(track);

    mfScores.appendChild(seat);
  });
}

function boardIndexForCard(allocation, card, boardCount) {
  for (let i = 0; i < boardCount; i++) {
    if ((allocation[i] || allocation[String(i)] || []).includes(card)) return i;
  }
  return -1;
}

function mfBoardLimits(totalCards, boardCount) {
  const lo = Math.floor(totalCards / boardCount);
  const hi = Math.ceil(totalCards / boardCount);
  const hiSlots = totalCards % boardCount;
  return { lo, hi, hiSlots };
}

function mfCountsFeasible(counts, totalCards) {
  const boardCount = counts.length;
  if (boardCount < 1) return false;
  const { lo, hi, hiSlots } = mfBoardLimits(totalCards, boardCount);
  if (counts.some((c) => c < 0 || c > hi)) return false;
  const assigned = counts.reduce((a, b) => a + b, 0);
  if (assigned > totalCards) return false;
  const unassigned = totalCards - assigned;
  if (hi > lo) {
    const atHi = counts.filter((c) => c >= hi).length;
    if (atHi > hiSlots) return false;
  }
  const maxPlaceable = counts.reduce((s, c) => s + (hi - c), 0);
  if (unassigned > maxPlaceable) return false;
  let minNeeded = 0;
  for (const c of counts) {
    if (c < lo) minNeeded += lo - c;
  }
  if (minNeeded > unassigned) return false;
  return true;
}

function mfAllocationCountsClient(allocation, boardCount) {
  const counts = [];
  for (let i = 0; i < boardCount; i++) {
    counts.push((allocation[i] || allocation[String(i)] || []).length);
  }
  return counts;
}

/** Would assigning `card` onto `boardIndex` (-1 = unassign) stay within the ±1 rule? */
function mfCanAssignClient(myHand, boardCount, card, boardIndex) {
  if (!myHand || myHand.locked) return false;
  const nextCounts = Array.from({ length: boardCount }, () => 0);
  for (let i = 0; i < boardCount; i++) {
    for (const c of myHand.allocation[i] || myHand.allocation[String(i)] || []) {
      if (c !== card) nextCounts[i] += 1;
    }
  }
  if (boardIndex !== null && boardIndex !== undefined && boardIndex !== -1) {
    nextCounts[boardIndex] += 1;
  }
  return mfCountsFeasible(nextCounts, myHand.cards.length);
}

function mfSelectCard(card) {
  if (!mfAllocData || !mfAllocData.myHand || mfAllocData.myHand.locked) return;
  mfSelectedCard = mfSelectedCard === card ? null : card;
  mfAllocError.textContent = '';
  renderMfAllocating(mfAllocData);
}

function mfTryAssignToBoard(boardIndex) {
  if (!mfSelectedCard || !mfAllocData || !mfAllocData.myHand || mfAllocData.myHand.locked) return;
  if (!mfCanAssignClient(mfAllocData.myHand, mfAllocData.boardCount || 2, mfSelectedCard, boardIndex)) {
    return;
  }
  mfAllocError.textContent = '';
  const card = mfSelectedCard;
  ctx.socket.emit('mfAssignCard', { card, boardIndex }, (res) => {
    if (res && !res.ok) mfAllocError.textContent = res.error;
    else mfSelectedCard = null;
  });
}

function mfTryRevealCard(boardIndex, part) {
  if (!ctx.getIsHost()) return;
  mfAllocError.textContent = '';
  ctx.socket.emit('mfRevealCard', { boardIndex, part }, (res) => {
    if (res && !res.ok) mfAllocError.textContent = res.error;
  });
}

function renderMfAllocating(data) {
  mfAllocData = data;
  const boardCount = data.boardCount || 2;
  const locked = !!(data.myHand && data.myHand.locked);
  const inMatch = !!data.inMatch;
  const myHand = data.myHand;
  const allocation = (myHand && myHand.allocation) || {};
  const isHost = ctx.getIsHost();
  const myName = ctx.getMyName();

  if (mfSelectedCard && myHand && !myHand.cards.includes(mfSelectedCard)) {
    mfSelectedCard = null;
  }
  if (locked) mfSelectedCard = null;

  const selectedAssigned =
    mfSelectedCard != null ? boardIndexForCard(allocation, mfSelectedCard, boardCount) : -1;

  const revealing = mfAllLocked(data);

  mfAllocHint.classList.toggle('hidden', !revealing && (locked || !inMatch));
  mfAllocHint.textContent = revealing
    ? isHost
      ? 'Tap the face-down cards to reveal turn & river, one board at a time.'
      : 'Waiting for the host to reveal the boards…'
    : mfSelectedCard
      ? selectedAssigned >= 0
        ? 'Tap a board to move it, or Unassign to return it to your hand.'
        : 'Tap a board to assign the selected card.'
      : 'Tap a card, then tap a board. Tap Unassign to pull it back.';

  mfBoards.innerHTML = '';
  for (let i = 0; i < boardCount; i++) {
    const board = (data.boards && data.boards[i]) || {
      flop: [],
      turn: null,
      river: null,
      turnRevealed: false,
      riverRevealed: false,
    };
    const wrap = document.createElement('div');
    wrap.className = 'mf-board';
    const canAccept =
      !locked &&
      inMatch &&
      mfSelectedCard &&
      mfCanAssignClient(myHand, boardCount, mfSelectedCard, i);
    if (mfSelectedCard && !locked && inMatch && !canAccept) {
      wrap.classList.add('mf-board-disabled');
    } else if (canAccept) {
      wrap.classList.add('mf-board-target');
    }

    const title = document.createElement('p');
    title.className = 'mf-board-title';
    const hole = allocation[i] || allocation[String(i)] || [];
    title.textContent = `Board ${i + 1}${hole.length ? ` · ${hole.length} of yours` : ''}`;
    wrap.appendChild(title);

    const community = document.createElement('div');
    community.className = 'mf-card-row';
    (board.flop || []).forEach((c) => community.appendChild(makeMfCardEl(c)));

    const canRevealTurn = revealing && isHost && !board.turnRevealed;
    const turnEl = makeMfCardEl(board.turn, {
      hidden: !board.turnRevealed,
      interactive: canRevealTurn,
    });
    if (canRevealTurn) {
      turnEl.addEventListener('click', (e) => {
        e.stopPropagation();
        mfTryRevealCard(i, 'turn');
      });
    }
    community.appendChild(turnEl);

    const canRevealRiver = revealing && isHost && board.turnRevealed && !board.riverRevealed;
    const riverEl = makeMfCardEl(board.river, {
      hidden: !board.riverRevealed,
      interactive: canRevealRiver,
    });
    if (canRevealRiver) {
      riverEl.addEventListener('click', (e) => {
        e.stopPropagation();
        mfTryRevealCard(i, 'river');
      });
    }
    community.appendChild(riverEl);
    wrap.appendChild(community);

    const holeLabel = document.createElement('p');
    holeLabel.className = 'mf-hole-label';
    holeLabel.textContent = locked ? 'Your cards (locked)' : 'Your cards';
    wrap.appendChild(holeLabel);

    const holeRow = document.createElement('div');
    holeRow.className = 'mf-card-row mf-hole-row';
    if (hole.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'muted mf-hole-empty';
      empty.textContent = '—';
      holeRow.appendChild(empty);
    } else {
      mfSortCards(hole).forEach((card) => {
        const el = makeMfCardEl(card, {
          selected: mfSelectedCard === card,
          interactive: inMatch && !locked,
        });
        if (inMatch && !locked) {
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            mfSelectCard(card);
          });
        }
        holeRow.appendChild(el);
      });
    }
    wrap.appendChild(holeRow);

    if (!locked && inMatch) {
      wrap.addEventListener('click', () => mfTryAssignToBoard(i));
    }
    mfBoards.appendChild(wrap);
  }

  mfHand.innerHTML = '';
  if (!inMatch) {
    mfHand.innerHTML = '<p class="muted">Spectating this match</p>';
  } else if (!myHand) {
    mfHand.innerHTML = '<p class="muted">No hand</p>';
  } else {
    const unassigned = myHand.cards.filter(
      (c) => boardIndexForCard(allocation, c, boardCount) < 0
    );
    if (unassigned.length === 0) {
      const done = document.createElement('p');
      done.className = 'muted';
      done.textContent = locked
        ? 'All cards assigned (locked).'
        : 'All cards assigned — tap Lock when ready.';
      mfHand.appendChild(done);
    } else {
      const row = document.createElement('div');
      row.className = 'mf-card-row mf-hand-tap';
      mfSortCards(unassigned).forEach((card) => {
        const el = makeMfCardEl(card, {
          selected: mfSelectedCard === card,
          interactive: !locked,
        });
        if (!locked) el.addEventListener('click', () => mfSelectCard(card));
        row.appendChild(el);
      });
      mfHand.appendChild(row);
    }
  }

  mfUnassignBtn.classList.toggle(
    'hidden',
    locked || !inMatch || !mfSelectedCard || selectedAssigned < 0
  );
  mfLockedBadge.classList.toggle('hidden', !(inMatch && locked));
  mfLockedBadge.textContent = revealing
    ? isHost
      ? 'Locked — tap the boards above to reveal'
      : 'Locked — waiting for host to reveal'
    : 'Locked — waiting for others';

  mfLockStatus.innerHTML = '';
  (data.lockStatus || []).forEach((row) => {
    const li = document.createElement('li');
    const bits = [row.name];
    if (row.locked) bits.push('locked');
    else if (!row.connected) bits.push('disconnected');
    else bits.push('allocating');
    li.textContent = bits.join(' — ');
    if (!row.connected) li.classList.add('ts-disconnected');
    if (row.name === myName && row.locked) li.classList.add('mf-me-locked');
    mfLockStatus.appendChild(li);
  });

  const allAssigned =
    myHand &&
    mfAllocationCountsClient(allocation, boardCount).reduce((a, b) => a + b, 0) ===
      myHand.cards.length;
  mfLockBtn.classList.toggle('hidden', !inMatch || locked);
  mfLockBtn.disabled = !allAssigned;
  mfLockWaiting.classList.toggle('hidden', !(inMatch && locked));
  mfLockWaiting.textContent = revealing
    ? isHost
      ? 'Tap the face-down cards above to reveal them.'
      : 'Waiting for the host to reveal the boards…'
    : 'Waiting for everyone to lock…';
}

function applyState(data) {
  ctx.setHost(data.host);
  mfError.textContent = '';

  mfSubtitle.classList.remove('mf-all-ready');
  mfReadyPanel.classList.add('hidden');
  mfAllocPanel.classList.add('hidden');
  mfResultsPanel.classList.add('hidden');
  mfGameoverPanel.classList.add('hidden');
  mfNextBtn.classList.add('hidden');
  mfNextWaiting.classList.add('hidden');
  mfPlayAgainBtn.classList.add('hidden');
  mfPlayAgainWaiting.classList.add('hidden');

  if (data.phase !== 'allocating') {
    mfSelectedCard = null;
    mfAllocData = null;
  }

  const awarded =
    data.phase === 'roundResults' || data.phase === 'gameover'
      ? (data.roundResults && data.roundResults.pointsAwarded) || null
      : null;
  renderMfScoresLine(data.scores, data.players, { awarded });

  const isHost = ctx.getIsHost();

  if (data.phase === 'ready') {
    mfTitle.textContent = 'Menifot';
    mfSubtitle.textContent =
      data.roundNumber > 0 ? `Ready for round ${data.roundNumber + 1}` : 'First to 10 board wins';
    mfReadyPanel.classList.remove('hidden');

    mfPlayerList.innerHTML = '';
    const list = data.players && data.players.length ? data.players : [];
    if (list.length) {
      list.forEach((n) => {
        const li = document.createElement('li');
        li.textContent = n;
        mfPlayerList.appendChild(li);
      });
    } else {
      const li = document.createElement('li');
      li.textContent = 'Host will freeze the table when Start is pressed';
      mfPlayerList.appendChild(li);
    }

    mfStartBtn.textContent = data.roundNumber > 0 ? 'Next Round' : 'Start';
    mfStartBtn.classList.toggle('hidden', !isHost);
    mfStartBtn.disabled = !data.canStart;
    mfStartWaiting.classList.toggle('hidden', isHost);
    mfReadyError.textContent = '';
    return;
  }

  if (data.phase === 'allocating') {
    mfTitle.textContent = `Round ${data.roundNumber}`;
    mfSubtitle.textContent = lockedSubtitle(data);
    mfSubtitle.classList.toggle('mf-all-ready', mfAllLocked(data));
    mfAllocPanel.classList.remove('hidden');
    renderMfAllocating(data);
    return;
  }

  if (data.phase === 'roundResults') {
    mfTitle.textContent = `Round ${data.roundNumber} Results`;
    mfSubtitle.textContent = 'Match scores update above · host starts the next hand';
    mfResultsPanel.classList.remove('hidden');
    renderMfRoundResults(data);
    mfNextBtn.classList.toggle('hidden', !isHost);
    mfNextWaiting.classList.toggle('hidden', isHost);
    return;
  }

  if (data.phase === 'gameover') {
    mfTitle.textContent = 'Match Over';
    mfSubtitle.textContent = '';
    mfGameoverPanel.classList.remove('hidden');
    const winners = data.matchWinners || [];
    mfChampion.textContent =
      winners.length === 0
        ? 'No champion'
        : winners.length === 1
          ? `${winners[0]} wins Menifot!`
          : `Co-champions: ${winners.join(' & ')}!`;

    mfStandings.innerHTML = '';
    renderMfCompetitionStandings(mfStandings, data.standings || [], winners);

    mfFinalRound.innerHTML = '';
    if (data.roundResults) {
      const heading = document.createElement('h2');
      heading.className = 'scoreboard-heading';
      heading.textContent = 'Final round';
      mfFinalRound.appendChild(heading);
      appendMfRevealContent(mfFinalRound, data);
    }

    renderScoreboard(mfScoreboard, data.scoreboard || []);
    mfPlayAgainBtn.classList.toggle('hidden', !isHost);
    mfPlayAgainWaiting.classList.toggle('hidden', isHost);
  }
}

function mfAllLocked(data) {
  return !!(data.lockStatus && data.lockStatus.length > 0 && data.lockStatus.every((r) => r.locked));
}

function lockedSubtitle(data) {
  if (mfAllLocked(data)) return 'ALL PLAYERS READY';
  if (data.myHand && data.myHand.locked) {
    return 'Your hand is locked — waiting for the rest of the table';
  }
  if (!data.inMatch) return 'Spectating allocation';
  return 'Tap cards onto boards (±1 split), then Lock';
}

function renderMfCompetitionStandings(listEl, standings, winners) {
  listEl.innerHTML = '';
  let i = 0;
  while (i < standings.length) {
    let j = i + 1;
    while (j < standings.length && standings[j].score === standings[i].score) j += 1;
    const rank = i + 1;
    for (let k = i; k < j; k++) {
      const row = standings[k];
      const li = document.createElement('li');
      li.textContent = `#${rank} ${row.name} — ${row.score}`;
      if ((winners || []).includes(row.name)) li.classList.add('ts-champion-row');
      listEl.appendChild(li);
    }
    i = j;
  }
}

function appendMfRevealContent(container, data) {
  const results = data.roundResults;
  if (!results) return;

  const boardCount = data.boardCount || 2;
  const boardsWrap = document.createElement('div');
  boardsWrap.className = 'mf-boards';
  const myName = ctx.getMyName();

  for (let i = 0; i < boardCount; i++) {
    const board = (data.boards && data.boards[i]) || { flop: [], turn: null, river: null };
    const boardResult = (results.boards || []).find((b) => b.boardIndex === i) || {};
    const wrap = document.createElement('div');
    wrap.className = 'mf-board mf-board-revealed';

    const title = document.createElement('p');
    title.className = 'mf-board-title';
    title.textContent = `Board ${i + 1}`;
    wrap.appendChild(title);

    const row = document.createElement('div');
    row.className = 'mf-card-row';
    (board.flop || []).forEach((c) => row.appendChild(makeMfCardEl(c)));
    if (board.turn) row.appendChild(makeMfCardEl(board.turn));
    if (board.river) row.appendChild(makeMfCardEl(board.river));
    wrap.appendChild(row);

    const winLine = document.createElement('p');
    winLine.className = 'mf-winner-line';
    const winners = boardResult.winners || [];
    if (winners.length === 0) winLine.textContent = 'No winner';
    else if (winners.length === 1) winLine.textContent = `Winner: ${winners[0]}`;
    else {
      winLine.textContent = `Split (+1 each): ${winners.join(', ')}`;
      winLine.classList.add('mf-split');
    }
    wrap.appendChild(winLine);

    const rankings = document.createElement('ul');
    rankings.className = 'mf-rankings';
    (boardResult.rankings || []).forEach((r) => {
      const li = document.createElement('li');
      const won = winners.includes(r.name);
      li.className = won ? 'mf-rank-win' : '';

      const label = document.createElement('span');
      label.className = 'mf-rank-label';
      label.textContent = `${r.name}: ${r.descr}`;
      li.appendChild(label);

      if (r.holeUsed && r.holeUsed.length) {
        const usedRow = document.createElement('div');
        usedRow.className = 'mf-card-row mf-rank-cards';
        r.holeUsed.forEach((c) => {
          usedRow.appendChild(makeMfCardEl(c, { outcome: won ? 'win' : 'lose' }));
        });
        li.appendChild(usedRow);
      }

      rankings.appendChild(li);
    });
    wrap.appendChild(rankings);

    // Show this player's full allocation on this board, with the 2 cards that made
    // their best hand highlighted green (won) or red (lost).
    if (results.allocations && data.inMatch !== false && myName) {
      const mine = results.allocations[myName];
      const hole = mine && (mine[i] || mine[String(i)]);
      if (hole && hole.length) {
        const holeLabel = document.createElement('p');
        holeLabel.className = 'mf-hole-label';
        holeLabel.textContent = 'Your cards on this board';
        wrap.appendChild(holeLabel);
        const myRanking = (boardResult.rankings || []).find((r) => r.name === myName);
        const myUsed = new Set((myRanking && myRanking.holeUsed) || []);
        const myWon = winners.includes(myName);
        const holeRow = document.createElement('div');
        holeRow.className = 'mf-card-row';
        hole.forEach((c) => {
          holeRow.appendChild(
            makeMfCardEl(c, { outcome: myUsed.has(c) ? (myWon ? 'win' : 'lose') : null })
          );
        });
        wrap.appendChild(holeRow);
      }
    }

    boardsWrap.appendChild(wrap);
  }
  container.appendChild(boardsWrap);

  const burnWrap = document.createElement('div');
  burnWrap.className = 'mf-burn-row';
  const burnTitle = document.createElement('p');
  burnTitle.className = 'mf-board-title';
  burnTitle.textContent = 'Burned';
  burnWrap.appendChild(burnTitle);
  const burnCards = document.createElement('div');
  burnCards.className = 'mf-card-row';
  const burned = results.burned || data.burned || [];
  if (burned.length === 0) {
    const none = document.createElement('span');
    none.className = 'muted';
    none.textContent = 'None this round';
    burnCards.appendChild(none);
  } else {
    burned.forEach((c) => burnCards.appendChild(makeMfCardEl(c)));
  }
  burnWrap.appendChild(burnCards);
  container.appendChild(burnWrap);

  const pts = document.createElement('p');
  pts.className = 'mf-round-points';
  const awarded = results.pointsAwarded || {};
  pts.textContent =
    'Points this round: ' +
    (data.players || []).map((n) => `${n} +${awarded[n] || 0}`).join(' · ');
  container.appendChild(pts);
}

function renderMfRoundResults(data) {
  mfResultsBody.innerHTML = '';
  appendMfRevealContent(mfResultsBody, data);
}

export const Menifot = {
  init(nextCtx) {
    ctx = nextCtx;
    const { socket } = ctx;

    mfStartBtn.addEventListener('click', () => {
      mfReadyError.textContent = '';
      mfError.textContent = '';
      socket.emit('startMenifot', (res) => {
        if (res && !res.ok) mfReadyError.textContent = res.error;
      });
    });

    mfLockBtn.addEventListener('click', () => {
      mfAllocError.textContent = '';
      socket.emit('mfLock', (res) => {
        if (res && !res.ok) mfAllocError.textContent = res.error;
      });
    });

    mfUnassignBtn.addEventListener('click', () => {
      if (!mfSelectedCard || !mfAllocData || (mfAllocData.myHand && mfAllocData.myHand.locked)) return;
      mfAllocError.textContent = '';
      socket.emit('mfAssignCard', { card: mfSelectedCard, boardIndex: -1 }, (res) => {
        if (res && !res.ok) mfAllocError.textContent = res.error;
        else mfSelectedCard = null;
      });
    });

    mfNextBtn.addEventListener('click', () => {
      socket.emit('mfNextRound', (res) => {
        if (res && !res.ok) mfError.textContent = res.error;
      });
    });

    mfPlayAgainBtn.addEventListener('click', () => {
      socket.emit('playAgainMenifot', (res) => {
        if (res && !res.ok) mfError.textContent = res.error;
      });
    });

    mfBackBtn.addEventListener('click', () => {
      socket.emit('backToLobby', () => {});
    });

    socket.on('menifotState', (data) => {
      applyState(data);
      ctx.showScreen('menifot');
    });
  },

  applyState,

  applyJoin(res) {
    applyState(res);
    ctx.showScreen('menifot');
  },

  stop() {
    mfSelectedCard = null;
    mfAllocData = null;
    if (mfError) mfError.textContent = '';
    if (mfAllocError) mfAllocError.textContent = '';
  },
};
