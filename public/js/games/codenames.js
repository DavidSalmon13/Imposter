/**
 * Codenames client module.
 * Owns team-select, play, and game-over screens for Codenames.
 */

import { capitalize, formatCnTimer } from '../shared/format.js';
import { renderScoreboard } from '../shared/scoreboard.js';
import { selectChip } from '../shared/dom.js';
import { confirmDialog } from '../shared/confirmDialog.js';

const redList = document.getElementById('red-list');
const blueList = document.getElementById('blue-list');
const joinRedBtn = document.getElementById('join-red-btn');
const joinBlueBtn = document.getElementById('join-blue-btn');
const leaderRedBtn = document.getElementById('leader-red-btn');
const leaderBlueBtn = document.getElementById('leader-blue-btn');
const cnRandomTeamsBtn = document.getElementById('cn-random-teams-btn');
const cnStartBtn = document.getElementById('cn-start-btn');
const cnStartWaiting = document.getElementById('cn-start-waiting');
const cnTeamError = document.getElementById('cn-team-error');
const cnTeamBackBtn = document.getElementById('cn-team-back-btn');
const cnTimerBtns = Array.from(document.querySelectorAll('.cn-timer-btn'));
const cnNameBankLabel = document.getElementById('cn-name-bank-label');
const cnNameBankList = document.getElementById('cn-name-bank-list');
const cnNameBankInput = document.getElementById('cn-name-bank-input');
const cnNameBankAddBtn = document.getElementById('cn-name-bank-add-btn');
const cnNameBankError = document.getElementById('cn-name-bank-error');
const cnBankPickSlider = document.getElementById('cn-bank-pick-slider');
const cnBankPickValue = document.getElementById('cn-bank-pick-value');

const cnTurnLabel = document.getElementById('cn-turn-label');
const cnBoard = document.getElementById('cn-board');
const cnTug = document.getElementById('cn-tug');
const cnFound = { red: document.getElementById('cn-found-red'), blue: document.getElementById('cn-found-blue') };
const cnTotal = { red: document.getElementById('cn-total-red'), blue: document.getElementById('cn-total-blue') };
const cnWins = { red: document.getElementById('cn-wins-red'), blue: document.getElementById('cn-wins-blue') };
const cnTeamBox = { red: document.getElementById('cn-team-red'), blue: document.getElementById('cn-team-blue') };
const cnMembers = { red: document.getElementById('cn-members-red'), blue: document.getElementById('cn-members-blue') };
const cnLeaderNote = document.getElementById('cn-leader-note');
const cnGrid = document.getElementById('cn-grid');
const cnEndTurnBtn = document.getElementById('cn-end-turn-btn');
const cnTimerDisplay = document.getElementById('cn-timer-display');
const cnStartTimerBtn = document.getElementById('cn-start-timer-btn');
const cnRestartBtn = document.getElementById('cn-restart-btn');
const cnRestartError = document.getElementById('cn-restart-error');

const cnWinnerTitle = document.getElementById('cn-winner-title');
const cnFinalScore = document.getElementById('cn-final-score');
const cnFinalGrid = document.getElementById('cn-final-grid');
const cnScoreboard = document.getElementById('cn-scoreboard');
const cnPlayAgainBtn = document.getElementById('cn-play-again-btn');
const cnPlayAgainWaiting = document.getElementById('cn-play-again-waiting');
const cnBackBtn = document.getElementById('cn-back-btn');

let ctx = null;

let myTeam = null;
let isLeader = false;
let cnTimerSeconds = 0;
let cnTurnEndsAt = null;
let cnTimerTickHandle = null;
let bankPickSliderDragging = false;

function tickCnTimer() {
  if (!cnTurnEndsAt) return;
  const remaining = cnTurnEndsAt - Date.now();
  cnTimerDisplay.textContent = formatCnTimer(remaining);
  cnTimerDisplay.classList.toggle('cn-timer-low', remaining <= 10000);
  cnTimerDisplay.classList.toggle('cn-timer-warn', remaining > 10000 && remaining <= 20000);
}

function stopCnTimerTick() {
  if (cnTimerTickHandle) {
    clearInterval(cnTimerTickHandle);
    cnTimerTickHandle = null;
  }
}

function startCnTimerTick() {
  stopCnTimerTick();
  tickCnTimer();
  cnTimerTickHandle = setInterval(tickCnTimer, 250);
}

function renderTeamMembers(el, members) {
  el.innerHTML = '';
  members.forEach((m) => {
    const li = document.createElement('li');
    li.textContent = m.leader ? `${m.name} (leader)` : m.name;
    el.appendChild(li);
  });
}

