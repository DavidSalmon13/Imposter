/**
 * Warfront client module (specs/warfront-specs.md). A dumb renderer of the server's
 * wfState payloads: the team-select screen (design/warfront/1-team-select.html) and the
 * battlefield (design/warfront/2-battlefield.html). It never simulates anything.
 */

import { sfx, haptics } from '../fx.js';
import { confirmDialog } from '../shared/confirmDialog.js';
import {
  UNIT_SPRITES,
  UNIT_ICONS,
  CASTLE_SPRITE,
  TREE_SPRITES,
  BUSH_SPRITE,
  BOULDER_SPRITE,
  SUPPLY_SPRITE,
  RACE_LINEUPS,
  RACE_PORTRAITS,
  crystalSprite,
  weaponSprite,
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


// ===========================================================================
// Battlefield (2-battlefield.html)
// ===========================================================================

const TILE = 70; // world px per tile, as in the mockup's 16x11 grid of 70px cells
const ELEVATION = { hills: 24, rock: 30 }; // raised ground (plateau heights from the mockup)
const BASE_PAD_Z = 20;
const RACE_NAMES = { forge: 'Forge', horde: 'Horde', arcane: 'Arcane' };
// Stack formations from the mockup: figure offsets inside a 76x74 squad billboard.
const FORMATIONS = {
  1: [[21, 24]],
  2: [[6, 24], [36, 24]],
  3: [[21, 10], [3, 28], [39, 28]],
  4: [[6, 10], [36, 10], [6, 28], [36, 28]],
};

const vp = $('wf-vp');
const cam = $('wf-cam');
const world = $('wf-world');
const hpEl = { red: $('wf-red-hp'), blue: $('wf-blue-hp') };
const hpSegEl = { red: $('wf-red-hpseg'), blue: $('wf-blue-hpseg') };
const clockEl = $('wf-clock');
const stripEl = $('wf-strip');
const edgeL = $('wf-edge-l');
const edgeR = $('wf-edge-r');
const minimap = $('wf-minimap');
const infoPortrait = $('wf-info-portrait');
const infoTitle = $('wf-info-title');
const infoSub = $('wf-info-sub');
const armyLabel = $('wf-army-label');
const supplyEl = $('wf-supply');
const mineralsEl = $('wf-minerals');
const menuBtn = $('wf-menu-btn');

let builtFor = null; // clock.startedAt of the battle the world was built for
let unitLayer = null;
let miniUnits = null;
let miniView = null;
let clockTimer = null;
let clockSkew = 0; // server clock minus ours

/** Deterministic 0..1 noise per tile, so every phone decorates the map the same way. */
function noise(tileId, k) {
  let h = Math.imul((tileId + 1) * 374761393 + k * 668265263, 1274126177) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function tileCentre(map, id) {
  const x = id % map.width;
  const y = Math.floor(id / map.width);
  return { x: x * TILE + TILE / 2, y: y * TILE + TILE / 2 };
}

function elevationAt(map, id) {
  if (map.bases.some((b) => b.tileId === id)) return BASE_PAD_Z;
  return ELEVATION[map.tiles[id]] || 0;
}

function ent(x, y, z, className = '') {
  const node = el('div', `ent${className ? ` ${className}` : ''}`);
  node.style.left = `${Math.round(x)}px`;
  node.style.top = `${Math.round(y)}px`;
  if (z) node.style.transform = `translateZ(${z}px)`;
  return node;
}

function billboard(svg, w, h, className = '') {
  const bb = el('div', `bb${className ? ` ${className}` : ''}`, svg);
  bb.style.width = `${w}px`;
  bb.style.height = `${h}px`;
  return bb;
}

/** Raised ground (.plat with cliff walls), merged into rectangles of one terrain. */
function plateaus(map, terrain, topClass, z) {
  const runs = [];
  for (let y = 0; y < map.height; y++) {
    let x = 0;
    while (x < map.width) {
      if (map.tiles[y * map.width + x] !== terrain) {
        x++;
        continue;
      }
      const x0 = x;
      while (x < map.width && map.tiles[y * map.width + x] === terrain) x++;
      const prev = runs.find((r) => r.x0 === x0 && r.len === x - x0 && r.y0 + r.rows === y);
      if (prev) prev.rows++;
      else runs.push({ x0, len: x - x0, y0: y, rows: 1 });
    }
  }
  return runs.map((r) => platEl(r.x0 * TILE, r.y0 * TILE, r.len * TILE, r.rows * TILE, z, topClass));
}

function platEl(x, y, w, h, z, topClass) {
  const plat = el(
    'div',
    'plat',
    `<div class="pw pw-f" style="height: ${z}px"></div><div class="pw pw-l" style="width: ${z}px"></div><div class="pw pw-r" style="width: ${z}px"></div><div class="${topClass}"></div>`,
  );
  Object.assign(plat.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`, transform: `translateZ(${z}px)` });
  return plat;
}

function buildWorld(data) {
  const { map } = data;
  const W = map.width * TILE;
  const H = map.height * TILE;
  // The tilted plane foreshortens to ~70% of its height (the mockup's 770px world fits a 540px camera).
  const camH = Math.round(H * 0.7);
  cam.style.width = `${W}px`;
  cam.style.height = `${camH}px`;
  Object.assign(world.style, { width: `${W}px`, height: `${H}px`, top: `${camH - H}px` });
  world.innerHTML = '';

  const isFeature = new Set([
    ...map.bases.map((b) => b.tileId),
    ...map.supplySources.map((f) => f.tileId),
    ...map.veins.map((f) => f.tileId),
    ...data.weapons.map((f) => f.tileId),
  ]);

  // Flat ground: water and forest floors, painted on the terrain texture.
  const terrain = el('div', 'terrain');
  const ground = [];
  map.tiles.forEach((t, id) => {
    const c = tileCentre(map, id);
    if (t === 'water') {
      const shore = el('span', 'shore');
      Object.assign(shore.style, { left: `${c.x - 54}px`, top: `${c.y - 50}px` });
      terrain.appendChild(shore);
      const water = el('span', 'water');
      Object.assign(water.style, { left: `${c.x - 44}px`, top: `${c.y - 41}px` });
      ground.push(water);
    } else if (t === 'forest') {
      const floor = el('span', 'floor');
      Object.assign(floor.style, { left: `${c.x - 65}px`, top: `${c.y - 65}px`, width: '130px', height: '130px' });
      terrain.appendChild(floor);
    }
  });
  ground.forEach((g) => terrain.appendChild(g));
  world.appendChild(terrain);

  // The tap layer (selection and orders arrive with movement, Step 5).
  const tiles = el('div', 'tiles');
  tiles.style.gridTemplateColumns = `repeat(${map.width}, ${TILE}px)`;
  tiles.style.gridTemplateRows = `repeat(${map.height}, ${TILE}px)`;
  for (let id = 0; id < map.width * map.height; id++) {
    const b = el('button', 'tile');
    b.type = 'button';
    b.dataset.tile = id;
    b.setAttribute('aria-label', `Area ${Math.floor(id / map.width) + 1}-${(id % map.width) + 1}, ${map.tiles[id]}`);
    tiles.appendChild(b);
  }
  world.appendChild(tiles);

  // Raised ground: grass hills, rocky outcrops, and a stone pad under each castle.
  plateaus(map, 'hills', 'ptop pt-grass', ELEVATION.hills).forEach((p) => world.appendChild(p));
  plateaus(map, 'rock', 'ptop pt-rock', ELEVATION.rock).forEach((p) => world.appendChild(p));
  map.bases.forEach((b) => {
    const c = tileCentre(map, b.tileId);
    world.appendChild(platEl(c.x - 49, c.y - 49, 98, 98, BASE_PAD_Z, 'ptop pt-stone'));
  });

  // Billboards, back to front.
  const boards = [];
  const add = (y, node) => boards.push({ y, node });
  map.tiles.forEach((t, id) => {
    const c = tileCentre(map, id);
    const z = elevationAt(map, id);
    if (t === 'forest') {
      const n = isFeature.has(id) ? 1 : 3;
      for (let i = 0; i < n; i++) {
        const ox = (noise(id, i) - 0.5) * 44;
        const oy = (noise(id, i + 7) - 0.5) * 40;
        const sc = 0.85 + noise(id, i + 13) * 0.3;
        const tree = ent(c.x + ox, c.y + oy, z);
        tree.appendChild(el('span', 'dec tshadow'));
        tree.appendChild(billboard(noise(id, i + 21) < 0.4 ? TREE_SPRITES.pine : TREE_SPRITES.leaf, Math.round(46 * sc), Math.round(64 * sc)));
        add(c.y + oy, tree);
      }
    } else if (t === 'rock') {
      const boulder = ent(c.x + (noise(id, 3) - 0.5) * 16, c.y + 6, z);
      const shadow = el('span', 'dec tshadow');
      Object.assign(shadow.style, { width: '60px', height: '28px' });
      boulder.appendChild(shadow);
      boulder.appendChild(billboard(BOULDER_SPRITE, 52, 40));
      add(c.y + 6, boulder);
    } else if ((t === 'plains' || t === 'hills') && !isFeature.has(id) && noise(id, 5) < 0.35) {
      const bush = ent(c.x + (noise(id, 6) - 0.5) * 50, c.y + (noise(id, 8) - 0.5) * 50, z);
      bush.appendChild(billboard(BUSH_SPRITE, 24, 16));
      add(c.y, bush);
    }
  });
  map.veins.forEach((v) => {
    const c = tileCentre(map, v.tileId);
    const node = ent(c.x, c.y + 8, elevationAt(map, v.tileId));
    node.appendChild(el('span', 'dec cglow'));
    if (v.contested) node.appendChild(el('span', 'dec cring'));
    node.appendChild(billboard(crystalSprite(v.richness), 58, 50));
    add(c.y + 8, node);
  });
  map.supplySources.forEach((src) => {
    const c = tileCentre(map, src.tileId);
    const node = ent(c.x, c.y + 10, elevationAt(map, src.tileId), src.team ? `tm-${src.team}` : '');
    const shadow = el('span', 'dec tshadow');
    Object.assign(shadow.style, { width: '70px', height: '30px' });
    node.appendChild(shadow);
    node.appendChild(billboard(SUPPLY_SPRITE, 60, 56));
    add(c.y + 10, node);
  });
  data.weapons.forEach((w) => {
    const c = tileCentre(map, w.tileId);
    const node = ent(c.x, c.y + 6, elevationAt(map, w.tileId));
    node.appendChild(billboard(weaponSprite(w.weaponId), 40, 36));
    add(c.y + 6, node);
  });
  map.bases.forEach((b) => {
    const c = tileCentre(map, b.tileId);
    const node = ent(c.x, c.y + 18, BASE_PAD_Z, `tm-${b.team}`);
    node.appendChild(el('span', `dec aura-${b.team}`));
    node.appendChild(el('span', 'dec bshadow'));
    node.appendChild(billboard(CASTLE_SPRITE, 130, 130));
    add(c.y + 18, node);
  });
  boards.sort((a, b) => a.y - b.y).forEach((b) => world.appendChild(b.node));

  unitLayer = el('div', 'wf-units');
  world.appendChild(unitLayer);

  buildMinimap(map);
}

/** One stack per occupied tile and team: up to four figures, a count chip and an HP bar. */
function renderUnits(data) {
  if (!unitLayer) return;
  const { map } = data;
  unitLayer.innerHTML = '';
  const stacks = new Map();
  data.units.forEach((u) => {
    const key = `${u.tileId}:${u.team}`;
    if (!stacks.has(key)) stacks.set(key, { tileId: u.tileId, team: u.team, units: [] });
    stacks.get(key).units.push(u);
  });
  const nodes = [];
  stacks.forEach((st) => {
    const counts = new Map();
    st.units.forEach((u) => counts.set(u.type, (counts.get(u.type) || 0) + 1));
    const types = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
    const figTypes = [];
    for (let i = 0; figTypes.length < Math.min(st.units.length, 4); i++) figTypes.push(types[i % types.length]);
    const hp = st.units.reduce((a, u) => a + u.hp, 0);
    const maxHp = st.units.reduce((a, u) => a + (UNIT_MAX_HP[u.type] || u.hp), 0);
    const pct = Math.max(0, Math.min(100, Math.round((hp / maxHp) * 100)));

    const c = tileCentre(map, st.tileId);
    // Two teams on one tile stand apart instead of on top of each other.
    const shared = stacks.has(`${st.tileId}:${st.team === 'red' ? 'blue' : 'red'}`);
    const x = c.x + (shared ? (st.team === 'red' ? -16 : 16) : 0);
    // On a base tile, stand in front of the castle's gate rather than behind its walls.
    const onBase = map.bases.some((b) => b.tileId === st.tileId);
    const y = c.y + (onBase ? 44 : 14);
    const node = ent(x, y, elevationAt(map, st.tileId));
    node.appendChild(el('span', 'dec sqsh'));
    node.appendChild(el('span', `dec rg-${st.team}`));
    const bb = el('div', `bb sqbb tm-${st.team}`);
    bb.appendChild(el('span', 'hpb', `<span class="${pct >= 75 ? 'hp-g' : 'hp-y'}" style="width: ${pct}%"></span>`));
    bb.appendChild(el('span', `chip c-${st.team}`)).textContent = `${UNIT_ICONS[types[0]] || '?'}×${st.units.length}`;
    FORMATIONS[figTypes.length].forEach(([fx, fy], i) => {
      const fig = el('span', `fig d${i}${st.team !== 'red' ? ' flip' : ''}`);
      fig.style.left = `${fx}px`;
      fig.style.top = `${fy}px`;
      const spw = el('span', 'spw', (UNIT_SPRITES[figTypes[i]] || '').replace('<svg ', '<svg class="sp" '));
      fig.appendChild(spw);
      bb.appendChild(fig);
    });
    node.appendChild(bb);
    nodes.push({ y, node });
  });
  nodes.sort((a, b) => a.y - b.y).forEach((n) => unitLayer.appendChild(n.node));
  renderMiniUnits(data);
}

// Max HP per unit type, for the stack HP bar (mirrors the server's UNIT_TYPES).
const UNIT_MAX_HP = {
  laborer: 5, peon: 5, acolyte: 5,
  militiaman: 11, crossbow: 7, outrider: 8, bastion: 20, ballista: 8,
  warrior: 11, skirmisher: 7, raider: 9, berserker: 6, warchief: 16,
  apprentice: 6, mysticArcher: 6, battlemage: 8, summoner: 7, archmage: 10, golem: 18,
};

// ---------- Minimap (1:10, like the mockup) ----------

const MINI_COLOURS = { forest: '#1f3a18', hills: '#7a8a4a', water: '#16557a', rock: '#8b8c74' };

function miniRect(x, y, w, h, colour, radius = '0') {
  const r = el('span');
  Object.assign(r.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`, background: colour, borderRadius: radius });
  return r;
}

function buildMinimap(map) {
  const s = TILE / 10;
  minimap.innerHTML = '';
  minimap.style.width = `${map.width * s}px`;
  minimap.style.height = `${map.height * s}px`;
  map.tiles.forEach((t, id) => {
    if (!MINI_COLOURS[t]) return;
    minimap.appendChild(miniRect((id % map.width) * s, Math.floor(id / map.width) * s, s, s, MINI_COLOURS[t], t === 'water' ? '50%' : t === 'forest' ? '40%' : '1px'));
  });
  map.veins.forEach((v) => {
    const c = tileCentre(map, v.tileId);
    minimap.appendChild(miniRect(c.x / 10 - 1.5, c.y / 10 - 1.5, 3, 3, '#5ad8ff'));
  });
  map.bases.forEach((b) => {
    const c = tileCentre(map, b.tileId);
    minimap.appendChild(miniRect(c.x / 10 - 3.5, c.y / 10 - 3.5, 7, 7, b.team === 'red' ? '#ff5a5f' : '#4f93ff', '1px'));
  });
  miniUnits = el('span');
  Object.assign(miniUnits.style, { position: 'absolute', inset: '0' });
  minimap.appendChild(miniUnits);
  miniView = el('span');
  Object.assign(miniView.style, { border: '1px solid #fff', boxShadow: '0 0 4px #fff', boxSizing: 'border-box' });
  minimap.appendChild(miniView);
}

function renderMiniUnits(data) {
  if (!miniUnits) return;
  miniUnits.innerHTML = '';
  const seen = new Set();
  data.units.forEach((u) => {
    const key = `${u.tileId}:${u.team}`;
    if (seen.has(key)) return;
    seen.add(key);
    const c = tileCentre(data.map, u.tileId);
    miniUnits.appendChild(miniRect(c.x / 10 - 2, c.y / 10 + 1, 4, 4, u.team === 'red' ? '#ff5a5f' : '#4f93ff', '50%'));
  });
}

/** Viewport box on the minimap + the ◀ ▶ edge hints. */
function syncView() {
  if (!miniView || !cam.offsetWidth) return;
  const k = 0.1;
  const camH = cam.offsetHeight;
  const worldH = parseFloat(world.style.height) || camH;
  const yScale = worldH / camH; // screen px -> world px (approximate under the tilt)
  Object.assign(miniView.style, {
    left: `${vp.scrollLeft * k}px`,
    top: `${vp.scrollTop * yScale * k}px`,
    width: `${Math.min(vp.clientWidth, cam.offsetWidth) * k}px`,
    height: `${Math.min(vp.clientHeight * yScale, worldH) * k}px`,
  });
  edgeL.classList.toggle('hidden', vp.scrollLeft <= 4);
  edgeR.classList.toggle('hidden', vp.scrollLeft + vp.clientWidth >= vp.scrollWidth - 4);
}

/** Centre the camera on a tile (scrolls the viewport). */
function lookAt(map, tileId) {
  const c = tileCentre(map, tileId);
  const camH = cam.offsetHeight;
  const worldH = map.height * TILE;
  vp.scrollLeft = c.x - vp.clientWidth / 2;
  vp.scrollTop = (c.y / worldH) * camH - vp.clientHeight / 2;
  syncView();
}

// ---------- HUD ----------

function renderHp(team, base) {
  const pct = base.maxHp ? base.hp / base.maxHp : 0;
  const lit = Math.max(0, Math.min(12, Math.ceil(pct * 12)));
  const colour = pct >= 0.75 ? '#4dff7a' : pct >= 0.35 ? '#ffcc33' : '#ff5a5f';
  hpEl[team].textContent = Math.max(0, Math.round(base.hp));
  hpEl[team].className = pct >= 0.75 ? 'grn' : 'amb';
  hpSegEl[team].innerHTML = '';
  for (let i = 0; i < 12; i++) {
    const seg = el('span');
    const c = i < lit ? colour : '#1a2028';
    seg.style.background = c;
    seg.style.boxShadow = `0 0 4px ${c}`;
    hpSegEl[team].appendChild(seg);
  }
}

function tickClock() {
  if (!state || state.phase !== 'playing' || !state.clock) return;
  const left = Math.max(0, state.clock.matchEndsAt - (Date.now() + clockSkew));
  const secs = Math.ceil(left / 1000);
  clockEl.textContent = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
  // The mockup's blinking timer, saved for the last minute.
  clockEl.style.animation = secs <= 60 ? 'wfBlink 1s steps(1) infinite' : 'none';
}

function renderStrip(data) {
  stripEl.innerHTML = '';
  const mine = data.roster.filter((p) => p.team === data.myTeam);
  const enemies = data.roster.filter((p) => p.team !== data.myTeam);
  const line = (led, nameText, nameColour, sub) => {
    const r = el('span', 'rdy');
    const l = el('span', 'led');
    l.style.background = led;
    l.style.boxShadow = `0 0 5px ${led}`;
    r.appendChild(l);
    const n = el('span');
    n.style.color = nameColour;
    n.textContent = nameText;
    r.appendChild(n);
    const s2 = el('span');
    s2.style.color = '#8fa3b5';
    s2.textContent = sub;
    r.appendChild(s2);
    stripEl.appendChild(r);
  };
  const teamColour = (t) => (t === 'red' ? '#ff7a7e' : '#7fb0ff');
  mine.forEach((p) => {
    line(p.connected ? '#4dff7a' : '#4c5b69', p.name === data.you ? 'YOU' : p.name.toUpperCase(), teamColour(p.team),
      p.connected ? RACE_NAMES[p.race].toLowerCase() : 'offline');
  });
  if (enemies.length) {
    const t = enemies[0].team;
    line('#4c5b69', `${t.toUpperCase()} ×${enemies.length}`, teamColour(t), 'hidden');
  }
}

function renderBattle(data) {
  clockSkew = data.serverNow ? data.serverNow - Date.now() : 0;
  const fresh = builtFor !== data.clock.startedAt;
  if (fresh) {
    buildWorld(data);
    builtFor = data.clock.startedAt;
  }
  renderUnits(data);
  renderHp('red', data.bases.red);
  renderHp('blue', data.bases.blue);
  renderStrip(data);
  tickClock();
  clearInterval(clockTimer);
  clockTimer = setInterval(tickClock, 1000);

  const team = data.myTeam || 'red';
  infoPortrait.className = `scan tm-${team}`;
  infoPortrait.innerHTML = CASTLE_SPRITE.replace('<svg ', '<svg style="width: 44px; height: 44px; overflow: visible" ');
  infoTitle.textContent = data.map.theme;
  infoSub.textContent = data.map.lore || '';
  if (data.me) {
    armyLabel.textContent = `Army · ${RACE_NAMES[data.myRace]}`;
    supplyEl.textContent = Math.floor(data.me.supply);
    mineralsEl.textContent = Math.floor(data.me.minerals);
  } else {
    armyLabel.textContent = 'Watching · no army this match';
    supplyEl.textContent = '–';
    mineralsEl.textContent = '–';
  }

  ctx.showScreen('warfront');
  if (fresh) {
    // Start the camera on your own castle (needs the screen laid out first).
    requestAnimationFrame(() => {
      const home = data.map.bases.find((b) => b.team === team);
      lookAt(data.map, home ? home.tileId : 0);
    });
  }
}

/** Mouse drag-to-pan (touch already pans the scrolling viewport natively). */
function enableMousePan() {
  let drag = null;
  vp.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, left: vp.scrollLeft, top: vp.scrollTop, moved: false };
  });
  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    vp.scrollLeft = drag.left - dx;
    vp.scrollTop = drag.top - dy;
  });
  window.addEventListener('pointerup', () => {
    drag = null;
  });
}

