/**
 * Mind Meld client module.
 */

import { renderScoreboard } from '../shared/scoreboard.js';

const mmReadyPanel = document.getElementById('mm-ready-panel');
const mmPlayerList = document.getElementById('mm-player-list');
const mmStartBtn = document.getElementById('mm-start-btn');
const mmStartWaiting = document.getElementById('mm-start-waiting');
const mmReadyError = document.getElementById('mm-ready-error');
const mmAnsweringPanel = document.getElementById('mm-answering-panel');
const mmSubjectName = document.getElementById('mm-subject-name');
const mmQuestion = document.getElementById('mm-question');
const mmCountdown = document.getElementById('mm-countdown');
const mmAnswerInput = document.getElementById('mm-answer-input');
const mmAnswerSubmitBtn = document.getElementById('mm-answer-submit-btn');
const mmAnswerWaiting = document.getElementById('mm-answer-waiting');
const mmAnswerError = document.getElementById('mm-answer-error');
const mmJudgingPanel = document.getElementById('mm-judging-panel');
const mmJudgingSubjectName = document.getElementById('mm-judging-subject-name');
const mmJudgingQuestion = document.getElementById('mm-judging-question');
const mmRevealedPanel = document.getElementById('mm-revealed-panel');
const mmRevealedTarget = document.getElementById('mm-revealed-target');
const mmDiffHeader = document.getElementById('mm-diff-header');
const mmRevealedBody = document.getElementById('mm-revealed-body');
const mmReasoningBtn = document.getElementById('mm-reasoning-btn');
const mmReasoningText = document.getElementById('mm-reasoning-text');
const mmMatchScores = document.getElementById('mm-match-scores');
const mmNextBtn = document.getElementById('mm-next-btn');
const mmNextWaiting = document.getElementById('mm-next-waiting');
const mmGameoverPanel = document.getElementById('mm-gameover-panel');
const mmStandingsBody = document.getElementById('mm-standings-body');
const mmScoreboard = document.getElementById('mm-scoreboard');
const mmPlayAgainBtn = document.getElementById('mm-play-again-btn');
const mmPlayAgainWaiting = document.getElementById('mm-play-again-waiting');
const mmError = document.getElementById('mm-error');
const mmBackBtn = document.getElementById('mm-back-btn');

let ctx = null;
let mmIsSubject = false;
let mmAnswerDeadline = null;
let mmSubmitted = false;
let mmTickHandle = null;

function formatMmNumber(n) {
  return Number(n).toLocaleString();
}

function stopMmTick() {
  if (mmTickHandle) clearInterval(mmTickHandle);
  mmTickHandle = null;
}

/** Reflects whether the input should currently accept typing - submitted, or (non-Subject) timed out. */
function updateMmLockState() {
  const timedOut = !mmIsSubject && mmAnswerDeadline != null && Date.now() >= mmAnswerDeadline;
  const locked = mmSubmitted || timedOut;
  mmAnswerInput.disabled = locked;
  mmAnswerSubmitBtn.disabled = locked;
  mmAnswerWaiting.classList.toggle('hidden', !locked);
  mmAnswerWaiting.textContent = mmSubmitted ? 'Submitted! Waiting for the others…' : "Time's up.";
}

function tickMmCountdown() {
  if (mmAnswerDeadline == null) return;
  const remainingMs = mmAnswerDeadline - Date.now();
  if (remainingMs <= 0) {
    mmCountdown.textContent = '0s left';
    stopMmTick();
    updateMmLockState();
    return;
  }
  mmCountdown.textContent = `${Math.ceil(remainingMs / 1000)}s left`;
}