function renderTeamSelect(data) {
  ctx.setHost(data.host);
  ctx.applyWordTheme(data.wordTheme);
  myTeam = null;
  isLeader = false;
  const myName = ctx.getMyName();
  [...data.red, ...data.blue].forEach((m) => {
    if (m.name === myName) {
      myTeam = data.red.includes(m) ? 'red' : 'blue';
      isLeader = m.leader;
    }
  });

  renderTeamMembers(redList, data.red);
  renderTeamMembers(blueList, data.blue);

  joinRedBtn.classList.toggle('hidden', myTeam === 'red');
  joinBlueBtn.classList.toggle('hidden', myTeam === 'blue');

  const redHasLeader = data.red.some((p) => p.leader);
  const blueHasLeader = data.blue.some((p) => p.leader);

  leaderRedBtn.classList.toggle('hidden', myTeam !== 'red' || redHasLeader);
  leaderBlueBtn.classList.toggle('hidden', myTeam !== 'blue' || blueHasLeader);

  const redValid = data.red.length >= 2 && redHasLeader;
  const blueValid = data.blue.length >= 2 && blueHasLeader;
  const ready = redValid && blueValid;

  const isHost = ctx.getIsHost();
  cnRandomTeamsBtn.classList.toggle('hidden', !isHost);
  cnStartBtn.classList.toggle('hidden', !isHost);
  cnStartBtn.disabled = !ready;
  cnStartWaiting.classList.toggle('hidden', isHost);

  cnTeamError.textContent = ready ? '' : 'Each team needs at least 2 players including a leader';

  cnTimerSeconds = data.timerSeconds || 0;
  cnTimerBtns.forEach((btn) => {
    btn.classList.toggle('selected', Number(btn.dataset.seconds) === cnTimerSeconds);
    btn.disabled = !isHost;
  });

  cnNameBankList.innerHTML = '';
  (data.nameBank || []).forEach((word) => {
    const li = document.createElement('li');
    li.textContent = word;
    cnNameBankList.appendChild(li);
  });

  const bankPickMax = data.bankPickMax || 10;
  const bankPickCount = data.bankPickCount ?? 2;
  cnNameBankLabel.textContent = `Room name bank — ${bankPickCount} random one${bankPickCount === 1 ? '' : 's'} mixed into every board`;
  cnBankPickSlider.max = bankPickMax;
  cnBankPickSlider.disabled = !isHost;
  if (!bankPickSliderDragging) {
    cnBankPickSlider.value = bankPickCount;
  }
  cnBankPickValue.textContent = cnBankPickSlider.value;
}

// Static, app-authored icon markup (never built from player input).
const SKULL_SVG =
  '<svg class="cn-skull" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a8 8 0 0 0-8 8c0 2.6 1.2 4.4 3 5.5V20h10v-3.5c1.8-1.1 3-2.9 3-5.5a8 8 0 0 0-8-8z"/><circle cx="9" cy="11.5" r="1.6"/><circle cx="15" cy="11.5" r="1.6"/><path d="M10 20v-2M14 20v-2"/></svg>';
const CROWN_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="#f6c768" role="img" aria-label="Leader"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/></svg>';
const COLOR_LABEL = { red: 'red team', blue: 'blue team', neutral: 'neutral', assassin: 'assassin' };

function renderMembers(el, members) {
  const myName = ctx.getMyName();
  el.innerHTML = '';
  (members || []).forEach((m) => {
    const chip = document.createElement('span');
    chip.className = 'cn-member';
    if (m.name === myName) chip.classList.add('me');
    if (m.leader) chip.insertAdjacentHTML('beforeend', CROWN_SVG);
    chip.appendChild(document.createTextNode(m.name));
    el.appendChild(chip);
  });
}

// One segment per card a team has to find: red fills from the left edge inward,
// blue from the right edge inward, meeting in the middle.
function renderTug(found, total) {
  cnTug.innerHTML = '';
  const seg = (team, filled) => {
    const s = document.createElement('span');
    s.className = `cn-seg cn-seg-${team}${filled ? ' filled' : ''}`;
    cnTug.appendChild(s);
  };
  for (let i = 0; i < total.red; i++) seg('red', i < found.red);
  const gap = document.createElement('span');
  gap.className = 'cn-seg-gap';
  cnTug.appendChild(gap);
  for (let i = total.blue - 1; i >= 0; i--) seg('blue', i < found.blue);
  cnTug.setAttribute('aria-label', `Red found ${found.red} of ${total.red}, Blue found ${found.blue} of ${total.blue}`);
}

// container -> words revealed as of its last render, so a re-render only animates new reveals.
const lastRevealed = new WeakMap();

