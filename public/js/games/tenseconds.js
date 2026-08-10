/**
 * 10 Seconds client module.
 */

import { formatTsTime, formatTsDistance } from '../shared/format.js';
import { renderScoreboard } from '../shared/scoreboard.js';

let ctx = null;

let tsBadge;
let tsTitle;
let tsSubtitle;
let tsReadyPanel;
let tsPlayerList;
let tsStartBtn;
let tsStartWaiting;
let tsReadyError;
let tsRunningPanel;
let tsCountdown;
let tsStopwatch;
let tsStopBtn;
let tsWaitingStops;
let tsSpectateHint;
let tsResultsPanel;
let tsResultsBody;
let tsContinueBtn;
let tsContinueWaiting;
let tsGameoverPanel;
let tsChampion;
let tsStandings;
let tsScoreboard;
let tsPlayAgainBtn;
let tsPlayAgainWaiting;
let tsBackBtn;
let tsError;

let tsRoundStartAt = null;
let tsTickHandle = null;
let tsHasStopped = false;
let tsIsContender = false;

function queryDom() {
  tsBadge = document.getElementById('ts-badge');
  tsTitle = document.getElementById('ts-title');
  tsSubtitle = document.getElementById('ts-subtitle');
  tsReadyPanel = document.getElementById('ts-ready-panel');
  tsPlayerList = document.getElementById('ts-player-list');
  tsStartBtn = document.getElementById('ts-start-btn');
  tsStartWaiting = document.getElementById('ts-start-waiting');
  tsReadyError = document.getElementById('ts-ready-error');
  tsRunningPanel = document.getElementById('ts-running-panel');
  tsCountdown = document.getElementById('ts-countdown');
  tsStopwatch = document.getElementById('ts-stopwatch');
  tsStopBtn = document.getElementById('ts-stop-btn');
  tsWaitingStops = document.getElementById('ts-waiting-stops');
  tsSpectateHint = document.getElementById('ts-spectate-hint');
  tsResultsPanel = document.getElementById('ts-results-panel');
  tsResultsBody = document.getElementById('ts-results-body');
  tsContinueBtn = document.getElementById('ts-continue-btn');
  tsContinueWaiting = document.getElementById('ts-continue-waiting');
  tsGameoverPanel = document.getElementById('ts-gameover-panel');
  tsChampion = document.getElementById('ts-champion');
  tsStandings = document.getElementById('ts-standings');
  tsScoreboard = document.getElementById('ts-scoreboard');
  tsPlayAgainBtn = document.getElementById('ts-play-again-btn');
  tsPlayAgainWaiting = document.getElementById('ts-play-again-waiting');
  tsBackBtn = document.getElementById('ts-back-btn');
  tsError = document.getElementById('ts-error');
}

function stopTsTick() {
  if (tsTickHandle) {
    clearInterval(tsTickHandle);
    tsTickHandle = null;
  }
}

function tickTsRound() {
  if (!tsRoundStartAt) return;
  const now = Date.now();
  const untilStart = tsRoundStartAt - now;

  if (untilStart > 0) {
    tsCountdown.classList.remove('hidden');
    tsStopwatch.classList.add('hidden');
    tsStopBtn.classList.add('hidden');
    if (untilStart > 2000) {
      tsCountdown.textContent = '3';
      tsCountdown.classList.remove('ts-go');
    } else if (untilStart > 1000) {
      tsCountdown.textContent = '2';
      tsCountdown.classList.remove('ts-go');
    } else if (untilStart > 400) {
      tsCountdown.textContent = '1';
      tsCountdown.classList.remove('ts-go');
    } else {
      tsCountdown.textContent = 'GO';
      tsCountdown.classList.add('ts-go');
    }
    return;
  }

  tsCountdown.classList.add('hidden');

  if (!tsIsContender || tsHasStopped) {
    tsStopwatch.classList.add('hidden');
    tsStopBtn.classList.add('hidden');
    return;
  }

  const elapsed = now - tsRoundStartAt;
  tsStopwatch.classList.remove('hidden');
  tsStopwatch.textContent = formatTsTime(elapsed);
  tsStopBtn.classList.remove('hidden');
  tsStopBtn.disabled = false;
}