function renderMmRevealedRow(r, kind, targetIsZero) {
  const isJudged = kind === 'judged';
  const tr = document.createElement('tr');

  const nameTd = document.createElement('td');
  nameTd.textContent = r.name;
  tr.appendChild(nameTd);

  const guessTd = document.createElement('td');
  guessTd.textContent = isJudged ? r.guess : formatMmNumber(r.guess);
  tr.appendChild(guessTd);

  const diffTd = document.createElement('td');
  diffTd.textContent = isJudged
    ? '—'
    : targetIsZero
      ? `off by ${formatMmNumber(r.pctDiff)}`
      : `${r.pctDiff.toFixed(1)}%`;
  tr.appendChild(diffTd);

  const rankTd = document.createElement('td');
  rankTd.textContent = String(r.rank);
  tr.appendChild(rankTd);

  const pointsTd = document.createElement('td');
  const bullseye = !isJudged && r.bullseye;
  pointsTd.textContent = bullseye ? `${r.points} 🎯` : String(r.points);
  if (bullseye) pointsTd.classList.add('mm-bullseye');
  tr.appendChild(pointsTd);

  return tr;
}

function applyState(data) {
  ctx.setHost(data.host);
  mmError.textContent = '';

  mmReadyPanel.classList.add('hidden');
  mmAnsweringPanel.classList.add('hidden');
  mmJudgingPanel.classList.add('hidden');
  mmRevealedPanel.classList.add('hidden');
  mmGameoverPanel.classList.add('hidden');
  stopMmTick();

  const isHost = ctx.getIsHost();

  if (data.phase === 'answering') {
    mmAnsweringPanel.classList.remove('hidden');
    mmSubjectName.textContent = data.subjectName ? `${data.subjectName}'s question` : '';
    mmQuestion.textContent = data.question || '';
    mmAnswerError.textContent = '';

    const isJudged = data.questionKind === 'judged';
    mmAnswerInput.inputMode = isJudged ? 'text' : 'decimal';
    mmAnswerInput.placeholder = isJudged ? 'Your guess' : 'Your guess (e.g. 5k, 2.5m)';
    if (isJudged) {
      mmAnswerInput.maxLength = 60;
    } else {
      mmAnswerInput.removeAttribute('maxlength');
    }

    mmIsSubject = !!data.isSubject;
    mmAnswerDeadline = data.answerDeadline || null;
    mmSubmitted = !!data.mySubmitted;

    mmCountdown.classList.toggle('hidden', mmIsSubject || !mmAnswerDeadline);
    if (!mmSubmitted) mmAnswerInput.value = '';

    updateMmLockState();
    if (!mmIsSubject && mmAnswerDeadline && !mmSubmitted) {
      tickMmCountdown();
      mmTickHandle = setInterval(tickMmCountdown, 250);
    }
    return;
  }

  if (data.phase === 'judging') {
    mmJudgingPanel.classList.remove('hidden');
    mmJudgingSubjectName.textContent = data.subjectName ? `${data.subjectName}'s question` : '';
    mmJudgingQuestion.textContent = data.question || '';
    return;
  }

  if (data.phase === 'revealed') {
    mmRevealedPanel.classList.remove('hidden');
    const kind = data.questionKind === 'judged' ? 'judged' : 'number';
    const targetIsZero = kind === 'number' && data.target === 0;
    mmRevealedTarget.textContent = data.subjectName
      ? `${data.subjectName}'s answer: ${kind === 'judged' ? data.target : formatMmNumber(data.target)}`
      : '';
    mmDiffHeader.textContent = kind === 'judged' ? 'Match' : 'Diff';

    mmRevealedBody.innerHTML = '';
    (data.ranking || [])
      .slice()
      .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
      .forEach((r) => mmRevealedBody.appendChild(renderMmRevealedRow(r, kind, targetIsZero)));

    const hasReasoning = kind === 'judged' && !!data.judgeReasoning;
    mmReasoningBtn.classList.toggle('hidden', !hasReasoning);
    mmReasoningBtn.textContent = "Show judge's reasoning";
    mmReasoningText.textContent = data.judgeReasoning || '';
    mmReasoningText.classList.add('hidden');

    const scoreEntries = Object.entries(data.scores || {})
      .map(([name, points]) => ({ name, points }))
      .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
    renderScoreboard(mmMatchScores, scoreEntries);

    mmNextBtn.classList.toggle('hidden', !isHost);
    mmNextWaiting.classList.toggle('hidden', isHost);
    return;
  }

  if (data.phase === 'gameover') {
    mmGameoverPanel.classList.remove('hidden');

    mmStandingsBody.innerHTML = '';
    (data.standings || []).forEach((s) => {
      const tr = document.createElement('tr');
      const rankTd = document.createElement('td');
      rankTd.textContent = `#${s.rank}`;
      const nameTd = document.createElement('td');
      nameTd.textContent = s.name;
      const scoreTd = document.createElement('td');
      scoreTd.textContent = String(s.score);
      tr.appendChild(rankTd);
      tr.appendChild(nameTd);
      tr.appendChild(scoreTd);
      mmStandingsBody.appendChild(tr);
    });

    renderScoreboard(mmScoreboard, data.scoreboard || []);

    mmPlayAgainBtn.classList.toggle('hidden', !isHost);
    mmPlayAgainWaiting.classList.toggle('hidden', isHost);
    return;
  }

  // 'ready' (and any other not-yet-implemented phase falls back to the ready panel for now).
  mmReadyPanel.classList.remove('hidden');
  mmPlayerList.innerHTML = '';
  (data.players || []).forEach((n) => {
    const li = document.createElement('li');
    li.textContent = n;
    mmPlayerList.appendChild(li);
  });
  mmStartBtn.classList.toggle('hidden', !isHost);
  mmStartWaiting.classList.toggle('hidden', isHost);
}