function renderGrid(container, board, interactive, onClick, { dimRevealed = false } = {}) {
  container.innerHTML = '';
  const prev = lastRevealed.get(container);
  lastRevealed.set(container, new Set(board.filter((c) => c.revealed).map((c) => c.word)));
  board.forEach((cell, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cn-card';
    if (cell.revealed) {
      btn.classList.add('revealed', `cn-${cell.color}`);
      if (dimRevealed) btn.classList.add('cn-done');
      if (prev && !prev.has(cell.word)) btn.classList.add('just-revealed');
    } else if (cell.color) {
      btn.classList.add('cn-leader-hint', `cn-${cell.color}`);
    }
    if (cell.color === 'red' || cell.color === 'blue') {
      const mark = document.createElement('span');
      mark.className = 'cn-mark';
      mark.setAttribute('aria-hidden', 'true');
      btn.appendChild(mark);
    }
    if (cell.color === 'assassin') btn.insertAdjacentHTML('beforeend', SKULL_SVG);
    if (cell.word.length > 7) btn.classList.add('cn-card-long');
    const word = document.createElement('span');
    word.textContent = cell.word;
    btn.appendChild(word);
    btn.setAttribute('aria-label', cell.color ? `${cell.word}, ${COLOR_LABEL[cell.color]}` : cell.word);
    const clickable = interactive && !cell.revealed;
    btn.disabled = !clickable;
    if (clickable) {
      btn.addEventListener('click', () => {
        // Instant feedback the tap registered - the real reveal (color)
        // only arrives once the server broadcasts the next state update.
        btn.disabled = true;
        btn.classList.add('cn-card-pending');
        onClick(i);
      });
    }
    container.appendChild(btn);
  });
}

function applyCodenamesState(data) {
  ctx.setHost(data.host);
  myTeam = data.myTeam;
  isLeader = data.isLeader;
  cnTimerSeconds = data.timerSeconds || 0;
  cnTurnEndsAt = data.turnEndsAt || null;

  if (data.phase === 'gameover') {
    stopCnTimerTick();
    cnTimerDisplay.classList.add('hidden');
    cnStartTimerBtn.classList.add('hidden');
    cnWinnerTitle.textContent = `${capitalize(data.winner)} Wins!`;
    cnWinnerTitle.className = `cn-turn-${data.winner}`;
    cnFinalScore.textContent = `Red ${data.scores.red} — Blue ${data.scores.blue}`;
    renderGrid(cnFinalGrid, data.board, false, null);
    renderScoreboard(cnScoreboard, data.scoreboard || []);
    cnPlayAgainBtn.classList.toggle('hidden', !isLeader);
    cnPlayAgainWaiting.classList.toggle('hidden', isLeader);
    cnRestartBtn.classList.add('hidden');
  } else {
    cnRestartBtn.classList.toggle('hidden', !ctx.getIsHost());
    const mine = data.activeTeam === myTeam;
    const teamLabel = data.activeTeam.toUpperCase();
    cnTurnLabel.textContent = mine ? `${teamLabel} GUESSING · YOU` : `${teamLabel} GUESSING`;
    cnBoard.classList.toggle('cn-board-blue', data.activeTeam === 'blue');

    // Totals come from found + remaining, since non-leaders can't see unrevealed colours.
    const remaining = data.remaining || { red: 0, blue: 0 };
    const found = { red: 0, blue: 0 };
    data.board.forEach((c) => {
      if (c.revealed && c.color in found) found[c.color] += 1;
    });
    const total = { red: found.red + remaining.red, blue: found.blue + remaining.blue };
    ['red', 'blue'].forEach((team) => {
      cnFound[team].textContent = found[team];
      cnTotal[team].textContent = total[team];
      cnWins[team].textContent = data.scores[team];
      cnTeamBox[team].classList.toggle('active', data.activeTeam === team);
      renderMembers(cnMembers[team], data[team]);
    });
    renderTug(found, total);

    const waitingToStart = cnTimerSeconds > 0 && !cnTurnEndsAt;
    const interactive = mine && !isLeader && !waitingToStart;
    renderGrid(cnGrid, data.board, interactive, (i) => ctx.socket.emit('guessWord', i, () => {}), {
      dimRevealed: isLeader,
    });
    cnEndTurnBtn.classList.toggle('hidden', !interactive);
    cnLeaderNote.classList.toggle('hidden', !isLeader);
    cnStartTimerBtn.classList.toggle('hidden', !(waitingToStart && mine));

    if (cnTimerSeconds > 0 && cnTurnEndsAt) {
      cnTimerDisplay.classList.remove('hidden');
      startCnTimerTick();
    } else {
      stopCnTimerTick();
      cnTimerDisplay.classList.add('hidden');
    }
  }
}

