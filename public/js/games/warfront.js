/**
 * Warfront client module (specs/warfront-specs.md). A dumb renderer of the server's
 * wfState payloads: the team-select screen (design/warfront/1-team-select.html) and the
 * battlefield (design/warfront/2-battlefield.html) with the live combat effects of
 * design/warfront/3-resolution.html, and the game-over screen
 * (design/warfront/4-game-over.html). It never simulates anything.
 */

import { sfx, haptics, haptic } from '../fx.js';
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
  LOAD_SPRITE,
  DROP_SPRITE,
  RUINED_CASTLE_SPRITE,
  BANNER_SPRITE,
  LIGHTHOUSE_SPRITE,
} from './warfrontSprites.js';
import { renderScoreboard } from '../shared/scoreboard.js';

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
const infoHp = $('wf-info-hp');
const infoOrder = $('wf-info-order');
const armyLabel = $('wf-army-label');
const supplyEl = $('wf-supply');
const supplyRateEl = $('wf-supply-rate');
const mineralsEl = $('wf-minerals');
const cardsEl = $('wf-cards');
const cmdBtn = { move: $('wf-cmd-move'), haul: $('wf-cmd-haul'), hold: $('wf-cmd-hold') };
const feedEl = $('wf-feed');
const menuBtn = $('wf-menu-btn');
const alertEl = $('wf-alert');
const alertText = $('wf-alert-text');

let builtFor = null; // clock.startedAt of the battle the world was built for
let unitLayer = null;
let orderLayer = null;
let fogRects = []; // per tile: the fog <rect> on the haze plane
let decor = []; // [{ tileId, node }]: billboards that dim under fog
let pickupNodes = new Map(); // tileId -> weapon-token billboard
let miniUnits = null;
let miniFog = null;
let miniView = null;
let clockTimer = null;
let clockSkew = 0; // server clock minus ours
let live = null; // the latest fogged view (wfState's live part, then every wfLive)
let lastVisible = null;
const selected = new Set(); // ids of my own selected units
const stackNodes = new Map(); // stack key -> { node, sig, group }
let clickNodes = new Map(); // destination tileId -> .click marker
let ordersSig = '';
let rafId = null;
let stripSeen = null; // whether the strip last showed enemies in sight
let fxLayer = null; // one-shot combat effects (3-resolution.html), removed when they end
let castleBoards = {}; // team -> the castle's billboard (for the burning state)
let lastHp = { red: null, blue: null };
let alertTile = null;
let alertTimer = null;
const stepSeen = new Map(); // stack key -> stepStartedAt we already puffed dust for
let mode = 'move'; // what a tap on the map does with the selection: 'move' | 'haul'
let cardsFor = ''; // race|team the command card was built for
const cardNodes = new Map(); // unitType -> { btn, q, bar, sig }
let dropNodes = new Map(); // tileId -> dropped-load billboard
const gainNodes = new Map(); // tileId -> { node, total }: the "+N💎" floating over a deposit
let lighthouseNodes = new Map(); // tileId -> { node, mini, team }: lighthouse billboard + minimap marker

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
  return runs.map((r) => ({
    node: platEl(r.x0 * TILE, r.y0 * TILE, r.len * TILE, r.rows * TILE, z, topClass),
    x0: r.x0, y0: r.y0, cols: r.len, rows: r.rows,
  }));
}

/**
 * A fog sheet: one blurred rect per tile of a cols×rows block starting at (x0, y0),
 * registered in fogRects so renderFog can lift it where the team can see. `onlyTile`
 * makes a single-rect sheet (a castle pad) for that tile.
 */