function startTsTick() {
  stopTsTick();
  tickTsRound();
  tsTickHandle = setInterval(tickTsRound, 16);
}

function applyTensSecondsState(data) {
  ctx.setHost(data.host);
  tsError.textContent = '';
  tsRoundStartAt = data.roundStartAt || null;
  tsIsContender = !!data.isContender;
  tsHasStopped = !!(data.myResult && !data.myResult.dnf);

  tsBadge.classList.toggle('hidden', !data.eliminated);
  tsReadyPanel.classList.add('hidden');
  tsRunningPanel.classList.add('hidden');
  tsResultsPanel.classList.add('hidden');
  tsGameoverPanel.classList.add('hidden');
  stopTsTick();

  const isHost = ctx.getIsHost();

  if (data.phase === 'ready') {
    tsTitle.textContent = '10 Seconds';
    tsSubtitle.textContent =
      data.roundNumber > 0 ? `Round ${data.roundNumber + 1}` : 'Stop as close as you can to 10.000s';
    tsReadyPanel.classList.remove('hidden');

    tsPlayerList.innerHTML = '';
    data.activePlayers.forEach((n) => {
      const li = document.createElement('li');
      const waiting = (data.waitingOn || []).includes(n);
      li.textContent = waiting ? `${n} (disconnected)` : n;
      if (waiting) li.classList.add('ts-disconnected');
      tsPlayerList.appendChild(li);
    });

    const waitingMsg =
      data.waitingOn && data.waitingOn.length
        ? `Waiting for ${data.waitingOn.join(', ')} to reconnect`
        : '';
    tsReadyError.textContent = waitingMsg;

    const label = data.roundNumber > 0 ? 'Next Round' : 'Start';
    tsStartBtn.textContent = label;
    tsStartBtn.classList.toggle('hidden', !isHost);
    tsStartBtn.disabled = !data.canStart;
    tsStartWaiting.classList.toggle('hidden', isHost);
    return;
  }

  if (data.phase === 'running') {
    tsTitle.textContent = data.suddenDeath ? 'Sudden Death!' : `Round ${data.roundNumber}`;
    tsSubtitle.textContent = data.suddenDeath
      ? `Tiebreaker — ${data.contenders.join(' vs ')}`
      : 'Stop as close as you can to 10.000s';
    tsRunningPanel.classList.remove('hidden');

    const spectating = data.eliminated || !data.isContender;
    tsSpectateHint.classList.toggle('hidden', !spectating);
    tsWaitingStops.classList.toggle('hidden', !(data.isContender && tsHasStopped));
    tsStopBtn.classList.add('hidden');
    tsStopwatch.classList.add('hidden');
    tsCountdown.classList.add('hidden');

    if (data.isContender && data.myResult && !data.myResult.dnf) {
      tsStopwatch.classList.remove('hidden');
      tsStopwatch.textContent = formatTsTime(data.myResult.elapsedMs);
      tsWaitingStops.classList.remove('hidden');
    } else if (data.isContender) {
      startTsTick();
    } else {
      // Spectators still see the shared countdown.
      startTsTick();
      tsStopwatch.classList.add('hidden');
      tsStopBtn.classList.add('hidden');
    }
    return;
  }

  if (data.phase === 'roundResults') {
    tsTitle.textContent = `Round ${data.roundNumber} Results`;
    tsSubtitle.textContent = '';
    tsResultsPanel.classList.remove('hidden');

    const rows = (data.contenders || []).map((name) => {
      const r = (data.results && data.results[name]) || {};
      return { name, ...r };
    });
    rows.sort((a, b) => {
      const da = a.dnf ? Number.POSITIVE_INFINITY : a.distanceMs;
      const db = b.dnf ? Number.POSITIVE_INFINITY : b.distanceMs;
      return da - db;
    });

    const justEliminated = new Set(
      (data.eliminatedOrder || []).filter((n) => (data.contenders || []).includes(n) && !(data.activePlayers || []).includes(n))
    );

    tsResultsBody.innerHTML = '';
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      if (justEliminated.has(row.name)) tr.classList.add('ts-eliminated-row');
      const timeText = row.dnf ? 'DNF' : formatTsTime(row.elapsedMs);
      const distText = row.dnf ? 'DNF' : formatTsDistance(row.distanceMs);
      tr.innerHTML = `<td>${row.name}${justEliminated.has(row.name) ? ' ✕' : ''}</td><td>${timeText}</td><td>${distText}</td>`;
      tsResultsBody.appendChild(tr);
    });

    tsContinueBtn.classList.toggle('hidden', !isHost);
    tsContinueBtn.textContent = data.activePlayers.length <= 1 ? 'See Standings' : 'Next Round';
    tsContinueWaiting.classList.toggle('hidden', isHost);
    return;
  }

  if (data.phase === 'gameover') {
    tsTitle.textContent = 'Game Over';
    tsSubtitle.textContent = '';
    tsGameoverPanel.classList.remove('hidden');
    const champion = (data.standings && data.standings[0]) || (data.activePlayers && data.activePlayers[0]) || '';
    tsChampion.textContent = champion ? `${champion} is the 10-Second Champion!` : 'No champion';
    tsStandings.innerHTML = '';
    (data.standings || []).forEach((name, i) => {
      const li = document.createElement('li');
      li.textContent = `${i + 1}. ${name}`;
      if (i === 0) li.classList.add('ts-champion-row');
      tsStandings.appendChild(li);
    });
    renderScoreboard(tsScoreboard, data.scoreboard || []);
    tsPlayAgainBtn.classList.toggle('hidden', !isHost);
    tsPlayAgainWaiting.classList.toggle('hidden', isHost);
  }
}

