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

// Number of distinct avatar background tones (aiof-seat-avatar-tone0..N-1 in CSS), cycled by
// each seat's fixed original index (not its rotated display slot) so a given physical seat
// keeps the same avatar color for everyone regardless of whose screen it renders on.
const AIOF_AVATAR_TONES = 6;

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
const aiofFeltSpots = document.getElementById('aiof-felt-spots');
const aiofTableCenter = document.getElementById('aiof-table-center');
const aiofCenterMsg = document.getElementById('aiof-center-msg');
const aiofBlindsInfo = document.getElementById('aiof-blinds-info');
const aiofStartBtn = document.getElementById('aiof-start-btn');
const aiofStartWaiting = document.getElementById('aiof-start-waiting');
const aiofBuyinPicker = document.getElementById('aiof-buyin-picker');
const aiofBuyinOpenBtn = document.getElementById('aiof-buyin-open-btn');
const aiofBuyinSlider = document.getElementById('aiof-buyin-slider');
const aiofBuyinValue = document.getElementById('aiof-buyin-value');
const aiofBuyinConfirmBtn = document.getElementById('aiof-buyin-confirm-btn');
const aiofBuyinCancelBtn = document.getElementById('aiof-buyin-cancel-btn');
const aiofRebuyOpenBtn = document.getElementById('aiof-rebuy-open-btn');
const aiofRebuyCloseBtn = document.getElementById('aiof-rebuy-close-btn');
const aiofRebuyPicker = document.getElementById('aiof-rebuy-picker');
const aiofRebuySlider = document.getElementById('aiof-rebuy-slider');
const aiofRebuyValue = document.getElementById('aiof-rebuy-value');
const aiofPot = document.getElementById('aiof-pot');
const aiofBoard = document.getElementById('aiof-board');
const aiofTurnStatus = document.getElementById('aiof-turn-status');
const aiofDecisionBtns = document.getElementById('aiof-decision-btns');
const aiofAllInBtn = document.getElementById('aiof-allin-btn');
const aiofFoldBtn = document.getElementById('aiof-fold-btn');
const aiofResultsPanel = document.getElementById('aiof-results-panel');
const aiofNextHandBtn = document.getElementById('aiof-nexthand-btn');
const aiofNextHandWaiting = document.getElementById('aiof-nexthand-waiting');
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
// The pre-Start buy-in sheet is opened on demand (via the "Buy-in: N" button in the bottom
// bar) rather than shown permanently, so it can't cover the host's Start button. Opening it
// syncs the slider from the server-known stack once; broadcasts never touch the slider
// while it's open, so other players' actions can't clobber an in-progress drag.
let buyinSheetOpen = false;
// Whether the rebuy slider's one-time default has already been set for the current bust —
// guards against a broadcast (from anyone's action at the table) resetting a value the
// player has dragged but not yet submitted. See renderBustPrompt.
let rebuySliderShown = false;
// A sitting-out player's rebuy sheet is opened on demand (via the "Buy back in" button)
// rather than shown persistently — a permanent bottom sheet would cover the bottom bar,
// including a sitting-out host's Next Hand button. See renderBustPrompt.
let rebuySheetOpen = false;

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

