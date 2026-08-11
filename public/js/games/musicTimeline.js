/** Music Timeline client module: team-select/setup and the full match loop. */

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
const mtSongLink = document.getElementById('mt-song-link');
const mtWaitingSong = document.getElementById('mt-waiting-song');
const mtRevealBtn = document.getElementById('mt-reveal-btn');
const mtRevealPanel = document.getElementById('mt-reveal-panel');
const mtRevealResult = document.getElementById('mt-reveal-result');
const mtRevealChallenge = document.getElementById('mt-reveal-challenge');
const mtRevealSong = document.getElementById('mt-reveal-song');
const mtTurnDecision = document.getElementById('mt-turn-decision');
const mtContinueTurnBtn = document.getElementById('mt-continue-turn-btn');
const mtStopTurnBtn = document.getElementById('mt-stop-turn-btn');
const mtTurnDecisionWaiting = document.getElementById('mt-turn-decision-waiting');
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

const MT_TEAM_COLORS = ['var(--team-red)', 'var(--team-blue)', 'var(--success)', 'var(--accent-2)'];

/**
 * Renders a team's timeline as a horizontal strip of song cards. When `interactive` or `locked`
 * is set, a round slot button is drawn before/between/after every card so the active (or
 * challenging) team can tap where the new song goes; otherwise it's just the cards. The last
 * `pendingCount` cards are marked as not yet banked (see the push-your-luck turn loop).
 */
