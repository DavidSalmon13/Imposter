/**
 * Warfront client module (specs/warfront-specs.md). A dumb renderer of the server's
 * wfState payloads. Step 3: the team-select screen, ported from
 * design/warfront/1-team-select.html.
 */

import { sfx, haptics } from '../fx.js';
import {
  UNIT_SPRITES,
  CASTLE_SPRITE,
  TREE_SPRITES,
  RACE_LINEUPS,
  RACE_PORTRAITS,
} from './warfrontSprites.js';

const RACES = [
  { id: 'forge', name: 'FORGE', desc: 'The great builders. Defense + economy; fields structures.' },
  { id: 'horde', name: 'HORDE', desc: 'The great fighters. Raw combat; reliable brutes.' },
  { id: 'arcane', name: 'ARCANE', desc: 'The magicians. Area magic + luck manipulation.' },
];
const MATCH_LENGTHS = [
  { id: 'short', label: '8 MIN' },
  { id: 'standard', label: '12 MIN' },
  { id: 'long', label: '16 MIN' },
];
const MAP_SIZES = [
  { id: 'small', label: 'SMALL' },
  { id: 'medium', label: 'MEDIUM' },
  { id: 'large', label: 'LARGE' },
];

const $ = (id) => document.getElementById(id);
const vista = $('wf-team-vista');
const subEl = $('wf-team-sub');
const hostBadge = $('wf-host-badge');
const slotsEl = { red: $('wf-red-slots'), blue: $('wf-blue-slots') };
const countEl = { red: $('wf-red-count'), blue: $('wf-blue-count') };
const joinBtn = { red: $('wf-join-red'), blue: $('wf-join-blue') };
const captainBtn = $('wf-captain-btn');
const benchEl = $('wf-bench');
const raceList = $('wf-race-list');
const settingsEl = $('wf-settings');
const lengthSeg = $('wf-length-seg');
const sizeSeg = $('wf-size-seg');
const randomizeBtn = $('wf-randomize-btn');
const startBtn = $('wf-start-btn');
const statusEl = $('wf-team-status');
const errorEl = $('wf-team-error');
const backBtn = $('wf-team-back-btn');

let ctx = null;
let state = null;
let errorTimer = null;
const raceButtons = {};
const lengthButtons = {};
const sizeButtons = {};

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html != null) node.innerHTML = html;
  return node;
}

function flashError(msg) {
  clearTimeout(errorTimer);
  errorEl.classList.remove('wf-notice');
  errorEl.textContent = msg || '';
  if (msg) {
    sfx.error();
    haptics.warn();
    errorTimer = setTimeout(() => {
      errorEl.textContent = '';
    }, 3500);
  }
}

function emit(event, ...args) {
  ctx.socket.emit(event, ...args, (res) => {
    if (res && !res.ok) flashError(res.error);
  });
}

// ---------- Static parts (built once) ----------

/** The vista header's little battlefield: river, two plateaus, trees and both castles. */
function buildVista() {
  const river = [[255, 0], [252, 70], [248, 140], [246, 210], [248, 280], [252, 350], [256, 420]];
  const terrain = el('div', 'terrain');
  river.forEach(([x, y]) => {
    const shore = el('span', 'shore');
    shore.style.left = `${x - 54}px`;
    shore.style.top = `${y - 50}px`;
    terrain.appendChild(shore);
  });
  river.forEach(([x, y]) => {
    const water = el('span', 'water');
    water.style.left = `${x - 44}px`;
    water.style.top = `${y - 41}px`;
    terrain.appendChild(water);
  });
  vista.appendChild(terrain);

  [[40, 200], [310, 200]].forEach(([x, y]) => {
    const plat = el(
      'div',
      'plat',
      '<div class="pw pw-f" style="height: 30px"></div><div class="pw pw-l" style="width: 30px"></div><div class="pw pw-r" style="width: 30px"></div><div class="ptop"></div>',
    );
    Object.assign(plat.style, { left: `${x}px`, top: `${y}px`, width: '150px', height: '130px', transform: 'translateZ(30px)' });
    vista.appendChild(plat);
  });

  const trees = [[200, 330, 1.1, false], [300, 345, 1, true], [20, 350, 1.1, true], [480, 350, 1.1, false], [210, 240, 0.9, true], [296, 230, 0.9, false]];
  trees.forEach(([x, y, s, pine]) => {
    const ent = el('div', 'ent');
    ent.style.left = `${x}px`;
    ent.style.top = `${y}px`;
    ent.appendChild(el('span', 'dec tshadow'));
    const bb = el('div', 'bb', pine ? TREE_SPRITES.pine : TREE_SPRITES.leaf);
    bb.style.width = `${Math.round(46 * s)}px`;
    bb.style.height = `${Math.round(64 * s)}px`;
    ent.appendChild(bb);
    vista.appendChild(ent);
  });

  [['red', 115], ['blue', 385]].forEach(([team, x]) => {
    const ent = el('div', `ent tm-${team}`);
    Object.assign(ent.style, { left: `${x}px`, top: '300px', transform: 'translateZ(30px)' });
    ent.appendChild(el('span', `dec aura-${team}`));
    const bb = el('div', 'bb', CASTLE_SPRITE);
    bb.style.width = '130px';
    bb.style.height = '130px';
    ent.appendChild(bb);
    vista.appendChild(ent);
  });
}