function fogSheet(map, x0, y0, cols, rows, onlyTile) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'wf-fog');
  svg.setAttribute('viewBox', `0 0 ${cols} ${rows}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  // No 3D transform of its own: it lies flat on its ground and paints over it by DOM
  // order (with a translateZ Chrome dropped the sheet's last row from the raster).
  const g = document.createElementNS(NS, 'g');
  g.setAttribute('filter', 'url(#wf-fog-blur)');
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const id = onlyTile != null ? onlyTile : (y0 + y) * map.width + (x0 + x);
      const r = document.createElementNS(NS, 'rect');
      r.setAttribute('x', x - 0.01);
      r.setAttribute('y', y - 0.01);
      r.setAttribute('width', 1.02);
      r.setAttribute('height', 1.02);
      g.appendChild(r);
      fogRects[id].push(r);
    }
  }
  svg.appendChild(g);
  return svg;
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

/**
 * Builds the 2.5D world for `data.map` into a camera (the battlefield's by default;
 * the game-over scene passes its own and no minimap). Resets every per-world registry.
 */
function buildWorld(data, target = { cam, world, minimap: true }) {
  const { map } = data;
  const camEl = target.cam;
  const worldEl = target.world;
  const W = map.width * TILE;
  const H = map.height * TILE;
  // The tilted plane foreshortens to ~70% of its height (the mockup's 770px world fits a 540px camera).
  const camH = Math.round(H * 0.7);
  camEl.style.width = `${W}px`;
  camEl.style.height = `${camH}px`;
  Object.assign(worldEl.style, { width: `${W}px`, height: `${H}px`, top: `${camH - H}px` });
  worldEl.innerHTML = '';

  const isFeature = new Set([
    ...map.bases.map((b) => b.tileId),
    ...map.supplySources.map((f) => f.tileId),
    ...map.veins.map((f) => f.tileId),
    ...data.pickups.weapons.map((f) => f.tileId),
    ...(map.lighthouses || []).map((f) => f.tileId),
  ]);
  decor = [];
  castleBoards = {};
  lastHp = { red: null, blue: null };
  stepSeen.clear();
  pickupNodes = new Map();
  dropNodes = new Map();
  lighthouseNodes = new Map();
  stackNodes.clear();
  clickNodes = new Map();
  ordersSig = '';
  lastVisible = null;

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
  worldEl.appendChild(terrain);

  // The tap layer: select your stack, then tap where it should go.
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
  worldEl.appendChild(tiles);

  // Raised ground: grass hills, rocky outcrops, and a stone pad under each castle.
  const plats = [...plateaus(map, 'hills', 'ptop pt-grass', ELEVATION.hills), ...plateaus(map, 'rock', 'ptop pt-rock', ELEVATION.rock)];
  plats.forEach((p) => worldEl.appendChild(p.node));
  const padNodes = map.bases.map((b) => {
    const c = tileCentre(map, b.tileId);
    const node = platEl(c.x - 49, c.y - 49, 98, 98, BASE_PAD_Z, 'ptop pt-stone');
    worldEl.appendChild(node);
    return { node, tileId: b.tileId };
  });

  // Billboards, back to front.
  const boards = [];
  const add = (y, node, tileId) => {
    boards.push({ y, node });
    const bb = node.querySelector('.bb');
    if (bb) decor.push({ tileId, bb });
  };
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
        add(c.y + oy, tree, id);
      }
    } else if (t === 'rock') {
      const boulder = ent(c.x + (noise(id, 3) - 0.5) * 16, c.y + 6, z);
      const shadow = el('span', 'dec tshadow');
      Object.assign(shadow.style, { width: '60px', height: '28px' });
      boulder.appendChild(shadow);
      boulder.appendChild(billboard(BOULDER_SPRITE, 52, 40));
      add(c.y + 6, boulder, id);
    } else if ((t === 'plains' || t === 'hills') && !isFeature.has(id) && noise(id, 5) < 0.35) {
      const bush = ent(c.x + (noise(id, 6) - 0.5) * 50, c.y + (noise(id, 8) - 0.5) * 50, z);
      bush.appendChild(billboard(BUSH_SPRITE, 24, 16));
      add(c.y, bush, id);
    }
  });
  map.veins.forEach((v) => {
    const c = tileCentre(map, v.tileId);
    const node = ent(c.x, c.y + 8, elevationAt(map, v.tileId));
    node.appendChild(el('span', 'dec cglow'));
    if (v.contested) node.appendChild(el('span', 'dec cring'));
    node.appendChild(billboard(crystalSprite(v.richness), 58, 50));
    add(c.y + 8, node, v.tileId);
  });
  map.supplySources.forEach((src) => {
    const c = tileCentre(map, src.tileId);
    const node = ent(c.x, c.y + 10, elevationAt(map, src.tileId), src.team ? `tm-${src.team}` : '');
    const shadow = el('span', 'dec tshadow');
    Object.assign(shadow.style, { width: '70px', height: '30px' });
    node.appendChild(shadow);
    node.appendChild(billboard(SUPPLY_SPRITE, 60, 56));
    add(c.y + 10, node, src.tileId);
  });
  data.pickups.weapons.forEach((w) => {
    const c = tileCentre(map, w.tileId);
    const node = ent(c.x, c.y + 6, elevationAt(map, w.tileId));
    node.appendChild(billboard(weaponSprite(w.weaponId), 40, 36));
    add(c.y + 6, node, w.tileId);
    pickupNodes.set(w.tileId, node);
  });
  // Lighthouses: a stone tower whose lamp (and the light it throws on the ground)
  // burns in the holder's colour; unlit grey while nobody holds it.
  (map.lighthouses || []).forEach((l) => {
    const c = tileCentre(map, l.tileId);
    const node = ent(c.x, c.y + 10, elevationAt(map, l.tileId), 'wf-lh tm-none');
    node.appendChild(el('span', 'dec lglow'));
    const shadow = el('span', 'dec tshadow');
    Object.assign(shadow.style, { width: '44px', height: '22px' });
    node.appendChild(shadow);
    node.appendChild(billboard(LIGHTHOUSE_SPRITE, 40, 86));
    add(c.y + 10, node, l.tileId);
    lighthouseNodes.set(l.tileId, { node, mini: null, team: undefined });
  });
  map.bases.forEach((b) => {
    const c = tileCentre(map, b.tileId);
    const node = ent(c.x, c.y + 18, BASE_PAD_Z, `tm-${b.team}`);
    node.appendChild(el('span', `dec aura-${b.team}`));
    node.appendChild(el('span', 'dec bshadow'));
    const castle = billboard(CASTLE_SPRITE, 130, 130);
    node.appendChild(castle);
    castleBoards[b.team] = castle;
    add(c.y + 18, node, b.tileId);
  });
  boards.sort((a, b) => a.y - b.y).forEach((b) => worldEl.appendChild(b.node));

  orderLayer = el('div', 'wf-orders');
  worldEl.appendChild(orderLayer);
  unitLayer = el('div', 'wf-units');
  worldEl.appendChild(unitLayer);
  fxLayer = el('div', 'wf-fx');
  worldEl.appendChild(fxLayer);

  // Fog of war: a haze sheet on the ground (like the mockup's .fogp), plus one on top of
  // each raised plateau and castle pad so high ground is fogged too.
  fogRects = map.tiles.map(() => []);
  const groundFog = fogSheet(map, 0, 0, map.width, map.height);
  groundFog.insertAdjacentHTML('afterbegin', '<defs><filter id="wf-fog-blur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="0.3"></feGaussianBlur></filter></defs>');
  worldEl.appendChild(groundFog);
  plats.forEach(({ node, x0, y0, cols, rows }) => node.appendChild(fogSheet(map, x0, y0, cols, rows)));
  padNodes.forEach(({ node, tileId: id }) => node.appendChild(fogSheet(map, 0, 0, 1, 1, id)));

  if (target.minimap) buildMinimap(map);
}

// ---------- Units: one stack per tile and team, tweened between ticks ----------

const serverNow = () => Date.now() + clockSkew;

/** The tile a unit is stepping onto (own units: path[0]; enemies: nextTileId), or null. */
function nextTileOf(u) {
  if (!u.stepEndsAt) return null;
  if (u.path && u.path.length) return u.path[0];
  return u.nextTileId != null ? u.nextTileId : null;
}

/**
 * Groups units into stacks: everyone of one team standing on one tile, or walking the
 * same step together. Keyed by the lowest unit id, so a squad keeps its node while it walks.
 */
function groupUnits(units) {
  const byKey = new Map();
  units.forEach((u) => {
    const next = nextTileOf(u);
    const k = next == null ? `${u.team}|${u.tileId}` : `${u.team}|${u.tileId}>${next}@${u.stepEndsAt}`;
    if (!byKey.has(k)) byKey.set(k, { team: u.team, tileId: u.tileId, next, stepStartedAt: u.stepStartedAt, stepEndsAt: u.stepEndsAt, units: [] });
    byKey.get(k).units.push(u);
  });
  const groups = new Map();
  byKey.forEach((g) => {
    g.key = `${g.team}:${Math.min(...g.units.map((u) => u.id))}`;
    groups.set(g.key, g);
  });
  return groups;
}

function stackSig(g, you) {
  const counts = new Map();
  g.units.forEach((u) => counts.set(u.type, (counts.get(u.type) || 0) + 1));
  const hp = g.units.reduce((a, u) => a + u.hp, 0);
  const sel = g.units.some((u) => u.owner === you && selected.has(u.id));
  const loaded = g.units.some((u) => u.carrying > 0);
  return `${g.team}|${[...counts.entries()].sort().join(',')}|${hp}|${sel ? 1 : 0}|${loaded ? 1 : 0}`;
}

/** Builds a stack's billboard (the mockup's squad: ring, figures, count chip, HP bar). */
function fillStack(node, g, you) {
  node.innerHTML = '';
  const counts = new Map();
  g.units.forEach((u) => counts.set(u.type, (counts.get(u.type) || 0) + 1));
  const types = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  const figTypes = [];
  for (let i = 0; figTypes.length < Math.min(g.units.length, 4); i++) figTypes.push(types[i % types.length]);
  const hp = g.units.reduce((a, u) => a + u.hp, 0);
  const maxHp = g.units.reduce((a, u) => a + (UNIT_MAX_HP[u.type] || u.hp), 0);
  const pct = Math.max(0, Math.min(100, Math.round((hp / maxHp) * 100)));
  const isSel = g.units.some((u) => u.owner === you && selected.has(u.id));
  const form = FORMATIONS[figTypes.length];

  node.appendChild(el('span', 'dec sqsh'));
  // Selected: the team ring gives way to a green ring under each figure (mockup).
  node.appendChild(el('span', `dec ${isSel ? 'rg-unk' : `rg-${g.team}`}`));
  if (isSel) {
    form.forEach(([fx, fy]) => {
      const r = el('span', 'selr');
      r.style.left = `${fx - 21}px`;
      r.style.top = `${Math.round((fy - 22) * 0.9)}px`;
      node.appendChild(r);
    });
  }
  const bb = el('div', `bb sqbb tm-${g.team}`);
  bb.appendChild(el('span', 'hpb', `<span class="${pct >= 75 ? 'hp-g' : pct >= 35 ? 'hp-y' : 'hp-r'}" style="width: ${pct}%"></span>`));
  bb.appendChild(el('span', `chip c-${g.team}`)).textContent = `${UNIT_ICONS[types[0]] || '?'}×${g.units.length}`;
  form.forEach(([fx, fy], i) => {
    const fig = el('span', `fig d${i}${g.team !== 'red' ? ' flip' : ''}`);
    fig.style.left = `${fx}px`;
    fig.style.top = `${fy}px`;
    fig.appendChild(el('span', 'spw', (UNIT_SPRITES[figTypes[i]] || '').replace('<svg ', '<svg class="sp" ')));
    bb.appendChild(fig);
  });
  // A hauler with a load (yours, or an enemy's in sight) carries a crystal over the squad.
  if (g.units.some((u) => u.carrying > 0)) bb.appendChild(el('span', 'wf-load', LOAD_SPRITE));
  node.appendChild(bb);
}

/** Where a stack stands on a tile: in front of a castle's gate or a lighthouse, or beside an enemy stack. */
function standPoint(map, tileId, team, shared) {
  const c = tileCentre(map, tileId);
  const onBase = map.bases.some((b) => b.tileId === tileId);
  // On a lighthouse the stack stands at its foot, in front, so the lamp stays in view.
  const onLight = !onBase && (map.lighthouses || []).some((l) => l.tileId === tileId);
  return {
    x: c.x + (shared ? (team === 'red' ? -16 : 16) : 0),
    y: c.y + (onBase ? 44 : onLight ? 30 : 14),
    z: elevationAt(map, tileId),
  };
}

/** Positions one stack for the current moment (slides along its step). */
function placeStack(map, entry, now) {
  const g = entry.group;
  let p = standPoint(map, g.tileId, g.team, entry.shared);
  if (g.next != null && g.stepEndsAt > g.stepStartedAt) {
    const q = standPoint(map, g.next, g.team, false);
    const t = Math.max(0, Math.min(1, (now - g.stepStartedAt) / (g.stepEndsAt - g.stepStartedAt)));
    p = { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, z: p.z + (q.z - p.z) * t };
  }
  const { node } = entry;
  node.style.left = `${Math.round(p.x)}px`;
  node.style.top = `${Math.round(p.y)}px`;
  node.style.transform = p.z ? `translateZ(${Math.round(p.z)}px)` : '';
}

function renderUnits() {
  if (!unitLayer || !live || !state) return;
  const { map } = state;
  const you = state.you;
  const groups = groupUnits(live.units);
  const still = new Set();
  groups.forEach((g) => {
    if (g.next == null) still.add(`${g.team}|${g.tileId}`);
  });
  stackNodes.forEach((entry, key) => {
    if (!groups.has(key)) {
      entry.node.remove();
      stackNodes.delete(key);
    }
  });
  const fresh = [];
  groups.forEach((g, key) => {
    let entry = stackNodes.get(key);
    if (!entry) {
      entry = { node: ent(0, 0, 0), sig: '' };
      stackNodes.set(key, entry);
      fresh.push({ y: tileCentre(map, g.tileId).y, node: entry.node });
    }
    entry.group = g;
    entry.shared = g.next == null && still.has(`${g.team === 'red' ? 'blue' : 'red'}|${g.tileId}`);
    const sig = `${stackSig(g, you)}|${entry.shared ? 1 : 0}`;
    if (sig !== entry.sig) {
      fillStack(entry.node, g, you);
      entry.sig = sig;
    }
    placeStack(map, entry, serverNow());
  });
  fresh.sort((a, b) => a.y - b.y).forEach((f) => unitLayer.appendChild(f.node));
  renderMiniUnits();
  startTween();
}

/** Slides walking stacks every frame between the 5 Hz snapshots. */
function startTween() {
  if (rafId) return;
  const frame = () => {
    rafId = null;
    if (!state || state.phase !== 'playing' || !live) return;
    let moving = false;
    const now = serverNow();
    stackNodes.forEach((entry) => {
      if (entry.group.next != null) {
        placeStack(state.map, entry, now);
        moving = true;
      }
    });
    if (moving) rafId = requestAnimationFrame(frame);
  };
  rafId = requestAnimationFrame(frame);
}

// ---------- Orders: dashed march lines + the destination marker ----------

/** A path's corners: the start, every turn, the end. */
function corners(map, from, path) {
  const pts = [from, ...path].map((id) => ({ x: id % map.width, y: Math.floor(id / map.width), id }));
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const c = pts[i + 1];
    if (b.x - a.x !== c.x - b.x || b.y - a.y !== c.y - b.y) out.push(b);
  }
  if (pts.length > 1) out.push(pts[pts.length - 1]);
  return out;
}

function renderOrders() {
  if (!orderLayer || !live || !state) return;
  const { map } = state;
  const lines = [];
  const dests = new Set();
  const seen = new Set();
  live.units.forEach((u) => {
    if (u.team !== state.myTeam || !u.path || !u.path.length) return;
    const mine = u.owner === state.you;
    const key = `${mine ? 1 : 0}|${u.tileId}|${u.path.join(',')}`;
    if (seen.has(key)) return;
    seen.add(key);
    lines.push({ mine, pts: corners(map, u.tileId, u.path) });
    if (mine) dests.add(u.path[u.path.length - 1]);
  });
  // Enemies in sight: only the step they're taking (the mockup's short .foe arrow).
  live.units.forEach((u) => {
    if (u.team === state.myTeam || u.nextTileId == null) return;
    const key = `foe|${u.tileId}|${u.nextTileId}`;
    if (seen.has(key)) return;
    seen.add(key);
    lines.push({ foe: true, pts: [{ id: u.tileId }, { id: u.nextTileId }] });
  });
  const sig = JSON.stringify(lines.map((l) => [l.mine, l.foe, l.pts.map((p) => p.id)]));
  if (sig !== ordersSig) {
    ordersSig = sig;
    orderLayer.querySelectorAll('.gline').forEach((n) => n.remove());
    lines.forEach(({ mine, foe, pts }) => {
      for (let i = 0; i < pts.length - 1; i++) {
        const a = tileCentre(map, pts[i].id);
        const b = tileCentre(map, pts[i + 1].id);
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
        const z = Math.max(elevationAt(map, pts[i].id), elevationAt(map, pts[i + 1].id)) + 2;
        const last = i === pts.length - 2;
        const kind = foe ? ' foe' : mine ? '' : ` ally wf-ally-${state.myTeam}`;
        const line = el('div', `gline${kind}${last ? '' : ' wf-noarrow'}`);
        Object.assign(line.style, {
          left: `${a.x}px`,
          top: `${a.y}px`,
          width: `${Math.max(0, len - (last ? (foe ? 30 : 18) : 0))}px`,
          transform: `translateZ(${z}px) rotate(${ang}deg)`,
        });
        orderLayer.appendChild(line);
      }
    });
  }
  // Destination markers are keyed so their pulse doesn't restart every tick.
  clickNodes.forEach((node, id) => {
    if (!dests.has(id)) {
      node.remove();
      clickNodes.delete(id);
    }
  });
  dests.forEach((id) => {
    if (clickNodes.has(id)) return;
    const c = tileCentre(map, id);
    const node = el('div', 'click');
    Object.assign(node.style, { left: `${c.x}px`, top: `${c.y}px`, transform: `translateZ(${elevationAt(map, id) + 2}px)` });
    orderLayer.appendChild(node);
    clickNodes.set(id, node);
  });
}

// ---------- Fog of war ----------

function renderFog() {
  if (!live || live.visible === lastVisible || !fogRects.length) return;
  const vis = live.visible;
  fogRects.forEach((rects, id) => rects.forEach((r) => r.setAttribute('class', vis[id] === '1' ? '' : 'on')));
  decor.forEach(({ tileId, bb }) => bb.classList.toggle('dim', vis[tileId] !== '1'));
  renderMiniFog(vis);
  lastVisible = vis;
}

/** Weapon tokens disappear once someone walks over them; dropped loads come and go. */
function renderPickups() {
  if (!live) return;
  const drops = live.pickups.mineralDrops || {};
  dropNodes.forEach((node, tileId) => {
    if (!drops[tileId]) {
      node.remove();
      dropNodes.delete(tileId);
    }
  });
  Object.keys(drops).forEach((key) => {
    const tileId = Number(key);
    if (dropNodes.has(tileId) || !unitLayer) return;
    const c = tileCentre(state.map, tileId);
    const node = ent(c.x + 14, c.y + 22, elevationAt(state.map, tileId));
    node.appendChild(el('span', 'dec wf-dropglow'));
    node.appendChild(billboard(DROP_SPRITE, 34, 22));
    unitLayer.parentNode.insertBefore(node, unitLayer);
    dropNodes.set(tileId, node);
  });
  const left = new Set(live.pickups.weapons.map((w) => w.tileId));
  pickupNodes.forEach((node, tileId) => {
    if (!left.has(tileId)) {
      node.remove();
      pickupNodes.delete(tileId);
      decor = decor.filter((d) => d.bb.parentNode !== node);
    }
  });
}

/** Lamp colours: every player sees who holds each lighthouse (static map feature). */
function renderLighthouses() {
  if (!live || !live.lighthouses) return;
  live.lighthouses.forEach((l) => {
    const entry = lighthouseNodes.get(l.tileId);
    if (!entry || entry.team === l.team) return;
    entry.team = l.team;
    const cls = l.team ? `tm-${l.team}` : 'tm-none';
    entry.node.classList.remove('tm-red', 'tm-blue', 'tm-none');
    entry.node.classList.add(cls);
    if (entry.mini) entry.mini.className = `wf-mlh ${cls}`;
  });
}

/** "north-west", "central", "east" ... where a tile sits on the map, for notice lines. */
function compass(map, tileId) {
  const x = tileId % map.width;
  const y = Math.floor(tileId / map.width);
  const ns = y < map.height / 3 ? 'north' : y >= (map.height * 2) / 3 ? 'south' : '';
  const we = x < map.width / 3 ? 'west' : x >= (map.width * 2) / 3 ? 'east' : '';
  return ns && we ? `${ns}-${we}` : ns || we || 'central';
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
  // Lighthouses: a small diamond in the holder's colour (grey while neutral), above the fog.
  const miniLights = [];
  (map.lighthouses || []).forEach((l) => {
    const c = tileCentre(map, l.tileId);
    const m = el('span', 'wf-mlh');
    Object.assign(m.style, { left: `${c.x / 10}px`, top: `${c.y / 10}px` });
    miniLights.push([l.tileId, m]);
  });
  miniFog = el('span');
  Object.assign(miniFog.style, { position: 'absolute', inset: '0' });
  minimap.appendChild(miniFog);
  miniUnits = el('span');
  Object.assign(miniUnits.style, { position: 'absolute', inset: '0' });
  minimap.appendChild(miniUnits);
  miniLights.forEach(([tileId, m]) => {
    minimap.appendChild(m);
    const entry = lighthouseNodes.get(tileId);
    if (entry) entry.mini = m;
  });
  miniView = el('span');
  Object.assign(miniView.style, { border: '1px solid #fff', boxShadow: '0 0 4px #fff', boxSizing: 'border-box' });
  minimap.appendChild(miniView);
}

function renderMiniUnits() {
  if (!miniUnits || !live) return;
  miniUnits.innerHTML = '';
  const seen = new Set();
  live.units.forEach((u) => {
    const key = `${u.tileId}:${u.team}`;
    if (seen.has(key)) return;
    seen.add(key);
    const c = tileCentre(state.map, u.tileId);
    miniUnits.appendChild(miniRect(c.x / 10 - 2, c.y / 10 + 1, 4, 4, u.team === 'red' ? '#ff5a5f' : '#4f93ff', '50%'));
  });
}

/** Fogged tiles darken on the minimap too (the mockup's dark edge over unseen ground). */
function renderMiniFog(vis) {
  if (!miniFog) return;
  miniFog.innerHTML = '';
  const { map } = state;
  const s2 = TILE / 10;
  for (let y = 0; y < map.height; y++) {
    let x = 0;
    while (x < map.width) {
      if (vis[y * map.width + x] === '1') {
        x++;
        continue;
      }
      const x0 = x;
      while (x < map.width && vis[y * map.width + x] !== '1') x++;
      miniFog.appendChild(miniRect(x0 * s2, y * s2, (x - x0) * s2, s2, 'rgba(0,0,0,.6)'));
    }
  }
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

// ---------- Live combat effects (3-resolution.html, played once on the map) ----------

const FX_LIFE = { dmg: 1400, loss: 1600, boom: 1100, spark: 800, bolt: 450, dust: 1600 };
const ARCANE_TYPES = new Set(['acolyte', 'apprentice', 'mysticArcher', 'battlemage', 'summoner', 'archmage', 'golem']);

/** A one-shot billboard on the fx layer at a tile's stand point, removed after `life` ms. */
function fxBoard(tileId, html, { w = 120, h = 120, dy = 0, z = 0, life = 1400, team = null } = {}) {
  if (!fxLayer) return null;
  const { map } = state;
  const p = standPoint(map, tileId, team || 'red', false);
  const node = ent(p.x, p.y + dy, p.z + z);
  const bb = billboard(html, w, h);
  bb.style.setProperty('--life', `${life}ms`);
  node.appendChild(bb);
  fxLayer.appendChild(node);
  setTimeout(() => node.remove(), life);
  return node;
}

const fmtDmg = (n) => `−${n >= 3 ? Math.round(n) : Math.max(0.1, n).toFixed(1).replace(/\.0$/, '')}`;

/** A bolt lying on the ground plane from the shooter to its target (frame 2's .bolt). */
function fxBolt(fromTileId, toTileId, arcane) {
  const { map } = state;
  const a = standPoint(map, fromTileId, 'red', false);
  const b = standPoint(map, toTileId, 'red', false);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1) return;
  const ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  const bolt = el('div', `bolt${arcane ? ' v' : ''}`);
  Object.assign(bolt.style, {
    left: `${Math.round(a.x)}px`,
    top: `${Math.round(a.y)}px`,
    width: `${Math.round(len)}px`,
    transform: `translateZ(${Math.round(Math.max(a.z, b.z) + 24)}px) rotate(${ang}deg)`,
  });
  fxLayer.appendChild(bolt);
  setTimeout(() => bolt.remove(), FX_LIFE.bolt);
}

const SPARKS = [20, 80, 140, -40, -100, 200]
  .map((r, i) => `<span class="spk" style="top: 50px; transform: rotate(${r}deg)"><i style="animation-delay: -${(i % 3) * 0.1}s"></i></span>`)
  .join('');

/** Turns one snapshot's events into on-map effects. Hits are summed per tile so a big fight stays readable. */
function playEffects(events) {
  if (!fxLayer || !state || !state.map) return;
  const hits = new Map(); // victim tile -> { dmg, base, team }
  const shots = new Map(); // "from>to" -> { from, to, ranged, arcane }
  const losses = new Map(); // "tile|team" -> { tileId, team, n }
  const gains = new Map(); // tile -> 💎 my haulers unloaded there this snapshot
  events.forEach((e) => {
    if (e.type === 'underAttack' || e.type === 'baseHit') {
      const base = e.type === 'baseHit';
      const k = `${e.tileId}|${base ? 'base' : e.team}`;
      const h = hits.get(k) || { tileId: e.tileId, dmg: 0, base, team: e.team };
      h.dmg += e.dmg;
      hits.set(k, h);
      if (e.fromTileId != null) {
        shots.set(`${e.fromTileId}>${e.tileId}`, { from: e.fromTileId, to: e.tileId, ranged: e.ranged, arcane: ARCANE_TYPES.has(e.by) });
      }
    } else if (e.type === 'deposit' && e.owner === state.you) {
      gains.set(e.tileId, (gains.get(e.tileId) || 0) + e.minerals);
    } else if (e.type === 'spawn' && e.owner === state.you) {
      feed(`${UNIT_NAMES[e.unitType] || 'Unit'} ready`);
    } else if (e.type === 'lighthouse') {
      // A flip: a flash of the new colour round the lamp, and a notice line.
      fxBoard(e.tileId, `<span class="wf-lflash wf-lf-${e.team}"></span>`, { w: 140, h: 140, dy: -10, z: 30, life: FX_LIFE.boom, team: e.team });
      const who = e.team === 'red' ? 'Red' : 'Blue';
      feed(`${who} took the ${compass(state.map, e.tileId)} lighthouse`, e.team);
      if (e.team === state.myTeam) haptics.success();
    } else if (e.type === 'death') {
      const k = `${e.tileId}|${e.team}`;
      const l = losses.get(k) || { tileId: e.tileId, team: e.team, n: 0 };
      l.n++;
      losses.set(k, l);
    }
  });
  shots.forEach((s) => {
    if (s.ranged) fxBolt(s.from, s.to, s.arcane);
    else fxBoard(s.to, SPARKS, { w: 60, h: 100, life: FX_LIFE.spark });
  });
  hits.forEach((h) => {
    if (h.base) {
      // Frame 3's siege burst over the castle, with the damage above it.
      fxBoard(h.tileId, `<span class="boom" style="left: 17px; top: 6px; width: 76px; height: 76px"></span><span class="shock" style="left: 27px; top: 16px; width: 56px; height: 56px"></span><span class="dmg" style="left: 34px; top: -40px">${fmtDmg(h.dmg)}</span>`,
        { w: 110, h: 110, dy: -30, z: 20, life: FX_LIFE.dmg });
      const hud = hpSegEl[h.team];
      hud.classList.remove('wf-hpdrop');
      void hud.offsetWidth; // restart the blink
      hud.classList.add('wf-hpdrop');
    } else {
      fxBoard(h.tileId, `<span class="dmg wf-unit" style="left: 40px; top: 0">${fmtDmg(h.dmg)}</span>`,
        { w: 110, h: 120, z: 14, life: FX_LIFE.dmg, team: h.team });
    }
  });
  gains.forEach((n, tileId) => {
    // Haulers unloading a tick apart add onto the number still floating there.
    const prev = gainNodes.get(tileId);
    if (prev && prev.node.isConnected) {
      prev.total += n;
      prev.node.querySelector('.wf-gain').textContent = `+${Math.round(prev.total)}💎`;
      return;
    }
    const node = fxBoard(tileId, `<span class="dmg wf-gain" style="left: 34px; top: 0">+${Math.round(n)}💎</span>`, { w: 110, h: 120, dy: -40, z: 24, life: FX_LIFE.dmg, team: state.myTeam });
    if (node) gainNodes.set(tileId, { node, total: n });
  });
  losses.forEach((l) => {
    fxBoard(l.tileId, `<span class="boom" style="left: 20px; top: 40px; width: 70px; height: 70px"></span><span class="loss c-${l.team}" style="left: 38px; top: -26px">−${l.n}</span>`,
      { w: 110, h: 120, z: 30, life: FX_LIFE.loss, team: l.team });
  });
}

/** Frame 1's dust: a puff behind every stack that sets off on a new step. */
function marchDust() {
  if (!fxLayer) return;
  const live2 = new Set();
  stackNodes.forEach((entry, key) => {
    const g = entry.group;
    if (g.next == null) return;
    live2.add(key);
    if (stepSeen.get(key) === g.stepStartedAt) return;
    stepSeen.set(key, g.stepStartedAt);
    fxBoard(g.tileId, '<span class="smoke dust"><span></span><span></span><span></span></span>', { w: 30, h: 10, life: FX_LIFE.dust, team: g.team });
  });
  [...stepSeen.keys()].forEach((k) => {
    if (!live2.has(k)) stepSeen.delete(k);
  });
}

const BURN = '<span class="wf-burn"><span class="flame" style="left: 107px; top: 35px"></span><span class="flame" style="left: 115px; top: 40px; animation-delay: -.2s; transform: scale(.8)"></span><span class="flame" style="left: 73px; top: 30px; animation-delay: -.1s"></span><span class="flame" style="left: 23px; top: 44px; animation-delay: -.25s; transform: scale(.7)"></span><span class="smoke" style="left: 86%; bottom: 92px"><span></span><span></span><span></span></span><span class="smoke" style="left: 58%; bottom: 98px"><span></span><span></span><span></span></span></span>';

/** Below half HP a castle burns like the siege frame's. */
function renderCastles(bases) {
  ['red', 'blue'].forEach((team) => {
    const bb = castleBoards[team];
    const base = bases[team];
    if (!bb || !base) return;
    const burning = base.hp > 0 && base.hp / base.maxHp < 0.5;
    const flames = bb.querySelector('.wf-burn');
    if (burning && !flames) bb.insertAdjacentHTML('beforeend', BURN);
    if (!burning && flames) flames.remove();
  });
}

// ---------- Under attack (private alert from the server) ----------

function onAlert({ tileId, base }) {
  if (!state || state.phase !== 'playing' || !state.map) return;
  alertTile = tileId;
  alertText.textContent = base ? '▲ BASE UNDER ATTACK' : '▲ UNDER ATTACK';
  alertEl.classList.remove('hidden');
  clearTimeout(alertTimer);
  alertTimer = setTimeout(() => alertEl.classList.add('hidden'), 4000);
  haptic([120, 60, 120]);
  sfx.error();
  // The mockup's amber ping on the tile, and a blinking marker on the minimap.
  fxBoard(tileId, '<span class="ping" style="display: block"></span>', { w: 30, h: 30, z: 8, life: 3000 });
  if (minimap) {
    const c = tileCentre(state.map, tileId);
    const m = el('span', 'wf-mping');
    Object.assign(m.style, { left: `${c.x / 10}px`, top: `${c.y / 10}px` });
    minimap.appendChild(m);
    setTimeout(() => m.remove(), 3000);
  }
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
    // The mockup's "hidden" now says whether any of them are inside your vision.
    const t = enemies[0].team;
    const seen = Boolean(live && live.units.some((u) => u.team === t));
    line(seen ? '#ffcc33' : '#4c5b69', `${t.toUpperCase()} ×${enemies.length}`, teamColour(t), seen ? 'in sight' : 'hidden');
  }
}

function renderBattle(data) {
  const fresh = builtFor !== data.clock.startedAt;
  if (fresh) {
    selected.clear();
    mode = 'move';
    buildWorld(data);
    builtFor = data.clock.startedAt;
  }
  buildCards(data);
  clearInterval(clockTimer);
  clockTimer = setInterval(tickClock, 1000);
  stripSeen = null;
  applyLive(data);

  ctx.showScreen('warfront');
  if (fresh) {
    // Start the camera on your own castle (needs the screen laid out first).
    requestAnimationFrame(() => {
      const home = data.map.bases.find((b) => b.team === (data.myTeam || 'red'));
      lookAt(data.map, home ? home.tileId : 0);
    });
  }
}

/** One fogged snapshot (from wfState, then every wfLive tick). */
function applyLive(view) {
  if (!state || state.phase !== 'playing' || !view || !view.units) return;
  if (view.serverNow) clockSkew = view.serverNow - Date.now();
  live = view;
  // Drop selected units that are gone (dead, or no longer mine).
  const mine = new Set(view.units.filter((u) => u.owner === state.you).map((u) => u.id));
  [...selected].forEach((id) => {
    if (!mine.has(id)) selected.delete(id);
  });
  const seen = view.units.some((u) => u.team !== state.myTeam);
  if (seen !== stripSeen) {
    stripSeen = seen;
    renderStrip(state);
  }
  renderFog();
  renderPickups();
  renderLighthouses();
  renderUnits();
  renderOrders();
  renderHp('red', view.bases.red);
  renderHp('blue', view.bases.blue);
  renderCastles(view.bases);
  if (view.events && view.events.length) playEffects(view.events);
  marchDust();
  tickClock();
  renderInfo();
  renderSys();
  if (view.me) {
    supplyEl.textContent = Math.floor(view.me.supply);
    supplyRateEl.textContent = `+${(Math.round(view.me.supplyRate * 10) / 10).toFixed(1)}/s`;
    mineralsEl.textContent = Math.floor(view.me.minerals);
  } else {
    supplyEl.textContent = '–';
    supplyRateEl.textContent = '';
    mineralsEl.textContent = '–';
  }
  renderCards();
}

const UNIT_NAMES = {
  laborer: 'Laborer', peon: 'Peon', acolyte: 'Acolyte',
  militiaman: 'Militiaman', crossbow: 'Crossbow', outrider: 'Outrider', bastion: 'Bastion', ballista: 'Ballista',
  warrior: 'Warrior', skirmisher: 'Skirmisher', raider: 'Raider', berserker: 'Berserker', warchief: 'Warchief',
  apprentice: 'Apprentice', mysticArcher: 'Mystic Archer', battlemage: 'Battlemage', summoner: 'Summoner', archmage: 'Archmage', golem: 'Golem',
};
const plural = (name, n) => (n === 1 ? name : name.endsWith('man') ? `${name.slice(0, -3)}men` : `${name}s`);
const areaName = (map, id) => `${map.tiles[id]} ${Math.floor(id / map.width) + 1}-${(id % map.width) + 1}`;

/** The console's info well: the selected stack (mockup), or the battlefield's name and lore. */
function renderInfo() {
  const { map } = state;
  const team = state.myTeam || 'red';
  const sel = live.units.filter((u) => u.owner === state.you && selected.has(u.id));
  infoPortrait.className = `scan tm-${team}`;
  infoHp.innerHTML = '';
  if (!sel.length) {
    infoPortrait.innerHTML = CASTLE_SPRITE.replace('<svg ', '<svg style="width: 44px; height: 44px; overflow: visible" ');
    infoTitle.textContent = map.theme;
    infoSub.textContent = map.lore || '';
    infoOrder.textContent = state.myTeam ? '▸ TAP YOUR UNITS TO COMMAND THEM' : '';
    renderSys();
    return;
  }
  const counts = new Map();
  sel.forEach((u) => counts.set(u.type, (counts.get(u.type) || 0) + 1));
  const [lead] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  infoPortrait.innerHTML = (UNIT_SPRITES[lead] || '').replace('<svg ', '<svg style="width: 40px; height: 50px; overflow: visible" ');
  infoTitle.textContent = counts.size === 1 ? `${plural(UNIT_NAMES[lead], sel.length)} ×${sel.length}` : `Squad ×${sel.length}`;
  const here = sel[0].tileId;
  infoSub.textContent = `${RACE_NAMES[state.myRace]} · ${map.tiles[here]}`;
  sel.slice(0, 10).forEach((u) => {
    const max = UNIT_MAX_HP[u.type] || u.hp;
    const c = u.hp / max >= 0.75 ? '#4dff7a' : '#ffcc33';
    const pip = el('span');
    Object.assign(pip.style, { width: '20px', height: '5px', background: c, boxShadow: `0 0 4px ${c}` });
    infoHp.appendChild(pip);
  });
  const dest = sel.find((u) => u.path && u.path.length);
  const hauler = sel.find((u) => u.haul);
  const cap = state.carryCap || 4;
  let order;
  if (mode === 'haul') order = '▸ TAP A MINERAL VEIN TO HAUL';
  else if (hauler && hauler.haul.stage === 'loading') order = `▸ HAULING · LOADING 💎 ${Math.floor(hauler.carrying * 10) / 10}/${cap}`;
  else if (hauler && hauler.haul.stage === 'toDeposit') order = `▸ HAULING · 💎 ${Math.round(hauler.carrying)} → BASE`;
  else if (hauler) order = '▸ HAULING · TO THE VEIN';
  else if (dest) order = `▸ MOVE → ${areaName(map, dest.path[dest.path.length - 1]).toUpperCase()}`;
  else if (sel.every((u) => u.holding)) order = '▸ HOLDING · TAP A TILE TO MOVE';
  else order = '▸ TAP A TILE TO MOVE';
  infoOrder.textContent = order;
}

// ---------- Command console (2-battlefield.html + 2c-command-cards.html) ----------

// Letter keys, as the mockup's cards show them (desktop players can press them too).
const HOTKEYS = {
  laborer: 'W', militiaman: 'M', crossbow: 'C', outrider: 'O', bastion: 'B', ballista: 'L',
  peon: 'P', warrior: 'W', skirmisher: 'S', raider: 'R', berserker: 'B', warchief: 'C',
  acolyte: 'C', apprentice: 'A', mysticArcher: 'R', battlemage: 'B', summoner: 'S', archmage: 'G',
};
// Card labels break long names the way the mockup does.
const CARD_NAMES = {
  militiaman: 'Militia-man', skirmisher: 'Skirmish-er', battlemage: 'Battle-mage', mysticArcher: 'Mystic Archer',
  // Six cards a row (the Worker joins the mockup's five) leave a little less room.
  apprentice: 'Appren-tice', summoner: 'Summon-er', archmage: 'Arch-mage', crossbow: 'Cross-bow', berserker: 'Berserk-er',
};
const RACE_CARD_CLASS = { forge: 'f', horde: 'h', arcane: '' };
const WORKER_TYPES = new Set(['laborer', 'peon', 'acolyte']);

/** A unit sprite with the `sp` class the console's sizing rules expect. */
function cardSprite(unitType) {
  const svg = UNIT_SPRITES[unitType] || '';
  return svg.includes('<svg class="') ? svg.replace('<svg class="', '<svg class="sp ') : svg.replace('<svg ', '<svg class="sp" ');
}

/** One line in the map's notice overlay (the mockup's "[Team] …" lines); fades by itself. */
function feed(text, tone = 'grn') {
  const line = el('span', tone === 'grn' ? 'grn' : '');
  // 'amb' for warnings; 'red' / 'blue' for a team's news in its HUD colour.
  if (tone !== 'grn') line.style.color = { red: '#ff7a7e', blue: '#7fb0ff' }[tone] || '#ffcc33';
  line.textContent = text;
  feedEl.appendChild(line);
  while (feedEl.children.length > 3) feedEl.firstChild.remove();
  setTimeout(() => line.remove(), 3500);
}

function myBaseTile() {
  const base = state && state.map && state.map.bases.find((b) => b.team === state.myTeam);
  return base ? base.tileId : null;
}

/** The race's unit cards, built once per battle (race and team never change mid-match). */
function buildCards(data) {
  const key = `${data.myRace}|${data.myTeam}|${data.clock.startedAt}`;
  if (cardsFor === key) return;
  cardsFor = key;
  cardNodes.clear();
  cardsEl.innerHTML = '';
  cardsEl.className = `well tm-${data.myTeam || 'red'} ${RACE_CARD_CLASS[data.myRace] || ''}`;
  armyLabel.textContent = data.myRace ? `Recruit · ${RACE_NAMES[data.myRace]}` : 'Watching · no army this match';
  cardsEl.classList.toggle('hidden', !data.catalog || !data.catalog.length);
  (data.catalog || []).forEach((c) => {
    const btn = el('button', `cmd${c.structure ? ' struct' : ''}`);
    btn.type = 'button';
    const price = c.minerals ? `${c.supply} Supply and ${c.minerals} Minerals` : `${c.supply} Supply`;
    btn.setAttribute('aria-label', `Produce ${c.name}, costs ${price}`);
    btn.appendChild(el('span', 'hk')).textContent = HOTKEYS[c.unitType] || '';
    btn.appendChild(el('span', 'cc')).textContent = c.supply;
    if (c.minerals) btn.appendChild(el('span', 'wf-cm')).textContent = `💎${c.minerals}`;
    if (c.structure) btn.appendChild(el('span', 'tag')).textContent = 'STRUCTURE';
    const q = btn.appendChild(el('span', 'wf-q'));
    btn.appendChild(el('span', 'cs', cardSprite(c.unitType)));
    btn.appendChild(el('span', 'cn')).textContent = CARD_NAMES[c.unitType] || c.name;
    const bar = el('span', 'wf-qbar hidden', '<span style="width: 0%"></span>');
    btn.appendChild(bar);
    btn.addEventListener('click', () => produceUnit(c.unitType));
    cardsEl.appendChild(btn);
    cardNodes.set(c.unitType, { btn, q, bar, info: c, sig: '' });
  });
}

/** Greys out what you can't afford (or have no room for) and shows each type's queue. */
function renderCards() {
  if (!live || !state) return;
  const me = live.me;
  const now = serverNow();
  const queued = new Map(); // unitType -> count
  const building = new Map(); // unitType -> progress 0..1 of the one at the front of a queue
  ((me && me.queues) || []).forEach(({ items }) => {
    items.forEach((it, i) => {
      queued.set(it.unitType, (queued.get(it.unitType) || 0) + 1);
      if (i === 0) {
        const p = Math.max(0, Math.min(1, (now - it.startedAt) / Math.max(1, it.doneAt - it.startedAt)));
        building.set(it.unitType, Math.max(building.get(it.unitType) || 0, p));
      }
    });
  });
  cardNodes.forEach((card, unitType) => {
    const c = card.info;
    const roomFor = me ? me.unitCap - me.units >= (unitType === 'summoner' ? 2 : 1) : false;
    const afford = Boolean(me) && me.supply >= c.supply && me.minerals >= c.minerals && roomFor;
    const n = queued.get(unitType) || 0;
    const sig = `${afford ? 1 : 0}|${n}`;
    if (sig !== card.sig) {
      card.sig = sig;
      card.btn.classList.toggle('dim', !afford);
      card.btn.classList.toggle('wf-busy', n > 0);
      card.q.textContent = n ? `×${n}` : '';
      card.bar.classList.toggle('hidden', !building.has(unitType));
    }
    if (building.has(unitType)) card.bar.firstChild.style.width = `${Math.round(building.get(unitType) * 100)}%`;
  });
}

function produceUnit(unitType) {
  if (!state || state.phase !== 'playing' || !state.myTeam || !live || !live.me) return;
  const card = cardNodes.get(unitType);
  if (card) {
    card.btn.classList.add('on');
    setTimeout(() => card.btn.classList.remove('on'), 220);
  }
  haptics.tap();
  ctx.socket.emit('wfCommand', { kind: 'produce', unitType, atTileId: myBaseTile() }, (res) => {
    if (res && !res.ok) {
      feed(res.error, 'amb');
      sfx.error();
      haptics.warn();
    } else {
      sfx.click();
    }
  });
}

function selectedUnits() {
  if (!live || !state) return [];
  return live.units.filter((u) => u.owner === state.you && selected.has(u.id));
}

/** Move / Haul / Hold: lit for what the selection can do, green for the tap mode in use. */
function renderSys() {
  const sel = selectedUnits();
  const workers = sel.some((u) => WORKER_TYPES.has(u.type));
  if (mode === 'haul' && !workers) mode = 'move';
  cmdBtn.move.classList.toggle('dim', !sel.length);
  cmdBtn.move.classList.toggle('on', Boolean(sel.length) && mode === 'move');
  cmdBtn.haul.classList.toggle('dim', !workers);
  cmdBtn.haul.classList.toggle('on', workers && mode === 'haul');
  cmdBtn.hold.classList.toggle('dim', !sel.length);
  cmdBtn.hold.classList.toggle('on', Boolean(sel.length) && sel.every((u) => u.holding));
}

function sendOrder(cmd) {
  ctx.socket.emit('wfCommand', cmd, (res) => {
    if (res && !res.ok) {
      feed(res.error, 'amb');
      sfx.error();
      haptics.warn();
    }
  });
  haptics.tap();
}

function onSysButton(kind) {
  const sel = selectedUnits();
  if (!sel.length) {
    feed('Tap your units first', 'amb');
    return;
  }
  if (kind === 'move') mode = 'move';
  else if (kind === 'haul') {
    if (!sel.some((u) => WORKER_TYPES.has(u.type))) {
      feed('Only Workers can haul', 'amb');
      return;
    }
    mode = mode === 'haul' ? 'move' : 'haul';
  } else if (kind === 'hold') {
    mode = 'move';
    sendOrder({ kind: 'hold', unitIds: sel.map((u) => u.id) });
  }
  sfx.click();
  renderSys();
  renderInfo();
}

/** Tap on the battlefield: pick up your stack on that tile, or send the selection there. */
function onTileTap(tileId) {
  if (!state || state.phase !== 'playing' || !live || !state.myTeam) return;
  const vein = state.map.veins.some((v) => v.tileId === tileId);
  const workerIds = selectedUnits().filter((u) => WORKER_TYPES.has(u.type)).map((u) => u.id);
  if (mode === 'haul') {
    mode = 'move';
    if (!vein) feed('Tap a mineral vein to haul from it', 'amb');
    else if (workerIds.length) sendOrder({ kind: 'haul', workerIds, veinTileId: tileId });
    renderSys();
    renderInfo();
    return;
  }
  const mineHere = live.units.filter((u) => u.owner === state.you && u.tileId === tileId).map((u) => u.id);
  const selHere = mineHere.filter((id) => selected.has(id));
  if (mineHere.length && (!selected.size || selHere.length < mineHere.length)) {
    // Select (or switch to) the stack on this tile.
    selected.clear();
    mineHere.forEach((id) => selected.add(id));
    sfx.click();
    haptics.tap();
  } else if (mineHere.length && selHere.length === mineHere.length && selected.size === selHere.length) {
    selected.clear(); // tapping your selected stack again lets go of it
  } else if (selected.size && vein && workerIds.length === selected.size) {
    // Workers sent onto a vein start hauling from it.
    sendOrder({ kind: 'haul', workerIds, veinTileId: tileId });
  } else if (selected.size) {
    const unitIds = [...selected];
    ctx.socket.emit('wfCommand', { kind: 'move', unitIds, toTileId: tileId }, (res) => {
      if (res && !res.ok) {
        sfx.error();
        haptics.warn();
      }
    });
    haptics.tap();
  } else {
    return;
  }
  renderUnits();
  renderSys();
  renderInfo();
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
    if (drag && drag.moved) suppressClickUntil = Date.now() + 50;
    drag = null;
  });
}
let suppressClickUntil = 0;

// ---------- Game over (4-game-over.html) ----------

const goScreen = $('wf-gameover-screen');
const goRoot = goScreen ? goScreen.querySelector('.wf') : null;
const goVp = $('wf-go-vp');
const goCam = $('wf-go-cam');
const goWorld = $('wf-go-world');
const goConfetti = $('wf-go-confetti');
const goReason = $('wf-go-reason');
const goTitle = $('wf-go-title');
const goSub = $('wf-go-sub');
const goRows = $('wf-go-rows');
const goMvp = $('wf-go-mvp');
const goAgain = $('wf-go-again');
const goBack = $('wf-go-back');
const goError = $('wf-go-error');
const goScoreboard = $('wf-go-scoreboard');
let goBuiltFor = null; // clock.startedAt of the battle the scene was built for

const TEAM_NAME = { red: 'Red', blue: 'Blue' };
const fmtMatchTime = (ms) => {
  const secs = Math.round(ms / 1000);
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
};
// The mockup's confetti, in the winners' colours.
const CONFETTI = {
  red: ['#ff5a5f', '#ffcc33', '#ff5a5f', '#fff', '#ffcc33', '#ff5a5f', '#ffcc33', '#ff5a5f', '#fff', '#ff5a5f'],
  blue: ['#4f93ff', '#ffcc33', '#4f93ff', '#fff', '#ffcc33', '#4f93ff', '#ffcc33', '#4f93ff', '#fff', '#4f93ff'],
};
const CONFETTI_AT = [[8, 0], [18, -1.1], [29, -2.3], [41, -0.6], [52, -1.7], [63, -2.8], [74, -0.3], [85, -1.4], [93, -2.1], [35, -2.6]];
// Banners planted on the ruins' pad and scorch marks on the ground round it: the
// mockup's scene, scaled from its plateau to the castle's 98px stone pad.
const BANNERS = [[-40, -46], [44, 6], [-43, 5]];
const SCORCHES = [[-120, 20], [-200, -30], [-20, 60]];

/** The final map with the fog lifted, framed on the fallen (or weaker) base. */
function buildGameOverScene(data) {
  // The battlefield's world is done with; its registries now point at this scene.
  world.innerHTML = '';
  builtFor = null;
  selected.clear();
  buildWorld(data, { cam: goCam, world: goWorld, minimap: false });
  live = { units: data.units, bases: data.bases, visible: data.visible, pickups: data.pickups, lighthouses: data.lighthouses, events: [] };
  renderFog();
  renderPickups();
  renderLighthouses();
  renderUnits();
  renderCastles(data.bases);

  // The loser's castle lies in ruins and burns; the winners plant their banners round it.
  const { winner } = data;
  const loser = winner === 'red' ? 'blue' : winner === 'blue' ? 'red' : null;
  if (loser && data.bases[loser].hp <= 0 && castleBoards[loser]) {
    const bb = castleBoards[loser];
    const node = bb.parentNode;
    node.insertBefore(el('span', 'dec fireglow'), bb);
    bb.classList.add('wf-ruin');
    bb.style.width = '170px';
    bb.style.height = '150px';
    bb.style.transform = 'translateX(-50%) rotateX(-40deg) scale(.9)';
    bb.innerHTML = `${RUINED_CASTLE_SPRITE}<span class="flame" style="left: 64px; top: 30px"></span><span class="flame" style="left: 80px; top: 24px; animation-delay: -.15s; transform: scale(1.2)"></span><span class="flame" style="left: 22px; top: 62px; animation-delay: -.25s"></span><span class="flame" style="left: 140px; top: 66px; animation-delay: -.1s; transform: scale(.85)"></span><span class="flame" style="left: 112px; top: 74px; animation-delay: -.3s; transform: scale(.7)"></span><span class="smoke" style="left: 48%; bottom: 120px"><span></span><span></span><span></span></span><span class="smoke" style="left: 20%; bottom: 80px"><span></span><span></span><span></span></span><span class="smoke" style="left: 84%; bottom: 84px"><span></span><span></span><span></span></span>`;
    // Banners stand on the castle's stone pad (the mockup's plateau), scorch marks round it.
    const c = tileCentre(data.map, data.bases[loser].tileId);
    BANNERS.forEach(([dx, dy]) => {
      const b = ent(c.x + dx, c.y + 18 + dy, BASE_PAD_Z, `tm-${winner}`);
      const sh = el('span', 'dec tshadow');
      Object.assign(sh.style, { width: '30px', height: '14px' });
      b.appendChild(sh);
      b.appendChild(billboard(BANNER_SPRITE, 34, 64));
      unitLayer.appendChild(b);
    });
    const ground = goWorld.querySelector('.terrain');
    SCORCHES.forEach(([dx, dy]) => {
      const sc = el('span', 'scorch');
      Object.assign(sc.style, { left: `${c.x + dx}px`, top: `${c.y + dy}px` });
      ground.appendChild(sc);
    });
  }

  goConfetti.innerHTML = '';
  if (CONFETTI[winner]) {
    CONFETTI_AT.forEach(([left, delay], i) => {
      const bit = el('i');
      Object.assign(bit.style, { left: `${left}%`, background: CONFETTI[winner][i], animationDelay: `${delay}s` });
      goConfetti.appendChild(bit);
    });
  }

  // Frame the fallen base (the weaker one at the time cap, the map's centre on a draw).
  const focus = loser ? data.bases[loser].tileId
    : Math.floor(data.map.height / 2) * data.map.width + Math.floor(data.map.width / 2);
  requestAnimationFrame(() => {
    // Like the mockup: the fallen castle stands a little below the middle, off-centre
    // toward its own map edge so the winners' side of the field fills the rest. A
    // transform rather than scrolling, so a base in the top rows can still come down
    // out from under the title (the dark camera background shows above the map).
    const c = tileCentre(data.map, focus);
    const side = loser === 'blue' ? 0.68 : loser === 'red' ? 0.32 : 0.5;
    const vw = goVp.clientWidth;
    const vh = goVp.clientHeight;
    const x = Math.max(0, Math.min(goCam.offsetWidth - vw, c.x - vw * side));
    const y = Math.max(-vh * 0.4, Math.min(goCam.offsetHeight - vh, (c.y / (data.map.height * TILE)) * goCam.offsetHeight - vh * 0.62));
    goCam.style.transform = `translate(${-Math.round(x)}px, ${-Math.round(y)}px)`;
  });
}

function renderBaseWell(team, base, winner) {
  const well = $(`wf-go-${team}`);
  const hp = Math.max(0, Math.round(base.hp));
  const hpEl2 = $(`wf-go-${team}-hp`);
  hpEl2.textContent = `${hp}/${base.maxHp}`;
  hpEl2.className = hp > 0 ? 'grn' : '';
  hpEl2.style.color = hp > 0 ? '' : '#ff5a5f';
  $(`wf-go-${team}-bar`).style.width = `${Math.max(0, Math.min(100, Math.round((base.hp / base.maxHp) * 100)))}%`;
  // The winner's well glows in its team colour; the other keeps a dim team edge.
  const glow = { red: 'inset 0 0 0 1px #000, inset 0 0 0 2px #ff5a5f, inset 0 0 20px rgba(229,72,77,.3)', blue: 'inset 0 0 0 1px #000, inset 0 0 0 2px #4f93ff, inset 0 0 20px rgba(59,130,246,.3)' };
  const dim = { red: 'inset 0 0 0 1px #000, inset 0 0 0 2px #7a2a2e', blue: 'inset 0 0 0 1px #000, inset 0 0 0 2px #23477e' };
  well.style.boxShadow = winner === team ? glow[team] : dim[team];
}

function renderStatRows(data) {
  goRows.innerHTML = '';
  const order = (t) => (t === data.winner ? 0 : t === 'red' ? 1 : 2);
  const rows = [...data.stats].sort((a, b) => order(a.team) - order(b.team) || b.baseDmg - a.baseDmg || b.kills - a.kills || a.name.localeCompare(b.name));
  rows.forEach((s) => {
    const won = s.team === data.winner;
    const row = el('div', 'row well');
    row.style.boxShadow = `inset 0 0 0 1px #000, inset 0 0 0 2px ${s.team === 'red' ? '#7a2a2e' : '#23477e'}`;
    row.appendChild(el('span', `por tm-${s.team}`, UNIT_SPRITES[RACE_PORTRAITS[s.race]] || ''));
    const who = el('span');
    who.style.minWidth = '0';
    if (s.name === data.mvp) who.appendChild(el('span', 'amb')).textContent = '★ ';
    const nm = el('span');
    Object.assign(nm.style, { fontWeight: '700', color: s.team === 'red' ? '#ff7a7e' : '#7fb0ff' });
    nm.textContent = s.name === data.you ? 'YOU' : s.name.toUpperCase();
    who.appendChild(nm);
    const race = el('span');
    Object.assign(race.style, { display: 'block', fontSize: '9.5px', color: '#8fa3b5', letterSpacing: '.12em' });
    race.textContent = `${(RACE_NAMES[s.race] || '').toUpperCase()}${s.connected ? '' : ' · OFFLINE'}`;
    who.appendChild(race);
    row.appendChild(who);
    row.appendChild(el('span', won ? 'grn' : '')).textContent = s.kills;
    row.appendChild(el('span')).textContent = s.lost;
    row.appendChild(el('span', won ? 'amb' : '')).textContent = Math.round(s.baseDmg);
    goRows.appendChild(row);
  });
  goMvp.classList.toggle('hidden', !data.mvp);
}