function renderTimeline(container, timeline, opts = {}) {
  const { pendingCount = 0, interactive = false, locked = false, pendingSlotIndex = null, onPick = null } = opts;
  container.className = 'mt-timeline';
  container.innerHTML = '';

  if (!timeline.length && !interactive && !locked) {
    const empty = document.createElement('span');
    empty.className = 'mt-card-empty';
    empty.textContent = 'No cards yet';
    container.appendChild(empty);
    return;
  }

  const showSlots = interactive || locked;
  const pendingFrom = timeline.length - pendingCount;

  const addSlot = (index) => {
    if (!showSlots) return;
    const btn = document.createElement('button');
    btn.className = 'mt-slot';
    btn.textContent = '+';
    btn.title = 'Place here';
    btn.classList.toggle('selected', locked && pendingSlotIndex === index);
    btn.disabled = locked || !interactive;
    if (!btn.disabled) {
      btn.addEventListener('click', () => onPick(index));
    }
    container.appendChild(btn);
  };

  addSlot(0);
  timeline.forEach((song, i) => {
    const card = document.createElement('div');
    card.className = 'mt-card';
    if (i >= pendingFrom) card.classList.add('mt-card-pending');

    const year = document.createElement('div');
    year.className = 'mt-card-year';
    year.textContent = song.releaseYear;
    card.appendChild(year);

    const title = document.createElement('div');
    title.className = 'mt-card-title';
    title.textContent = song.title;
    card.appendChild(title);

    const artist = document.createElement('div');
    artist.className = 'mt-card-artist';
    artist.textContent = song.artist;
    card.appendChild(artist);

    container.appendChild(card);
    addSlot(i + 1);
  });
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
  teams.forEach((team, i) => {
    const col = document.createElement('div');
    col.className = 'team-column mt-team-column';
    col.style.setProperty('--mt-team-color', MT_TEAM_COLORS[i % MT_TEAM_COLORS.length]);

    const header = document.createElement('div');
    header.className = 'mt-team-header';

    const name = document.createElement('span');
    name.className = 'mt-team-name';
    name.textContent = team.name;
    header.appendChild(name);

    const badges = document.createElement('div');
    badges.className = 'mt-team-badges';
    if (team.id === data.activeTeamId) {
      const b = document.createElement('span');
      b.className = 'mt-badge mt-badge-active';
      b.textContent = 'Active';
      badges.appendChild(b);
    }
    if (team.id === data.djTeamId) {
      const b = document.createElement('span');
      b.className = 'mt-badge mt-badge-dj';
      b.textContent = 'DJ';
      badges.appendChild(b);
    }
    if (challenge && challenge.team === team.id) {
      const b = document.createElement('span');
      b.className = 'mt-badge mt-badge-challenging';
      b.textContent = 'Challenging';
      badges.appendChild(b);
    }
    const tokens = document.createElement('span');
    tokens.className = 'mt-token-count';
    tokens.textContent = `🎫 ${team.tokens != null ? team.tokens : 0}`;
    badges.appendChild(tokens);
    header.appendChild(badges);
    col.appendChild(header);

    const timeline = team.timeline || [];
    const board = document.createElement('div');

    if (showSlots && team.id === data.activeTeamId) {
      renderTimeline(board, timeline, {
        pendingCount: team.pendingCount || 0,
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
    } else if (data.phase === 'locked' && challenge && challenge.team === team.id) {
      renderTimeline(board, timeline, {
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
    } else {
      renderTimeline(board, timeline, { pendingCount: team.pendingCount || 0 });
    }
    col.appendChild(board);

    mtTeamsPanel.appendChild(col);
  });

  mtLockedBadge.classList.toggle('hidden', data.phase !== 'locked');
  mtSongPanel.classList.add('hidden');
  mtWaitingSong.classList.add('hidden');
  mtChallengeBtn.classList.add('hidden');
  mtRevealBtn.classList.add('hidden');
  mtRevealPanel.classList.add('hidden');
  mtTurnDecision.classList.add('hidden');
  mtTurnDecisionWaiting.classList.add('hidden');
  mtNextTurnBtn.classList.add('hidden');
  mtNextTurnWaiting.classList.add('hidden');
  mtGameoverPanel.classList.add('hidden');
  mtPlayAgainBtn.classList.add('hidden');
  mtPlayAgainWaiting.classList.add('hidden');

  if (data.phase === 'ready') {
    mtNextTurnBtn.classList.toggle('hidden', !isHost);
    mtNextTurnWaiting.classList.toggle('hidden', isHost);
  } else if (data.phase === 'placing' || data.phase === 'locked') {
    const isDj = data.myTeam != null && data.myTeam === data.djTeamId;
    if (isDj && data.currentSong) {
      mtSongPanel.classList.remove('hidden');
      mtSongDisplay.textContent = formatMtSong(data.currentSong);
      mtSongLink.href = data.currentSongUrl || '#';
    } else {
      mtWaitingSong.classList.remove('hidden');
      const djTeam = teams.find((t) => t.id === data.djTeamId);
      mtWaitingSong.textContent = djTeam
        ? `Listen up - ${djTeam.name} has the song queued up…`
        : 'Listen up - waiting on the song…';
    }

    mtChallengeBtn.classList.toggle('hidden', !data.canChallenge);
    mtRevealBtn.classList.toggle('hidden', !(isHost && data.phase === 'locked'));
  } else if (data.phase === 'revealed') {
    mtRevealPanel.classList.remove('hidden');

    const result = data.revealResult;
    const correct = !!(result && result.correct);
    const decisionPending = correct && !data.turnOver;
    mtRevealResult.textContent = result ? (correct ? 'Correct' : 'Wrong') : '';
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

    if (decisionPending) {
      const isActiveTeamMember = data.myTeam === data.activeTeamId;
      mtTurnDecision.classList.toggle('hidden', !isActiveTeamMember);
      mtTurnDecisionWaiting.classList.toggle('hidden', isActiveTeamMember);
    } else {
      mtNextTurnBtn.classList.toggle('hidden', !isHost);
      mtNextTurnWaiting.classList.toggle('hidden', isHost);
    }
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

    mtContinueTurnBtn.addEventListener('click', () => {
      mtMatchError.textContent = '';
      socket.emit('mtContinueTurn', (res) => {
        if (res && !res.ok) mtMatchError.textContent = res.error;
      });
    });

    mtStopTurnBtn.addEventListener('click', () => {
      mtMatchError.textContent = '';
      socket.emit('mtStopTurn', (res) => {
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