function buildRaceCards() {
  RACES.forEach((race) => {
    const btn = el('button', `race r-${race.id}`);
    btn.type = 'button';
    btn.setAttribute('aria-pressed', 'false');
    const stage = el('span', 'stage tm-red');
    // Mockup lineup(left, front, right): the front figure sits in the middle, on top.
    const [left, front, right] = RACE_LINEUPS[race.id];
    [[left, 4, 1], [right, 78, 1], [front, 40, 2]].forEach(([unit, x, z]) => {
      const fig = el('span', 'fig', UNIT_SPRITES[unit]);
      fig.style.left = `${x}px`;
      fig.style.zIndex = z;
      stage.appendChild(fig);
    });
    btn.appendChild(stage);
    const text = el('span');
    text.style.cssText = 'display: flex; flex-direction: column; min-width: 0';
    text.appendChild(el('span', 'nm')).textContent = race.name;
    text.appendChild(el('span', 'ds')).textContent = race.desc;
    btn.appendChild(text);
    btn.appendChild(el('span', 'pick')).textContent = '■ SELECTED';
    btn.addEventListener('click', () => {
      if (state && state.myRace === race.id) return;
      markRace(race.id); // instant feedback; the next wfState confirms
      emit('setWfRace', race.id);
    });
    raceButtons[race.id] = btn;
    raceList.appendChild(btn);
  });
}

function buildSeg(container, options, store, onPick) {
  options.forEach((opt) => {
    const btn = el('button');
    btn.type = 'button';
    btn.textContent = opt.label;
    btn.addEventListener('click', () => onPick(opt.id));
    store[opt.id] = btn;
    container.appendChild(btn);
  });
}

function hostOption(key, value) {
  if (!ctx.getIsHost()) {
    flashError('Only the host can change the settings');
    return;
  }
  emit('setWfOptions', { [key]: value });
}

// ---------- Rendering ----------

