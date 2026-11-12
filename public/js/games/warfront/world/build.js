/**
 * Warfront client: buildWorld, which builds the static battlefield once per match from the
 * map (terrain tiles, plateaus, decor, bases, supply, veins, lighthouses, fog sheet, layers).
 * Must NOT contain: per-snapshot rendering. Mockup: 2-battlefield.html.
 */

import { S } from '../store.js';
import {
  CASTLE_SPRITE,
  TREE_SPRITES,
  BUSH_SPRITE,
  BOULDER_SPRITE,
  SUPPLY_SPRITE,
  crystalSprite,
  weaponSprite,
  LIGHTHOUSE_SPRITE,
} from '../sprites.js';
import { el, noise } from '../util.js';
import { TILE, ELEVATION, BASE_PAD_Z } from '../constants.js';
import { cam, world } from '../dom.js';
import { fogSheet } from '../fog.js';
import { buildMinimap } from '../minimap.js';
import { tileCentre, elevationAt, ent, billboard, plateaus, platEl } from './geometry.js';

/**
 * Builds the 2.5D world for `data.map` into a camera (the battlefield's by default;
 * the game-over scene passes its own and no minimap). Resets every per-world registry.
 */
export function buildWorld(data, target = { cam, world, minimap: true }) {
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
  S.decor = [];
  S.castleBoards = {};
  S.lastHp = { red: null, blue: null };
  S.stepSeen.clear();
  S.pickupNodes = new Map();
  S.dropNodes = new Map();
  S.lighthouseNodes = new Map();
  S.structNodes = new Map();
  S.structureTiles = new Set();
  S.stackNodes.clear();
  Object.keys(S.infoSig).forEach((k) => delete S.infoSig[k]);
  S.clickNodes = new Map();
  S.ordersSig = '';
  S.lastVisible = null;

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
    if (bb) S.decor.push({ tileId, bb });
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
    S.pickupNodes.set(w.tileId, node);
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
    S.lighthouseNodes.set(l.tileId, { node, mini: null, team: undefined });
  });
  map.bases.forEach((b) => {
    const c = tileCentre(map, b.tileId);
    const node = ent(c.x, c.y + 18, BASE_PAD_Z, `tm-${b.team}`);
    node.appendChild(el('span', `dec aura-${b.team}`));
    node.appendChild(el('span', 'dec bshadow'));
    const castle = billboard(CASTLE_SPRITE, 130, 130);
    node.appendChild(castle);
    S.castleBoards[b.team] = castle;
    add(c.y + 18, node, b.tileId);
  });
  boards.sort((a, b) => a.y - b.y).forEach((b) => worldEl.appendChild(b.node));

  S.orderLayer = el('div', 'wf-orders');
  worldEl.appendChild(S.orderLayer);
  S.hintLayer = el('div', 'wf-orders');
  worldEl.appendChild(S.hintLayer);
  S.structLayer = el('div', 'wf-structs');
  worldEl.appendChild(S.structLayer);
  S.unitLayer = el('div', 'wf-units');
  worldEl.appendChild(S.unitLayer);
  S.fxLayer = el('div', 'wf-fx');
  worldEl.appendChild(S.fxLayer);

  // Fog of war: a haze sheet on the ground (like the mockup's .fogp), plus one on top of
  // each raised plateau and castle pad so high ground is fogged too.
  S.fogRects = map.tiles.map(() => []);
  const groundFog = fogSheet(map, 0, 0, map.width, map.height);
  groundFog.insertAdjacentHTML('afterbegin', '<defs><filter id="wf-fog-blur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="0.3"></feGaussianBlur></filter></defs>');
  worldEl.appendChild(groundFog);
  plats.forEach(({ node, x0, y0, cols, rows }) => node.appendChild(fogSheet(map, x0, y0, cols, rows)));
  padNodes.forEach(({ node, tileId: id }) => node.appendChild(fogSheet(map, 0, 0, 1, 1, id)));

  if (target.minimap) buildMinimap(map);
}