export const Codenames = {
  init(c) {
    ctx = c;
    const { socket, showScreen } = ctx;

    joinRedBtn.addEventListener('click', () => {
      socket.emit('joinTeam', 'red', (res) => {
        if (res && !res.ok) cnTeamError.textContent = res.error;
      });
    });

    joinBlueBtn.addEventListener('click', () => {
      socket.emit('joinTeam', 'blue', (res) => {
        if (res && !res.ok) cnTeamError.textContent = res.error;
      });
    });

    leaderRedBtn.addEventListener('click', () => {
      socket.emit('claimLeader', (res) => {
        if (res && !res.ok) cnTeamError.textContent = res.error;
      });
    });

    leaderBlueBtn.addEventListener('click', () => {
      socket.emit('claimLeader', (res) => {
        if (res && !res.ok) cnTeamError.textContent = res.error;
      });
    });

    cnRandomTeamsBtn.addEventListener('click', () => {
      cnTeamError.textContent = '';
      socket.emit('randomizeCnTeams', (res) => {
        if (res && !res.ok) cnTeamError.textContent = res.error;
      });
    });

    cnTimerBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!ctx.getIsHost()) return;
        const seconds = Number(btn.dataset.seconds);
        selectChip(cnTimerBtns, btn);
        socket.emit('setCnTimer', seconds, (res) => {
          if (res && !res.ok) {
            cnTeamError.textContent = res.error;
            cnTimerBtns.forEach((b) => b.classList.toggle('selected', Number(b.dataset.seconds) === cnTimerSeconds));
          }
        });
      });
    });

    function addNameBankWord() {
      const word = cnNameBankInput.value.trim();
      cnNameBankError.textContent = '';
      if (!word) return;
      socket.emit('addCnNameBankWord', word, (res) => {
        if (!res.ok) return (cnNameBankError.textContent = res.error);
        cnNameBankInput.value = '';
      });
    }

    cnNameBankAddBtn.addEventListener('click', addNameBankWord);
    cnNameBankInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addNameBankWord();
    });

    cnBankPickSlider.addEventListener('input', () => {
      bankPickSliderDragging = true;
      cnBankPickValue.textContent = cnBankPickSlider.value;
    });

    cnBankPickSlider.addEventListener('change', () => {
      bankPickSliderDragging = false;
      socket.emit('setCnBankPickCount', Number(cnBankPickSlider.value), (res) => {
        if (res && !res.ok) cnTeamError.textContent = res.error;
      });
    });

    cnStartBtn.addEventListener('click', () => {
      cnTeamError.textContent = '';
      socket.emit('startCodenames', (res) => {
        if (!res.ok) cnTeamError.textContent = res.error;
      });
    });

    cnStartTimerBtn.addEventListener('click', () => {
      socket.emit('startCnTurnTimer', () => {});
    });

    cnEndTurnBtn.addEventListener('click', () => {
      socket.emit('endTurn', () => {});
    });

    cnRestartBtn.addEventListener('click', async () => {
      cnRestartError.textContent = '';
      const ok = await confirmDialog(
        'The current board will be discarded and a fresh one dealt to the same teams.',
        { title: 'Restart this round?', confirmLabel: 'Restart', danger: true }
      );
      if (!ok) return;
      socket.emit('restartCodenamesRound', (res) => {
        if (res && !res.ok) cnRestartError.textContent = res.error;
      });
    });

    cnPlayAgainBtn.addEventListener('click', () => {
      socket.emit('playAgainCodenames', () => {});
    });

    cnBackBtn.addEventListener('click', () => {
      socket.emit('backToLobby', () => {});
    });

    cnTeamBackBtn.addEventListener('click', () => {
      socket.emit('backToLobby', () => {});
    });

    socket.on('teamSelectUpdate', (data) => {
      renderTeamSelect(data);
      showScreen('teamSelect');
    });

    socket.on('codenamesStartFailed', ({ error }) => {
      cnTeamError.textContent = error;
      showScreen('teamSelect');
    });

    socket.on('codenamesState', (data) => {
      applyCodenamesState(data);
      showScreen(data.phase === 'gameover' ? 'codenamesGameover' : 'codenames');
    });
  },

  applyState(data) {
    applyCodenamesState(data);
  },

  applyJoin(res) {
    if (res.phase === 'teamSelect') {
      renderTeamSelect(res);
      ctx.showScreen('teamSelect');
      return;
    }
    if (res.phase === 'generating') {
      return;
    }
    applyCodenamesState(res);
    ctx.showScreen(res.phase === 'gameover' ? 'codenamesGameover' : 'codenames');
  },

  stop() {
    stopCnTimerTick();
    myTeam = null;
    isLeader = false;
    cnTimerSeconds = 0;
    cnTurnEndsAt = null;
    bankPickSliderDragging = false;
    cnTeamError.textContent = '';
    cnNameBankError.textContent = '';
    cnRestartError.textContent = '';
  },
};