function bindButtons() {
  tsStartBtn.addEventListener('click', () => {
    tsReadyError.textContent = '';
    tsError.textContent = '';
    ctx.socket.emit('startTensSeconds', (res) => {
      if (res && !res.ok) tsReadyError.textContent = res.error;
    });
  });

  tsStopBtn.addEventListener('click', () => {
    if (!tsRoundStartAt || tsHasStopped) return;
    const elapsed = Date.now() - tsRoundStartAt;
    if (elapsed < 0) return;
    tsHasStopped = true;
    tsStopBtn.disabled = true;
    stopTsTick();
    tsStopwatch.textContent = formatTsTime(elapsed);
    ctx.socket.emit('tsStop', elapsed, (res) => {
      if (res && !res.ok) {
        tsHasStopped = false;
        tsError.textContent = res.error || 'Could not submit stop';
      }
    });
  });

  tsContinueBtn.addEventListener('click', () => {
    ctx.socket.emit('tsContinue', (res) => {
      if (res && !res.ok) tsError.textContent = res.error;
    });
  });

  tsPlayAgainBtn.addEventListener('click', () => {
    ctx.socket.emit('playAgainTensSeconds', (res) => {
      if (res && !res.ok) tsError.textContent = res.error;
    });
  });

  tsBackBtn.addEventListener('click', () => {
    ctx.socket.emit('backToLobby', () => {});
  });
}

export const TensSeconds = {
  init(gameCtx) {
    ctx = gameCtx;
    queryDom();
    bindButtons();
    ctx.socket.on('tensSecondsState', (data) => {
      TensSeconds.applyState(data);
      ctx.showScreen('tensSeconds');
    });
  },

  applyState(data) {
    applyTensSecondsState(data);
  },

  applyJoin(res) {
    applyTensSecondsState(res);
    ctx.showScreen('tensSeconds');
  },

  stop() {
    stopTsTick();
    tsRoundStartAt = null;
    tsHasStopped = false;
    tsIsContender = false;
    if (tsError) tsError.textContent = '';
  },
};
