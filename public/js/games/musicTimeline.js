/**
 * Music Timeline client module. Team-select/setup and the start of the match loop (starting
 * cards + song generation) are real; placement/reveal/tokens land in later steps.
 */

import { renderScoreboard } from '../shared/scoreboard.js';

const mtSetupPanel = document.getElementById('mt-setup-panel');
const mtModeBtns = Array.from(document.querySelectorAll('.mt-mode-btn'));
const mtTeamCountSection = document.getElementById('mt-team-count-section');
const mtTeamCountBtns = Array.from(document.querySelectorAll('.mt-team-count-btn'));
const mtDifficultyBtns = Array.from(document.querySelectorAll('.mt-difficulty-btn'));
const mtTeamColumns = document.getElementById('mt-team-columns');
const mtStartBtn = document.getElementById('mt-start-btn');
const mtStartWaiting = document.getElementById('mt-start-waiting');
const mtSetupError = document.getElementById('mt-setup-error');

const mtMatchPanel = document.getElementById('mt-match-panel');
const mtRoundLabel = document.getElementById('mt-round-label');
const mtTeamsPanel = document.getElementById('mt-teams-panel');
const mtLockedBadge = document.getElementById('mt-locked-badge');
const mtChallengeBtn = document.getElementById('mt-challenge-btn');
const mtSongPanel = document.getElementById('mt-song-panel');
const mtSongDisplay = document.getElementById('mt-song-display');
const mtWaitingSong = document.getElementById('mt-waiting-song');
const mtTokenActions = document.getElementById('mt-token-actions');
const mtSkipBtn = document.getElementById('mt-skip-btn');
const mtAutoCardBtn = document.getElementById('mt-auto-card-btn');
const mtRevealBtn = document.getElementById('mt-reveal-btn');
const mtRevealPanel = document.getElementById('mt-reveal-panel');
const mtRevealResult = document.getElementById('mt-reveal-result');
const mtRevealChallenge = document.getElementById('mt-reveal-challenge');
const mtRevealSong = document.getElementById('mt-reveal-song');
const mtConfirmIdLabel = document.getElementById('mt-confirm-id-label');
const mtConfirmIdCheckbox = document.getElementById('mt-confirm-id-checkbox');
const mtNextTurnBtn = document.getElementById('mt-next-turn-btn');
const mtNextTurnWaiting = document.getElementById('mt-next-turn-waiting');

const mtGameoverPanel = document.getElementById('mt-gameover-panel');
const mtChampion = document.getElementById('mt-champion');
const mtStandings = document.getElementById('mt-standings');
const mtScoreboard = document.getElementById('mt-scoreboard');
const mtPlayAgainBtn = document.getElementById('mt-play-again-btn');
const mtPlayAgainWaiting = document.getElementById('mt-play-again-waiting');

const mtMatchError = document.getElementById('mt-match-error');

const mtBackBtn = document.getElementById('mt-back-btn');

let ctx = null;

function formatMtSong(song) {
  return `"${song.title}" — ${song.artist} (${song.releaseYear})`;
}

/** Renders a timeline as BEFORE / BETWEEN×N / AFTER slot buttons around each known year. */
function renderTimelineSlots(container, timeline, { interactive, locked, pendingSlotIndex, onPick }) {
  container.innerHTML = '';
  const row = document.createElement('div');
  row.className = 'mt-timeline-row';

  const addSlot = (index, label) => {
    const btn = document.createElement('button');
    btn.className = 'level-btn mt-slot-btn';
    btn.textContent = label;
    btn.classList.toggle('selected', locked && pendingSlotIndex === index);
    btn.disabled = locked || !interactive;
    if (!btn.disabled) {
      btn.addEventListener('click', () => onPick(index));
    }
    row.appendChild(btn);
  };

  addSlot(0, 'BEFORE');
  timeline.forEach((song, i) => {
    const chip = document.createElement('span');
    chip.className = 'mt-song-chip';
    chip.textContent = song.releaseYear;
    row.appendChild(chip);
    addSlot(i + 1, i === timeline.length - 1 ? 'AFTER' : 'BETWEEN');
  });

  container.appendChild(row);
}

