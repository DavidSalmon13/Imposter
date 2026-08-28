/**
 * Codenames client module.
 * Owns team-select, play, and game-over screens for Codenames.
 */

import { capitalize, formatCnTimer } from '../shared/format.js';
import { renderScoreboard } from '../shared/scoreboard.js';

const redList = document.getElementById('red-list');
const blueList = document.getElementById('blue-list');
const joinRedBtn = document.getElementById('join-red-btn');
const joinBlueBtn = document.getElementById('join-blue-btn');
const leaderRedBtn = document.getElementById('leader-red-btn');
const leaderBlueBtn = document.getElementById('leader-blue-btn');
const cnStartBtn = document.getElementById('cn-start-btn');
const cnStartWaiting = document.getElementById('cn-start-waiting');
const cnTeamError = document.getElementById('cn-team-error');
const cnTeamBackBtn = document.getElementById('cn-team-back-btn');
const cnTimerBtns = Array.from(document.querySelectorAll('.cn-timer-btn'));
const cnNameBankList = document.getElementById('cn-name-bank-list');
const cnNameBankInput = document.getElementById('cn-name-bank-input');
const cnNameBankAddBtn = document.getElementById('cn-name-bank-add-btn');
const cnNameBankError = document.getElementById('cn-name-bank-error');

const cnTurnLabel = document.getElementById('cn-turn-label');
const cnScore = document.getElementById('cn-score');
const cnGrid = document.getElementById('cn-grid');
const cnEndTurnBtn = document.getElementById('cn-end-turn-btn');
const cnTimerDisplay = document.getElementById('cn-timer-display');
const cnStartTimerBtn = document.getElementById('cn-start-timer-btn');

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

function tickCnTimer() {
  if (!cnTurnEndsAt) return;
  const remaining = cnTurnEndsAt - Date.now();
  cnTimerDisplay.textContent = formatCnTimer(remaining);
  cnTimerDisplay.classList.toggle('cn-timer-low', remaining <= 10000);
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
}

function renderGrid(container, board, interactive, onClick) {
  container.innerHTML = '';
  board.forEach((cell, i) => {
    const btn = document.createElement('button');
    btn.className = 'cn-card';
    btn.textContent = cell.word;
    if (cell.revealed) {
      btn.classList.add('revealed', `cn-${cell.color}`);
    } else if (cell.color) {
      btn.classList.add('cn-leader-hint', `cn-${cell.color}`);
    }
    const clickable = interactive && !cell.revealed;
    btn.disabled = !clickable;
    if (clickable) {
      btn.addEventListener('click', () => onClick(i));
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
  } else {
    const mine = data.activeTeam === myTeam;
    cnTurnLabel.textContent = mine
      ? `${capitalize(data.activeTeam)}'s turn (yours!)`
      : `${capitalize(data.activeTeam)}'s turn`;
    cnTurnLabel.className = `cn-turn cn-turn-${data.activeTeam}`;
    cnScore.textContent = `Red ${data.scores.red} — Blue ${data.scores.blue}`;

    const waitingToStart = cnTimerSeconds > 0 && !cnTurnEndsAt;
    const interactive = mine && !isLeader && !waitingToStart;
    renderGrid(cnGrid, data.board, interactive, (i) => ctx.socket.emit('guessWord', i, () => {}));
    cnEndTurnBtn.classList.toggle('hidden', !interactive);
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

    cnTimerBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!ctx.getIsHost()) return;
        const seconds = Number(btn.dataset.seconds);
        socket.emit('setCnTimer', seconds, (res) => {
          if (res && !res.ok) cnTeamError.textContent = res.error;
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
    cnTeamError.textContent = '';
    cnNameBankError.textContent = '';
  },
};
