/**
 * Warfront client: the team-select screen (docs/design/warfront/1-team-select.html).
 * Vista, race cards, host settings, team rosters and captains. Must NOT contain: battlefield code.
 * Spec: "Team select".
 */

import { S } from './store.js';
import { UNIT_SPRITES, CASTLE_SPRITE, TREE_SPRITES, RACE_LINEUPS, RACE_PORTRAITS } from './sprites.js';
import { RACES, MATCH_LENGTHS, MAP_SIZES, MODES } from './constants.js';
import {
  vista,
  subEl,
  hostBadge,
  slotsEl,
  countEl,
  joinBtn,
  captainBtn,
  teamsPanel,
  ffaRoster,
  ffaSlots,
  ffaCount,
  randomizeBtn,
  benchEl,
  raceList,
  settingsEl,
  startBtn,
  statusEl,
} from './dom.js';
import { el, flashError, emit } from './util.js';

// ---------- Static parts (built once) ----------

/** The vista header's little battlefield: river, two plateaus, trees and both castles. */
export function buildVista() {
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

  // Red and blue on their plateaus; in free for all green and gold appear behind them, across the
  // river (5a-ffa-team-select.html). Drawn first so the front castles overlap them.
  [['green', 175, 215, 65, 0], ['gold', 330, 215, 65, 0], ['red', 115, 300, 130, 30], ['blue', 385, 300, 130, 30]].forEach(([team, x, y, size, z]) => {
    const ent = el('div', `ent tm-${team}${size < 130 ? ' wf-ffa-castle' : ''}`);
    Object.assign(ent.style, { left: `${x}px`, top: `${y}px`, transform: `translateZ(${z}px)` });
    ent.appendChild(el('span', `dec aura-${team}`));
    const bb = el('div', 'bb', CASTLE_SPRITE);
    bb.style.width = `${size}px`;
    bb.style.height = `${size}px`;
    ent.appendChild(bb);
    vista.appendChild(ent);
  });
}

export function buildRaceCards() {
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
      if (S.state && S.state.myRace === race.id) return;
      markRace(race.id); // instant feedback; the next wfState confirms
      emit('setWfRace', race.id);
    });
    S.raceButtons[race.id] = btn;
    raceList.appendChild(btn);
  });
}

export function buildSeg(container, options, store, onPick) {
  options.forEach((opt) => {
    const btn = el('button');
    btn.type = 'button';
    btn.textContent = opt.label;
    btn.addEventListener('click', () => onPick(opt.id));
    store[opt.id] = btn;
    container.appendChild(btn);
  });
}

/** Teams / Free for all: host only (the server refuses anyone else too). */
export function setMode(mode) {
  if (!S.ctx.getIsHost()) {
    flashError('Only the host can change the mode');
    return;
  }
  if (S.state && S.state.mode === mode) return;
  emit('wfSetMode', mode);
}

export function hostOption(key, value) {
  if (!S.ctx.getIsHost()) {
    flashError('Only the host can change the settings');
    return;
  }
  emit('setWfOptions', { [key]: value });
}

// ---------- Rendering ----------

