/**
 * Screen routing helpers shared by lobby and every game module.
 */

const generatingTitle = document.getElementById('generating-title');
const generatingSubtitle = document.getElementById('generating-subtitle');
const bgControls = document.getElementById('bg-controls');

export const screens = {
  join: document.getElementById('join-screen'),
  lobby: document.getElementById('lobby-screen'),
  voting: document.getElementById('voting-screen'),
  generating: document.getElementById('generating-screen'),
  game: document.getElementById('game-screen'),
  imposterReporting: document.getElementById('imposter-reporting-screen'),
  imposterResults: document.getElementById('imposter-results-screen'),
  teamSelect: document.getElementById('team-select-screen'),
  codenames: document.getElementById('codenames-screen'),
  codenamesGameover: document.getElementById('codenames-gameover-screen'),
  tensSeconds: document.getElementById('ts-screen'),
  menifot: document.getElementById('mf-screen'),
  musicTimeline: document.getElementById('mt-screen'),
  allInOrFold: document.getElementById('aiof-screen'),
  mindMeld: document.getElementById('mm-screen'),
  bluff: document.getElementById('bf-screen'),
};

export function showScreen(name) {
  Object.values(screens).forEach((el) => el.classList.add('hidden'));
  screens[name].classList.remove('hidden');
  bgControls.classList.toggle('hidden', name === 'join');
}

export function showGenerating(game) {
  if (game === 'codenames') {
    generatingTitle.textContent = 'Building the board…';
    generatingSubtitle.textContent = 'Asking ChatGPT for 25 words.';
  } else if (game === 'musictimeline') {
    generatingTitle.textContent = 'Picking a song…';
    generatingSubtitle.textContent = 'Asking ChatGPT for a song.';
  } else if (game === 'mindmeld') {
    generatingTitle.textContent = 'Thinking of a question…';
    generatingSubtitle.textContent = 'Asking ChatGPT to come up with a question.';
  } else {
    generatingTitle.textContent = 'Picking a word…';
    generatingSubtitle.textContent = 'Asking ChatGPT to come up with a word and hint.';
  }
  showScreen('generating');
}

/**
 * Marks `picked` as the selected chip among `buttons` right away, before the server
 * confirms - otherwise the highlight lags a full network round trip behind the tap.
 * The next state update from the server re-applies the real selection either way.
 */
export function selectChip(buttons, picked) {
  buttons.forEach((btn) => btn.classList.toggle('selected', btn === picked));
}