export const MindMeld = {
  init(nextCtx) {
    ctx = nextCtx;
    const { socket } = ctx;

    mmStartBtn.addEventListener('click', () => {
      mmReadyError.textContent = '';
      socket.emit('startMindMeld', (res) => {
        if (res && !res.ok) mmReadyError.textContent = res.error;
      });
    });

    mmAnswerSubmitBtn.addEventListener('click', () => {
      mmAnswerError.textContent = '';
      const raw = mmAnswerInput.value;
      socket.emit('submitMmAnswer', { raw }, (res) => {
        if (res && !res.ok) mmAnswerError.textContent = res.error;
      });
    });

    mmAnswerInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') mmAnswerSubmitBtn.click();
    });

    mmReasoningBtn.addEventListener('click', () => {
      const showing = !mmReasoningText.classList.contains('hidden');
      mmReasoningText.classList.toggle('hidden', showing);
      mmReasoningBtn.textContent = showing ? "Show judge's reasoning" : "Hide judge's reasoning";
    });

    mmNextBtn.addEventListener('click', () => {
      mmError.textContent = '';
      socket.emit('mmNextRound', (res) => {
        if (res && !res.ok) mmError.textContent = res.error;
      });
    });

    mmPlayAgainBtn.addEventListener('click', () => {
      mmError.textContent = '';
      socket.emit('playAgainMindMeld', (res) => {
        if (res && !res.ok) mmError.textContent = res.error;
      });
    });

    mmBackBtn.addEventListener('click', () => {
      socket.emit('backToLobby', () => {});
    });

    socket.on('mmState', (data) => {
      applyState(data);
      ctx.showScreen('mindMeld');
    });

    socket.on('mmStartFailed', ({ error }) => {
      mmReadyError.textContent = error;
      ctx.showScreen('mindMeld');
    });
  },

  applyState,

  applyJoin(res) {
    applyState(res);
    ctx.showScreen('mindMeld');
  },

  stop() {
    stopMmTick();
    if (mmReadyError) mmReadyError.textContent = '';
    if (mmAnswerError) mmAnswerError.textContent = '';
    if (mmError) mmError.textContent = '';
  },
};