function renderGameOver(data) {
  const { winner } = data;
  goRoot.classList.toggle('wf-go-red-won', winner === 'red');
  goRoot.classList.toggle('wf-go-blue-won', winner === 'blue');
  goRoot.classList.toggle('wf-go-draw', winner === 'draw');
  if (goBuiltFor !== data.clock.startedAt) {
    buildGameOverScene(data);
    goBuiltFor = data.clock.startedAt;
  }

  // "Blue base destroyed · round 11" -> how it ended, with the match time.
  const time = fmtMatchTime(data.matchMs);
  const loser = winner === 'red' ? 'blue' : 'red';
  if (winner === 'draw') {
    goReason.textContent = data.endReason === 'base' ? `Both bases destroyed · ${time}` : `Time up · bases level · ${time}`;
  } else {
    goReason.textContent = data.endReason === 'base' ? `${TEAM_NAME[loser]} base destroyed · ${time}` : `Time up · ${TEAM_NAME[winner]} base stood stronger · ${time}`;
  }
  goReason.style.color = winner === 'blue' ? '#9ac0ff' : winner === 'red' ? '#ff9a9d' : '#8fa3b5';
  goTitle.textContent = winner === 'draw' ? 'DRAW' : `${winner.toUpperCase()} WINS!`;
  // The mockup's 50px fits "RED WINS!" on a 390px phone; "BLUE WINS!" needs a little less.
  goTitle.style.fontSize = goTitle.textContent.length > 9 ? '44px' : '50px';
  // The mockup shows a winner's phone (◆ VICTORY ◆); the other side reads its defeat.
  const lost = data.myTeam && winner !== 'draw' && data.myTeam !== winner;
  goSub.textContent = winner === 'draw' ? '◆ STALEMATE ◆' : lost ? '◆ DEFEAT ◆' : '◆ VICTORY ◆';
  goSub.className = lost ? '' : 'amb';
  goSub.style.color = lost ? '#ff5a5f' : '';
  goSub.style.textShadow = lost ? '0 0 6px rgba(255,90,95,.5)' : '';

  renderBaseWell('red', data.bases.red, winner);
  renderBaseWell('blue', data.bases.blue, winner);
  renderStatRows(data);

  goAgain.disabled = !data.canCommand;
  goAgain.classList.toggle('wf-go-red', winner !== 'blue');
  goAgain.classList.toggle('wf-go-blue', winner === 'blue');
  if (!goError.textContent || goError.classList.contains('wf-notice')) {
    goError.classList.toggle('wf-notice', !data.canCommand);
    goError.textContent = data.canCommand ? '' : 'The host or a captain starts the next battle';
  }
  renderScoreboard(goScoreboard, data.scoreboard || []);
  ctx.showScreen('warfrontOver');
}