function renderTeamSelect(data) {
  ctx.setHost(data.host);
  mtSetupError.textContent = '';
  mtMatchPanel.classList.add('hidden');
  mtSetupPanel.classList.remove('hidden');

  const isHost = ctx.getIsHost();
  const myName = ctx.getMyName();
  const mode = data.mode || 'team';
  const teams = data.teams || [];

  mtModeBtns.forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.mode === mode);
    btn.disabled = !isHost;
  });

  mtDifficultyBtns.forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.difficulty === data.difficulty);
    btn.disabled = !isHost;
  });

  const isTeamMode = mode === 'team';
  mtTeamCountSection.classList.toggle('hidden', !isTeamMode);
  mtTeamCountBtns.forEach((btn) => {
    btn.classList.toggle('selected', Number(btn.dataset.count) === teams.length);
    btn.disabled = !isHost;
  });

  mtTeamColumns.classList.toggle('hidden', !isTeamMode);
  mtTeamColumns.innerHTML = '';
  if (isTeamMode) {
    const myTeamId = (teams.find((t) => t.members.includes(myName)) || {}).id || null;
    teams.forEach((team) => {
      const col = document.createElement('div');
      col.className = 'team-column';

      const h2 = document.createElement('h2');
      h2.textContent = team.name;
      col.appendChild(h2);

      const ul = document.createElement('ul');
      ul.className = 'player-list';
      team.members.forEach((m) => {
        const li = document.createElement('li');
        li.textContent = m;
        ul.appendChild(li);
      });
      col.appendChild(ul);

      const joinBtn = document.createElement('button');
      joinBtn.className = 'secondary';
      joinBtn.textContent = `Join ${team.name}`;
      joinBtn.classList.toggle('hidden', myTeamId === team.id);
      joinBtn.addEventListener('click', () => {
        mtSetupError.textContent = '';
        ctx.socket.emit('joinMtTeam', { teamId: team.id }, (res) => {
          if (res && !res.ok) mtSetupError.textContent = res.error;
        });
      });
      col.appendChild(joinBtn);

      mtTeamColumns.appendChild(col);
    });
  }

  mtStartBtn.classList.toggle('hidden', !isHost);
  mtStartBtn.disabled = !data.canStart;
  mtStartWaiting.classList.toggle('hidden', isHost);
}