function renderAiofCardRow(container, cards) {
  container.innerHTML = '';
  if (!cards) return;
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

/** Per-winner won amounts for the last hand, replicating the server's exact split (floor
 * share + remainder chips to winners in array order) so the floating "+N" matches what was
 * actually credited to each stack. */
function winningsFor(results) {
  const map = {};
  if (!results) return map;
  if (results.uncontested) {
    map[results.winners[0]] = results.potTotal;
    return map;
  }
  (results.pots || []).forEach((pot) => {
    if (!pot.winners.length) return;
    const share = Math.floor(pot.amount / pot.winners.length);
    let remainder = pot.amount - share * pot.winners.length;
    pot.winners.forEach((name) => {
      const extra = remainder > 0 ? 1 : 0;
      if (extra) remainder -= 1;
      map[name] = (map[name] || 0) + share + extra;
    });
  });
  return map;
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
  aiofResultsPanel.classList.toggle('hidden', !(!hand && results));

  // The board stays open in the middle of the table through the results pause (not just
  // while `hand` is live) — cards shouldn't vanish the instant a showdown resolves. During
  // an active hand the center shows even before any board card is revealed (pot pill only),
  // like a real table.
  const boardCards = hand ? hand.board : results ? results.board : null;
  aiofTableCenter.classList.toggle('hidden', !(hand || boardCards));
  renderAiofCardRow(aiofBoard, boardCards);
  aiofPot.classList.toggle('hidden', !hand);
  aiofBlindsInfo.classList.toggle('hidden', !hand);

  // Center-felt info line: last hand's outcome during the between-hands pause, and/or the
  // waiting-for-players notice — the refs' centered lower-felt text block.
  const msgs = [];
  if (!hand && results) msgs.push(formatAiofResults(results));
  if (data.waitingForPlayers) msgs.push('Waiting for players…');
  aiofCenterMsg.textContent = msgs.join(' — ');
  aiofCenterMsg.classList.toggle('hidden', !msgs.length);

  if (!hand) {
    aiofTurnStatus.textContent = '';
    aiofDecisionBtns.classList.add('hidden');
    const isHost = ctx.getIsHost();
    aiofNextHandBtn.classList.toggle('hidden', !(isHost && data.canDealNextHand));
    aiofNextHandWaiting.classList.toggle('hidden', !(!isHost && data.canDealNextHand));
    return;
  }

  aiofPot.innerHTML = '';
  aiofPot.appendChild(makeAiofChipStackEl(hand.potTotal));
  const potText = document.createElement('span');
  potText.textContent = `Total Pot: ${hand.potTotal}`;
  aiofPot.appendChild(potText);

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
  const sittingOut = !!(mySeat && mySeat.sittingOut);
  // Fresh bust: 0 stack between hands, rebuy/sit-out decision not yet made. `!data.hand`
  // matters now that this is a bottom sheet over the table: a shoved stack is 0 mid-hand
  // too, and an always-on check would slide the sheet over the reveal the player is
  // watching. Covering the bottom bar here is safe — the server refuses to deal the next
  // hand until every 0-stack player resolves, so Next Hand couldn't do anything anyway.
  const mustDecide =
    data.phase === 'playing' && !data.hand && !!mySeat && mySeat.stack === 0 && !sittingOut;
  // Sitting out: no forced sheet (it would permanently cover the bottom bar, including a
  // sitting-out host's Next Hand button) — a "Buy back in" button opens it on demand.
  aiofRebuyOpenBtn.classList.toggle('hidden', !(sittingOut && !rebuySheetOpen));
  const show = mustDecide || (sittingOut && rebuySheetOpen);
  aiofBustPanel.classList.toggle('hidden', !show);
  if (!show) {
    rebuySliderShown = false;
    return;
  }

  aiofBustText.textContent = sittingOut
    ? "You're sitting out. Buy back in to rejoin the next hand."
    : "You're out of chips! Rebuy or sit out?";
  aiofDeclineBuyInBtn.classList.toggle('hidden', sittingOut);
  aiofRebuyCloseBtn.classList.toggle('hidden', !sittingOut);
  // The slider markup starts hidden in the HTML - nothing else ever un-hides it, so this
  // was the actual bug: a busted player never saw it and always rebought at the 150 default.
  aiofRebuyPicker.classList.remove('hidden');

  // Set the slider to its default only the first time this bust prompt appears — table
  // broadcasts fire on essentially every other player's action too, and resetting on every
  // one of them (the old behavior) clobbered a rebuy amount the player had dragged to but
  // not yet submitted, silently sending 150 instead of what they picked.
  if (!rebuySliderShown) {
    aiofRebuySlider.value = '150';
    aiofRebuyValue.textContent = aiofRebuySlider.value;
    rebuySliderShown = true;
  }
}

/** Pre-Start buy-in: a seated player sees a "Buy-in: N" button in the bottom bar; tapping
 * it opens the bottom-sheet slider (synced to the server-known stack at open time only, so
 * broadcasts from other players' actions never clobber an in-progress drag). Confirm and
 * Cancel both close the sheet. */
function renderBuyinPicker(data) {
  const hasSeat = data.mySeatIndex != null && data.mySeatIndex >= 0;
  const show = data.phase === 'seating' && hasSeat;
  if (!show) buyinSheetOpen = false;
  aiofBuyinOpenBtn.classList.toggle('hidden', !show);
  if (show) {
    aiofBuyinOpenBtn.textContent = `Buy-in: ${data.seats[data.mySeatIndex].stack} — change`;
  }
  aiofBuyinPicker.classList.toggle('hidden', !(show && buyinSheetOpen));
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
  const betweenHands = !data.hand && data.results;
  const winnings = betweenHands ? winningsFor(data.results) : {};

  aiofSeatsEl.innerHTML = '';
  aiofFeltSpots.innerHTML = '';
  (data.seats || []).forEach((seat, i) => {
    const interactive = !seat && !hasSeat;
    const el = document.createElement(interactive ? 'button' : 'div');
    const slot = (i - rotationOffset + AIOF_SEAT_COUNT) % AIOF_SEAT_COUNT;
    el.className = `aiof-seat aiof-seat-slot-${slot}`;

    if (seat) {
      const isSelf = i === data.mySeatIndex;
      if (isSelf) el.classList.add('aiof-seat-self');
      if (seat.sittingOut) el.classList.add('aiof-seat-sitting-out');
      if (seat.name === actingName) el.classList.add('aiof-seat-turn');
      if (foldedNames.includes(seat.name)) el.classList.add('aiof-seat-folded');

      // Face-up cards at this seat: the viewer's own hand is always visible to them (their
      // seat is the bottom slot, where the refs put your big hand), other seats only once
      // revealed by a showdown (seatCardsFor).
      const faceUpCards = isSelf
        ? data.hand
          ? data.hand.myHoleCards
          : betweenHands
            ? (data.results.holeCards || {})[seat.name] || null
            : null
        : seatCardsFor(data, seat.name);

      // A fan of face-down card backs above the avatar for anyone still live in the current
      // hand whose cards we can't see yet — one back per hole card dealt, like the refs.
      const stillHiddenInHand =
        data.hand && !faceUpCards && !foldedNames.includes(seat.name) && !seat.sittingOut;
      if (stillHiddenInHand) {
        const fanEl = document.createElement('span');
        fanEl.className = 'aiof-seat-fan';
        for (let c = 0; c < 6; c++) {
          fanEl.appendChild(document.createElement('span')).className = 'aiof-cardback';
        }
        el.appendChild(fanEl);
      } else if (faceUpCards) {
        const usedSet = usedCardsFor(data.results, seat.name);
        const fanEl = document.createElement('span');
        fanEl.className = 'aiof-seat-fan aiof-seat-cards';
        faceUpCards.forEach((code) => {
          const cardEl = makeAiofCardEl(code);
          if (usedSet.has(code)) cardEl.classList.add('aiof-card-used');
          fanEl.appendChild(cardEl);
        });
        el.appendChild(fanEl);
      }

      const avatarEl = document.createElement('span');
      avatarEl.className = `aiof-seat-avatar aiof-seat-avatar-tone${i % AIOF_AVATAR_TONES}`;
      avatarEl.textContent = seat.name.charAt(0).toUpperCase();

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
      avatarEl.appendChild(badge);
      el.appendChild(avatarEl);

      // The nameplate plaque: name + stack (+ sitting-out label), with the avatar
      // overlapping its top edge — the refs' seat anchor.
      const plaqueEl = document.createElement('span');
      plaqueEl.className = 'aiof-seat-plaque';

      const nameEl = document.createElement('span');
      nameEl.className = 'aiof-seat-name';
      nameEl.textContent = seat.name;
      plaqueEl.appendChild(nameEl);

      const stackEl = document.createElement('span');
      stackEl.className = 'aiof-seat-stack';
      stackEl.textContent = `${seat.stack}`;
      plaqueEl.appendChild(stackEl);

      if (seat.sittingOut) {
        const outEl = document.createElement('span');
        outEl.className = 'aiof-seat-out-label';
        outEl.textContent = 'sitting out';
        plaqueEl.appendChild(outEl);
      }
      el.appendChild(plaqueEl);

      // Winner treatment during the between-hands pause: gold plaque glow + floating "+N".
      const won = winnings[seat.name];
      if (won) {
        el.classList.add('aiof-seat-winner');
        const wonEl = document.createElement('span');
        wonEl.className = 'aiof-seat-win-amount';
        wonEl.textContent = `+${won}`;
        el.appendChild(wonEl);
      }

      // Felt spots for this seat: posted chips (blind/shove) between seat and pot while a
      // hand is live, and the dealer's "D" disc.
      const contributed = data.hand ? (data.hand.contributions || {})[seat.name] || 0 : 0;
      if (contributed > 0) {
        const betEl = document.createElement('span');
        betEl.className = `aiof-bet-spot aiof-spot-slot-${slot}`;
        betEl.appendChild(makeAiofChipStackEl(contributed));
        const amountEl = document.createElement('span');
        amountEl.textContent = `${contributed}`;
        betEl.appendChild(amountEl);
        aiofFeltSpots.appendChild(betEl);
      }
      if (i === data.dealerSeat && data.phase === 'playing') {
        const discEl = document.createElement('span');
        discEl.className = `aiof-dealer-disc aiof-spot-slot-${slot}`;
        discEl.textContent = 'D';
        aiofFeltSpots.appendChild(discEl);
      }
    } else {
      el.classList.add('aiof-seat-open');
      el.textContent = 'Take Seat';
      if (interactive) {
        el.type = 'button';
        el.addEventListener('click', () => trySitSeat(i));
      } else {
        el.classList.add('aiof-seat-disabled');
      }
    }

    aiofSeatsEl.appendChild(el);
  });

  aiofStartBtn.classList.toggle('hidden', !(isHost && data.phase === 'seating'));
  aiofStartBtn.disabled = !data.canStart;
  aiofStartWaiting.classList.toggle('hidden', isHost || data.phase !== 'seating');

  renderBuyinPicker(data);
  renderHand(data);
  renderBustPrompt(data);
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

    aiofBuyinOpenBtn.addEventListener('click', () => {
      if (!lastData || lastData.mySeatIndex < 0) return;
      const stack = lastData.seats[lastData.mySeatIndex].stack;
      aiofBuyinSlider.value = String(stack);
      aiofBuyinValue.textContent = String(stack);
      buyinSheetOpen = true;
      aiofBuyinPicker.classList.remove('hidden');
    });

    aiofBuyinConfirmBtn.addEventListener('click', () => {
      aiofError.textContent = '';
      socket.emit('aiofSetBuyIn', { amount: Number(aiofBuyinSlider.value) }, (res) => {
        if (res && !res.ok) {
          aiofError.textContent = res.error;
          return;
        }
        buyinSheetOpen = false;
        aiofBuyinPicker.classList.add('hidden');
      });
    });

    aiofBuyinCancelBtn.addEventListener('click', () => {
      buyinSheetOpen = false;
      aiofBuyinPicker.classList.add('hidden');
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

    aiofRebuyOpenBtn.addEventListener('click', () => {
      rebuySheetOpen = true;
      if (lastData) render(lastData);
    });

    aiofRebuyCloseBtn.addEventListener('click', () => {
      rebuySheetOpen = false;
      if (lastData) render(lastData);
    });

    aiofBuyInBtn.addEventListener('click', () => {
      aiofError.textContent = '';
      socket.emit('aiofBuyIn', { amount: Number(aiofRebuySlider.value) }, (res) => {
        if (res && !res.ok) {
          aiofError.textContent = res.error;
          return;
        }
        rebuySheetOpen = false;
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
    buyinSheetOpen = false;
    rebuySliderShown = false;
    rebuySheetOpen = false;
  },
};