function applyState(data) {
  if (!data || data.game !== 'warfront') return;
  state = data;
  if (data.phase !== 'playing') {
    clearInterval(clockTimer);
    clockTimer = null;
    live = null;
  }
  if (data.phase === 'teamSelect') {
    applyTeamSelect(data);
    ctx.showScreen('warfrontTeam');
  } else if (data.phase === 'generating') {
    ctx.showGenerating('warfront');
  } else if (data.phase === 'playing') {
    goBuiltFor = null;
    renderBattle(data);
  } else if (data.phase === 'gameover' && data.map) {
    renderGameOver(data);
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

    goAgain.addEventListener('click', () => {
      socket.emit('playAgainWarfront', (res) => {
        if (res && res.ok) return;
        goError.classList.remove('wf-notice');
        goError.textContent = (res && res.error) || 'Could not start the next battle';
      });
    });
    goBack.addEventListener('click', () => socket.emit('backToLobby', () => {}));

    socket.on('wfState', applyState);
    socket.on('wfLive', applyLive);
    socket.on('wfAlert', onAlert);
    alertEl.addEventListener('click', () => {
      if (state && state.map && alertTile != null) lookAt(state.map, alertTile);
      alertEl.classList.add('hidden');
    });
    ['move', 'haul', 'hold'].forEach((kind) => cmdBtn[kind].addEventListener('click', () => onSysButton(kind)));
    document.addEventListener('keydown', (e) => {
      if (!state || state.phase !== 'playing' || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (e.target && e.target.closest && e.target.closest('input, textarea, select')) return;
      const key = e.key.toUpperCase();
      const hit = (state.catalog || []).find((c) => HOTKEYS[c.unitType] === key);
      if (hit) {
        e.preventDefault();
        produceUnit(hit.unitType);
      }
    });
    world.addEventListener('click', (e) => {
      if (Date.now() < suppressClickUntil) return;
      const tile = e.target.closest('.tile');
      if (tile) onTileTap(Number(tile.dataset.tile));
    });
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
    live = null;
    builtFor = null;
    selected.clear();
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    clearInterval(clockTimer);
    clockTimer = null;
    clearTimeout(errorTimer);
    errorEl.textContent = '';
    clearTimeout(alertTimer);
    alertEl.classList.add('hidden');
    if (fxLayer) fxLayer.innerHTML = '';
    mode = 'move';
    cardsFor = '';
    feedEl.innerHTML = '';
    goBuiltFor = null;
    if (goWorld) goWorld.innerHTML = '';
    if (goConfetti) goConfetti.innerHTML = '';
    if (goError) goError.textContent = '';
  },
};
