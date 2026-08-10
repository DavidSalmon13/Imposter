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
  kartRace: document.getElementById('kart-race-screen'),
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
  } else {
    generatingTitle.textContent = 'Picking a word…';
    generatingSubtitle.textContent = 'Asking ChatGPT to come up with a word and hint.';
  }
  showScreen('generating');
}