function markRace(raceId) {
  RACES.forEach(({ id }) => {
    const on = id === raceId;
    raceButtons[id].classList.toggle('on', on);
    raceButtons[id].setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function playerSlot(player, team, you) {
  const slot = el('div', `slot${player.name === you ? ' wf-you' : ''}`);
  const portrait = el('span', `ri tm-${team}`, player.race ? UNIT_SPRITES[RACE_PORTRAITS[player.race]] : '');
  slot.appendChild(portrait);
  const nameCol = el('span', 'wf-pname');
  nameCol.appendChild(el('span')).textContent = player.name === you ? 'YOU' : player.name;
  const raceLabel = el('span', `wf-prace${player.race ? '' : ' wf-none'}`);
  raceLabel.textContent = player.race ? player.race.toUpperCase() : 'PICKING RACE…';
  nameCol.appendChild(raceLabel);
  slot.appendChild(nameCol);
  if (player.leader) {
    const crown = el('span', 'amb');
    crown.title = 'Captain';
    crown.textContent = '👑';
    slot.appendChild(crown);
  }
  return slot;
}

function renderTeams(data) {
  const me = [...data.red, ...data.blue].find((p) => p.name === data.you);
  const myTeam = data.red.some((p) => p.name === data.you) ? 'red' : data.blue.some((p) => p.name === data.you) ? 'blue' : null;
  ['red', 'blue'].forEach((team) => {
    const list = data[team];
    slotsEl[team].innerHTML = '';
    list.forEach((p) => slotsEl[team].appendChild(playerSlot(p, team, data.you)));
    if (list.length < data.maxTeamSize) slotsEl[team].appendChild(el('div', 'slot empty')).textContent = '— open —';
    countEl[team].textContent = `${list.length}/${data.maxTeamSize}`;
    const onIt = myTeam === team;
    joinBtn[team].classList.toggle('wf-on', onIt);
    joinBtn[team].textContent = onIt ? `On ${team === 'red' ? 'Red' : 'Blue'}` : `Join ${team === 'red' ? 'Red' : 'Blue'}`;
  });

  const myTeamList = myTeam ? data[myTeam] : [];
  const teamCaptain = myTeamList.find((p) => p.leader);
  if (me && me.leader) {
    captainBtn.textContent = '👑 You are Captain';
    captainBtn.disabled = true;
  } else if (teamCaptain) {
    captainBtn.textContent = `👑 Captain: ${teamCaptain.name}`;
    captainBtn.disabled = true;
  } else {
    captainBtn.textContent = '👑 Become Captain';
    captainBtn.disabled = !myTeam;
  }

  benchEl.classList.toggle('hidden', !data.unassigned.length);
  benchEl.innerHTML = '';
  if (data.unassigned.length) {
    benchEl.append('Not on a team: ');
    data.unassigned.forEach((p, i) => {
      if (i) benchEl.append(', ');
      benchEl.appendChild(el('b')).textContent = p.name === data.you ? 'You' : p.name;
    });
  }

  // The race stage figures wear your team's colour (red until you join one).
  RACES.forEach(({ id }) => {
    const stage = raceButtons[id].querySelector('.stage');
    stage.classList.toggle('tm-red', myTeam !== 'blue');
    stage.classList.toggle('tm-blue', myTeam === 'blue');
  });
}

function applyTeamSelect(data) {
  const isHost = data.host === data.you;
  const onTeams = data.red.length + data.blue.length;
  subEl.textContent = `Lobby · Room ${data.roomCode || ''} · ${onTeams}/${data.maxPlayers}`;
  hostBadge.classList.toggle('hidden', !isHost);

  renderTeams(data);
  markRace(data.myRace);

  settingsEl.classList.toggle('wf-locked', !isHost);
  MATCH_LENGTHS.forEach(({ id }) => lengthButtons[id].classList.toggle('on', data.options.matchLength === id));
  MAP_SIZES.forEach(({ id }) => sizeButtons[id].classList.toggle('on', data.options.mapSize === id));

  startBtn.disabled = !data.canStart || !data.canCommand;
  if (data.canStart) {
    statusEl.className = 'grn wf-status';
    statusEl.textContent = data.canCommand
      ? `ALL PLAYERS READY · ${data.red.length} v ${data.blue.length}`
      : `READY · ${data.red.length} v ${data.blue.length} · WAITING FOR HOST OR CAPTAIN`;
  } else {
    statusEl.className = 'amb wf-status';
    statusEl.textContent = data.startBlocker || '';
  }
}

function applyState(data) {
  if (!data || data.game !== 'warfront') return;
  state = data;
  if (data.phase === 'teamSelect') {
    applyTeamSelect(data);
    ctx.showScreen('warfrontTeam');
  } else if (data.phase === 'generating') {
    ctx.showGenerating('warfront');
  }
}

export const Warfront = {
  init(nextCtx) {
    ctx = nextCtx;
    const { socket } = ctx;

    buildVista();
    buildRaceCards();
    buildSeg(lengthSeg, MATCH_LENGTHS, lengthButtons, (id) => hostOption('matchLength', id));
    buildSeg(sizeSeg, MAP_SIZES, sizeButtons, (id) => hostOption('mapSize', id));

    ['red', 'blue'].forEach((team) => {
      joinBtn[team].addEventListener('click', () => {
        if (joinBtn[team].classList.contains('wf-on')) return;
        emit('joinWfTeam', team);
      });
    });
    captainBtn.addEventListener('click', () => emit('claimWfCaptain'));
    randomizeBtn.addEventListener('click', () => {
      if (!ctx.getIsHost()) {
        flashError('Only the host can randomize teams');
        return;
      }
      emit('randomizeWfTeams');
    });
    startBtn.addEventListener('click', () => emit('startWarfront'));
    backBtn.addEventListener('click', () => socket.emit('backToLobby', () => {}));

    socket.on('wfState', applyState);
    socket.on('wfNotice', ({ text }) => {
      clearTimeout(errorTimer);
      errorEl.classList.add('wf-notice');
      errorEl.textContent = text || '';
      errorTimer = setTimeout(() => {
        errorEl.textContent = '';
      }, 4000);
    });
  },

  applyState,

  applyJoin(res) {
    applyState(res);
  },

  stop() {
    state = null;
    clearTimeout(errorTimer);
    errorEl.textContent = '';
  },
};