function renderMatch(data) {
  ctx.setHost(data.host);
  mtMatchError.textContent = '';
  mtSetupPanel.classList.add('hidden');
  mtMatchPanel.classList.remove('hidden');

  const isHost = ctx.getIsHost();
  const teams = data.teams || [];
  const activeTeam = teams.find((t) => t.id === data.activeTeamId);

  mtRoundLabel.textContent =
    activeTeam && data.phase !== 'gameover'
      ? `Round ${(data.roundNumber || 0) + 1} — ${activeTeam.name}'s turn`
      : '';

  const showSlots =
    (data.phase === 'placing' || data.phase === 'locked') && data.activeTeamId != null;
  const challenge = data.currentChallenge;

  mtTeamsPanel.innerHTML = '';
  teams.forEach((team) => {
    const col = document.createElement('div');
    col.className = 'team-column';

    const h2 = document.createElement('h2');
    let label = team.id === data.activeTeamId ? `${team.name} (active)` : team.name;
    if (challenge && challenge.team === team.id) label += ' (challenging)';
    h2.textContent = `${label} — 🎫${team.tokens != null ? team.tokens : 0}`;
    col.appendChild(h2);

    const timeline = team.timeline || [];

    if (showSlots && team.id === data.activeTeamId) {
      const slots = document.createElement('div');
      renderTimelineSlots(slots, timeline, {
        interactive: data.phase === 'placing' && data.myTeam === data.activeTeamId,
        locked: data.phase === 'locked',
        pendingSlotIndex: data.pendingSlotIndex,
        onPick: (slotIndex) => {
          mtMatchError.textContent = '';
          ctx.socket.emit('mtPlaceSong', { slotIndex }, (res) => {
            if (res && !res.ok) mtMatchError.textContent = res.error;
          });
        },
      });
      col.appendChild(slots);
    } else if (data.phase === 'locked' && challenge && challenge.team === team.id) {
      const slots = document.createElement('div');
      renderTimelineSlots(slots, timeline, {
        interactive: data.myTeam === challenge.team && challenge.slotIndex == null,
        locked: challenge.slotIndex != null,
        pendingSlotIndex: challenge.slotIndex,
        onPick: (slotIndex) => {
          mtMatchError.textContent = '';
          ctx.socket.emit('mtChallengePlace', { slotIndex }, (res) => {
            if (res && !res.ok) mtMatchError.textContent = res.error;
          });
        },
      });
      col.appendChild(slots);
    } else {
      const ul = document.createElement('ul');
      ul.className = 'player-list';
      if (timeline.length) {
        timeline.forEach((song) => {
          const li = document.createElement('li');
          li.textContent = formatMtSong(song);
          ul.appendChild(li);
        });
      } else {
        const li = document.createElement('li');
        li.textContent = 'No cards yet';
        ul.appendChild(li);
      }
      col.appendChild(ul);
    }

    mtTeamsPanel.appendChild(col);
  });

  mtLockedBadge.classList.toggle('hidden', data.phase !== 'locked');
  mtSongPanel.classList.add('hidden');
  mtWaitingSong.classList.add('hidden');
  mtTokenActions.classList.add('hidden');
  mtChallengeBtn.classList.add('hidden');
  mtRevealBtn.classList.add('hidden');
  mtRevealPanel.classList.add('hidden');
  mtNextTurnBtn.classList.add('hidden');
  mtNextTurnWaiting.classList.add('hidden');
  mtGameoverPanel.classList.add('hidden');
  mtPlayAgainBtn.classList.add('hidden');
  mtPlayAgainWaiting.classList.add('hidden');

  if (data.phase === 'ready') {
    mtNextTurnBtn.classList.toggle('hidden', !isHost);
    mtNextTurnWaiting.classList.toggle('hidden', isHost);
  } else if (data.phase === 'placing' || data.phase === 'locked') {
    if (isHost && data.currentSong) {
      mtSongPanel.classList.remove('hidden');
      mtSongDisplay.textContent = formatMtSong(data.currentSong);
    } else {
      mtWaitingSong.classList.remove('hidden');
    }

    const isActiveTeamMember = data.myTeam === data.activeTeamId;
    mtTokenActions.classList.toggle('hidden', !(isActiveTeamMember && data.phase === 'placing'));
    mtSkipBtn.disabled = !data.canSkip;
    mtAutoCardBtn.disabled = !data.canAutoCard;

    mtChallengeBtn.classList.toggle('hidden', !data.canChallenge);
    mtRevealBtn.classList.toggle('hidden', !(isHost && data.phase === 'locked'));
  } else if (data.phase === 'revealed') {
    mtRevealPanel.classList.remove('hidden');

    const result = data.revealResult;
    const resultTeam = teams.find((t) => t.id === (result && result.teamId));
    const correct = !!(result && result.correct);
    mtRevealResult.textContent = result
      ? correct
        ? `✅ Correct! ${resultTeam ? resultTeam.name : 'The team'}'s timeline grew.`
        : `❌ Incorrect — the card is discarded.`
      : '';
    mtRevealResult.classList.toggle('correct', correct);
    mtRevealResult.classList.toggle('incorrect', !!result && !correct);

    const challengeResult = result && result.challenge;
    const challengeTeam = teams.find((t) => t.id === (challengeResult && challengeResult.teamId));
    mtRevealChallenge.textContent = challengeResult
      ? challengeResult.correct
        ? `⚔️ ${challengeTeam ? challengeTeam.name : 'The challenger'}'s challenge succeeded — they claimed the card!`
        : `⚔️ ${challengeTeam ? challengeTeam.name : 'The challenger'}'s challenge failed — they lost a token.`
      : '';
    mtRevealChallenge.classList.toggle('hidden', !challengeResult);
    mtRevealChallenge.classList.toggle('correct', !!challengeResult && challengeResult.correct);
    mtRevealChallenge.classList.toggle('incorrect', !!challengeResult && !challengeResult.correct);

    mtRevealSong.textContent = data.currentSong ? formatMtSong(data.currentSong) : '';

    mtConfirmIdLabel.classList.toggle('hidden', !isHost);
    mtConfirmIdCheckbox.checked = !!data.idConfirmed;
    mtConfirmIdCheckbox.disabled = !!data.idConfirmed;

    mtNextTurnBtn.classList.toggle('hidden', !isHost);
    mtNextTurnWaiting.classList.toggle('hidden', isHost);
  } else if (data.phase === 'gameover') {
    mtGameoverPanel.classList.remove('hidden');

    const winners = data.matchWinners || [];
    const winnerTeams = teams.filter((t) => winners.includes(t.id));
    mtChampion.textContent =
      winnerTeams.length === 0
        ? 'Match Over'
        : winnerTeams.length === 1
          ? `${winnerTeams[0].name} wins Music Timeline!`
          : `Co-champions: ${winnerTeams.map((t) => t.name).join(' & ')}!`;

    mtStandings.innerHTML = '';
    const standings = teams
      .map((t) => ({ id: t.id, name: t.name, cards: (t.timeline || []).length }))
      .sort((a, b) => b.cards - a.cards || a.name.localeCompare(b.name));
    let i = 0;
    while (i < standings.length) {
      let j = i + 1;
      while (j < standings.length && standings[j].cards === standings[i].cards) j += 1;
      const rank = i + 1;
      for (let k = i; k < j; k++) {
        const row = standings[k];
        const li = document.createElement('li');
        li.textContent = `#${rank} ${row.name} — ${row.cards} card${row.cards === 1 ? '' : 's'}`;
        if (winners.includes(row.id)) li.classList.add('ts-champion-row');
        mtStandings.appendChild(li);
      }
      i = j;
    }

    renderScoreboard(mtScoreboard, data.scoreboard || []);

    mtPlayAgainBtn.classList.toggle('hidden', !isHost);
    mtPlayAgainWaiting.classList.toggle('hidden', isHost);
  }
}