function applyState(data) {
  if (!data || data.game !== 'warfront') return;
  state = data;
  if (data.phase !== 'playing') {
    clearInterval(clockTimer);
    clockTimer = null;
  }
  if (data.phase === 'teamSelect') {
    applyTeamSelect(data);
    ctx.showScreen('warfrontTeam');
  } else if (data.phase === 'generating') {
    ctx.showGenerating('warfront');
  } else if (data.phase === 'playing') {
    renderBattle(data);
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

    enableMousePan();
    vp.addEventListener('scroll', syncView, { passive: true });
    minimap.addEventListener('click', (e) => {
      if (!state || !state.map) return;
      const r = minimap.getBoundingClientRect();
      const tx = Math.floor(((e.clientX - r.left) / r.width) * state.map.width);
      const ty = Math.floor(((e.clientY - r.top) / r.height) * state.map.height);
      lookAt(state.map, Math.max(0, Math.min(state.map.height - 1, ty)) * state.map.width + Math.max(0, Math.min(state.map.width - 1, tx)));
    });
    menuBtn.addEventListener('click', async () => {
      const ok = await confirmDialog('Everyone goes back to the lobby and this battle ends.', {
        title: 'Leave the battle?',
        confirmLabel: 'Leave',
        danger: true,
      });
      if (ok) socket.emit('backToLobby', () => {});
    });

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
    builtFor = null;
    clearInterval(clockTimer);
    clockTimer = null;
    clearTimeout(errorTimer);
    errorEl.textContent = '';
  },
};