function markRace(raceId) {
  RACES.forEach(({ id }) => {
    const on = id === raceId;
    S.raceButtons[id].classList.toggle('on', on);
    S.raceButtons[id].setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function playerSlot(player, team, you, host = null) {
  const slot = el('div', `slot${player.name === you ? ' wf-you' : ''}`);
  const portrait = el('span', `ri tm-${team}`, player.race ? UNIT_SPRITES[RACE_PORTRAITS[player.race]] : '');
  slot.appendChild(portrait);
  const nameCol = el('span', 'wf-pname');
  nameCol.appendChild(el('span')).textContent = player.name === you ? 'YOU' : player.name;
  const raceLabel = el('span', `wf-prace${player.race ? '' : ' wf-none'}`);
  raceLabel.textContent = player.race ? player.race.toUpperCase() : 'PICKING RACE…';
  nameCol.appendChild(raceLabel);
  slot.appendChild(nameCol);
  if (host && player.name === host) {
    // Free for all has no captains: the host starts, so the host is marked instead.
    const crown = el('span', 'amb wf-host-tag');
    crown.title = 'Host';
    crown.textContent = '👑 HOST';
    slot.appendChild(crown);
  } else if (player.leader && !host) {
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
    const stage = S.raceButtons[id].querySelector('.stage');
    stage.classList.toggle('tm-red', myTeam !== 'blue');
    stage.classList.toggle('tm-blue', myTeam === 'blue');
  });
}

/** Free for all: everyone in the room plays, each on their own (sides are dealt at Start). */
function renderFfa(data) {
  const players = data.players || [];
  const max = data.ffa ? data.ffa.maxPlayers : 4;
  ffaSlots.innerHTML = '';
  players.forEach((p) => ffaSlots.appendChild(playerSlot(p, 'ffa', data.you, data.host)));
  for (let i = players.length; i < max; i++) ffaSlots.appendChild(el('div', 'slot empty')).textContent = '— open —';
  ffaCount.textContent = `${players.length}/${max}`;
  RACES.forEach(({ id }) => {
    const stage = S.raceButtons[id].querySelector('.stage');
    stage.classList.remove('tm-red', 'tm-blue');
    stage.classList.add('tm-ffa');
  });
}

export function applyTeamSelect(data) {
  const isHost = data.host === data.you;
  const ffa = data.mode === 'ffa';
  const playing = ffa ? (data.players || []).length : data.red.length + data.blue.length;
  const max = ffa && data.ffa ? data.ffa.maxPlayers : data.maxPlayers;
  subEl.textContent = `Lobby · Room ${data.roomCode || ''} · ${playing}/${max}`;
  hostBadge.classList.toggle('hidden', !isHost);
  vista.classList.toggle('wf-ffa', ffa);

  teamsPanel.classList.toggle('hidden', ffa);
  ffaRoster.classList.toggle('hidden', !ffa);
  randomizeBtn.classList.toggle('hidden', ffa);
  if (ffa) renderFfa(data);
  else {
    RACES.forEach(({ id }) => S.raceButtons[id].querySelector('.stage').classList.remove('tm-ffa'));
    renderTeams(data);
  }
  markRace(data.myRace);

  settingsEl.classList.toggle('wf-locked', !isHost);
  MATCH_LENGTHS.forEach(({ id }) => S.lengthButtons[id].classList.toggle('on', data.options.matchLength === id));
  MODES.forEach(({ id }) => S.modeButtons[id].classList.toggle('on', (data.mode || 'teams') === id));
  // Free for all needs Medium or Large: Small is greyed (5a-ffa-team-select.html).
  const ffaSizes = (data.ffa && data.ffa.mapSizes) || ['medium', 'large'];
  MAP_SIZES.forEach(({ id, label }) => {
    const btn = S.sizeButtons[id];
    btn.classList.toggle('on', data.options.mapSize === id);
    const off = ffa && !ffaSizes.includes(id);
    btn.disabled = off;
    btn.innerHTML = off ? `${label}<small>TEAMS ONLY</small>` : label;
  });

  startBtn.disabled = !data.canStart || !data.canCommand;
  if (data.canStart) {
    statusEl.className = 'grn wf-status';
    if (ffa) {
      statusEl.textContent = data.canCommand
        ? `ALL PLAYERS READY · FREE FOR ALL · ${playing} PLAYERS`
        : `READY · FREE FOR ALL · ${playing} PLAYERS · WAITING FOR HOST`;
    } else {
      statusEl.textContent = data.canCommand
        ? `ALL PLAYERS READY · ${data.red.length} v ${data.blue.length}`
        : `READY · ${data.red.length} v ${data.blue.length} · WAITING FOR HOST OR CAPTAIN`;
    }
  } else {
    statusEl.className = 'amb wf-status';
    statusEl.textContent = data.startBlocker || '';
  }
}