function applyState(data) {
  if (data.phase === 'generating') {
    ctx.showGenerating('musictimeline');
    return;
  }
  renderMatch(data);
  ctx.showScreen('musicTimeline');
}

function applyJoin(res) {
  if (res.phase === 'teamSelect') {
    renderTeamSelect(res);
    ctx.showScreen('musicTimeline');
  } else {
    applyState(res);
  }
}

export const MusicTimeline = {
  init(nextCtx) {
    ctx = nextCtx;
    const { socket } = ctx;

    mtModeBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!ctx.getIsHost()) return;
        mtSetupError.textContent = '';
        socket.emit('setMtMode', btn.dataset.mode, (res) => {
          if (res && !res.ok) mtSetupError.textContent = res.error;
        });
      });
    });

    mtTeamCountBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!ctx.getIsHost()) return;
        mtSetupError.textContent = '';
        socket.emit('setMtTeamCount', Number(btn.dataset.count), (res) => {
          if (res && !res.ok) mtSetupError.textContent = res.error;
        });
      });
    });

    mtDifficultyBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!ctx.getIsHost()) return;
        mtSetupError.textContent = '';
        socket.emit('setMtDifficulty', btn.dataset.difficulty, (res) => {
          if (res && !res.ok) mtSetupError.textContent = res.error;
        });
      });
    });

    mtStartBtn.addEventListener('click', () => {
      mtSetupError.textContent = '';
      socket.emit('startMusicTimeline', (res) => {
        if (res && !res.ok) mtSetupError.textContent = res.error;
      });
    });

    mtNextTurnBtn.addEventListener('click', () => {
      mtMatchError.textContent = '';
      socket.emit('mtNextTurn', (res) => {
        if (res && !res.ok) mtMatchError.textContent = res.error;
      });
    });

    mtSkipBtn.addEventListener('click', () => {
      mtMatchError.textContent = '';
      socket.emit('mtSkipSong', (res) => {
        if (res && !res.ok) mtMatchError.textContent = res.error;
      });
    });

    mtAutoCardBtn.addEventListener('click', () => {
      mtMatchError.textContent = '';
      socket.emit('mtAutoCard', (res) => {
        if (res && !res.ok) mtMatchError.textContent = res.error;
      });
    });

    mtChallengeBtn.addEventListener('click', () => {
      mtMatchError.textContent = '';
      socket.emit('mtChallenge', (res) => {
        if (res && !res.ok) mtMatchError.textContent = res.error;
      });
    });

    mtRevealBtn.addEventListener('click', () => {
      mtMatchError.textContent = '';
      socket.emit('mtReveal', (res) => {
        if (res && !res.ok) mtMatchError.textContent = res.error;
      });
    });

    mtConfirmIdCheckbox.addEventListener('change', () => {
      if (!mtConfirmIdCheckbox.checked) return;
      mtMatchError.textContent = '';
      socket.emit('mtConfirmId', (res) => {
        if (res && !res.ok) mtMatchError.textContent = res.error;
      });
    });

    mtPlayAgainBtn.addEventListener('click', () => {
      mtMatchError.textContent = '';
      socket.emit('playAgainMusicTimeline', (res) => {
        if (res && !res.ok) mtMatchError.textContent = res.error;
      });
    });

    mtBackBtn.addEventListener('click', () => {
      socket.emit('backToLobby', () => {});
    });

    socket.on('mtTeamSelectUpdate', (data) => {
      renderTeamSelect(data);
      ctx.showScreen('musicTimeline');
    });

    socket.on('mtState', (data) => {
      applyState(data);
    });

    socket.on('mtStartFailed', ({ error }) => {
      mtSetupError.textContent = error;
      mtMatchError.textContent = error;
    });
  },

  applyState,

  applyJoin,

  stop() {
    mtSetupError.textContent = '';
    mtMatchError.textContent = '';
  },
};
