/**
 * Imposter client module.
 */

import { renderScoreboard } from '../shared/scoreboard.js';

let ctx = null;

let levelButtons;
let voteCount;
let votingError;
let votingBackBtn;
let levelLabel;
let roleEl;
let endRoundBtn;
let playAgainBtn;
let playAgainWaiting;
let reportYesBtn;
let reportNoBtn;
let reportChoices;
let reportWaiting;
let reportCount;
let reportError;
let imposterResultsBody;
let imposterResultsScoreboard;
let imposterResultsBackBtn;

let myVote = null;
let pendingLevel = null;

function queryDom() {
  levelButtons = Array.from(
    document.querySelectorAll('.level-btn:not(.cn-timer-btn):not(.word-lang-btn)')
  );
  voteCount = document.getElementById('vote-count');
  votingError = document.getElementById('voting-error');
  votingBackBtn = document.getElementById('voting-back-btn');
  levelLabel = document.getElementById('level-label');
  roleEl = document.getElementById('role-panel');
  endRoundBtn = document.getElementById('end-round-btn');
  playAgainBtn = document.getElementById('play-again-btn');
  playAgainWaiting = document.getElementById('play-again-waiting');
  reportYesBtn = document.getElementById('report-yes-btn');
  reportNoBtn = document.getElementById('report-no-btn');
  reportChoices = document.getElementById('report-choices');
  reportWaiting = document.getElementById('report-waiting');
  reportCount = document.getElementById('report-count');
  reportError = document.getElementById('report-error');
  imposterResultsBody = document.getElementById('imposter-results-body');
  imposterResultsScoreboard = document.getElementById('imposter-results-scoreboard');
  imposterResultsBackBtn = document.getElementById('imposter-results-back-btn');
}

function renderVoting() {
  levelButtons.forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.level === myVote);
  });
}

function renderGame(level, role, word, hint) {
  levelLabel.textContent = level ? `Difficulty: ${level}` : '';

  if (role === 'imposter') {
    roleEl.className = 'role-panel imposter';
    roleEl.textContent = '';
    const title = document.createElement('div');
    title.textContent = 'YOU ARE THE IMPOSTER';
    const hintEl = document.createElement('div');
    hintEl.className = 'hint-text';
    hintEl.textContent = `Hint: ${hint}`;
    roleEl.appendChild(title);
    roleEl.appendChild(hintEl);
  } else {
    roleEl.className = 'role-panel crew';
    roleEl.textContent = `Your word: ${word}`;
  }
}

function renderImposterReporting(data) {
  ctx.setHost(data.host);
  reportError.textContent = '';
  reportCount.textContent = `${data.answered || 0} of ${data.total || 0} answered`;
  const answered = data.myAnswer !== null && data.myAnswer !== undefined;
  reportChoices.classList.toggle('hidden', answered);
  reportWaiting.classList.toggle('hidden', !answered);
}

function renderImposterResults(data) {
  ctx.setHost(data.host);
  imposterResultsBody.innerHTML = '';
  (data.results || []).forEach((row) => {
    const tr = document.createElement('tr');
    const ptsClass =
      row.points > 0 ? 'pts-positive' : row.points < 0 ? 'pts-negative' : '';
    const ptsText = row.points > 0 ? `+${row.points}` : String(row.points);
    tr.innerHTML = `<td>${row.name}</td><td>${row.role === 'imposter' ? 'Imposter' : 'Crew'}</td><td>${row.eliminated ? 'Eliminated' : 'Survived'}</td><td class="${ptsClass}">${ptsText}</td>`;
    imposterResultsBody.appendChild(tr);
  });
  renderScoreboard(imposterResultsScoreboard, data.scoreboard || []);
}

function bindButtons() {
  levelButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const level = btn.dataset.level;
      const previousVote = myVote;
      // Highlight immediately; roll back if the server rejects the vote.
      myVote = level;
      renderVoting();
      ctx.socket.emit('vote', level, (res) => {
        if (res && res.ok === false) {
          myVote = previousVote;
          renderVoting();
        }
      });
    });
  });

  endRoundBtn.addEventListener('click', () => {
    ctx.socket.emit('endImposterRound', (res) => {
      if (res && !res.ok) {
        // Stay on game screen; host can retry.
      }
    });
  });

  reportYesBtn.addEventListener('click', () => {
    reportError.textContent = '';
    ctx.socket.emit('reportEliminated', true, (res) => {
      if (res && !res.ok) reportError.textContent = res.error;
    });
  });

  reportNoBtn.addEventListener('click', () => {
    reportError.textContent = '';
    ctx.socket.emit('reportEliminated', false, (res) => {
      if (res && !res.ok) reportError.textContent = res.error;
    });
  });

  playAgainBtn.addEventListener('click', () => {
    ctx.socket.emit('backToLobby', () => {});
  });

  votingBackBtn.addEventListener('click', () => {
    ctx.socket.emit('backToLobby', () => {});
  });

  imposterResultsBackBtn.addEventListener('click', () => {
    ctx.socket.emit('backToLobby', () => {});
  });
}

function bindSocket() {
  const { socket, showScreen, setHost } = ctx;

  socket.on('votingStarted', ({ host }) => {
    setHost(host);
    myVote = null;
    votingError.textContent = '';
    renderVoting();
    showScreen('voting');
  });

  socket.on('votingUpdate', ({ total, voted, host }) => {
    setHost(host);
    voteCount.textContent = `${voted} of ${total} voted`;
  });

  socket.on('gameStarted', ({ level }) => {
    pendingLevel = level;
  });

  socket.on('role', ({ role, word, hint }) => {
    renderGame(pendingLevel, role, word, hint);
    showScreen('game');
  });

  socket.on('imposterReporting', (data) => {
    renderImposterReporting(data);
    showScreen('imposterReporting');
  });

  socket.on('imposterResults', (data) => {
    renderImposterResults(data);
    showScreen('imposterResults');
  });

  socket.on('startFailed', ({ error }) => {
    votingError.textContent = error;
    showScreen('voting');
  });
}

export const Imposter = {
  init(gameCtx) {
    ctx = gameCtx;
    queryDom();
    bindButtons();
    bindSocket();
  },

  applyJoin(res) {
    if (res.phase === 'playing') {
      renderGame(res.level, res.role, res.word, res.hint);
      ctx.showScreen('game');
    } else if (res.phase === 'reporting') {
      renderImposterReporting(res);
      ctx.showScreen('imposterReporting');
    } else if (res.phase === 'roundResults') {
      renderImposterResults(res);
      ctx.showScreen('imposterResults');
    } else if (res.phase === 'generating') {
      ctx.showGenerating('imposter');
    } else if (res.phase === 'voting') {
      myVote = res.vote || null;
      renderVoting();
      ctx.showScreen('voting');
    }
  },

  stop() {
    myVote = null;
    pendingLevel = null;
    if (reportError) reportError.textContent = '';
  },
};
