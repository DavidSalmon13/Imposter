/**
 * Warfront client: 2.5D world geometry. Tile centres, elevation, positioned entities,
 * billboards, plateaus, where a stack stands and how it walks a step, compass names.
 * Must NOT contain: state reads beyond its arguments, or rendering of game objects.
 * Mockup: 2-battlefield.html (source/Main.dc.html) camera and plateaus.
 */

import { S } from '../store.js';
import { el } from '../util.js';
import { TILE, ELEVATION, BASE_PAD_Z, TOWER_ROOF_PX } from '../constants.js';

export function tileCentre(map, id) {
  const x = id % map.width;
  const y = Math.floor(id / map.width);
  return { x: x * TILE + TILE / 2, y: y * TILE + TILE / 2 };
}

export function elevationAt(map, id) {
  if (map.bases.some((b) => b.tileId === id)) return BASE_PAD_Z;
  return ELEVATION[map.tiles[id]] || 0;
}

export function ent(x, y, z, className = '') {
  const node = el('div', `ent${className ? ` ${className}` : ''}`);
  node.style.left = `${Math.round(x)}px`;
  node.style.top = `${Math.round(y)}px`;
  if (z) node.style.transform = `translateZ(${z}px)`;
  return node;
}

export function billboard(svg, w, h, className = '') {
  const bb = el('div', `bb${className ? ` ${className}` : ''}`, svg);
  bb.style.width = `${w}px`;
  bb.style.height = `${h}px`;
  return bb;
}

/** Raised ground (.plat with cliff walls), merged into rectangles of one terrain. */
export function plateaus(map, terrain, topClass, z) {
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

export function platEl(x, y, w, h, z, topClass) {
  const plat = el(
    'div',
    'plat',
    `<div class="pw pw-f" style="height: ${z}px"></div><div class="pw pw-l" style="width: ${z}px"></div><div class="pw pw-r" style="width: ${z}px"></div><div class="${topClass}"></div>`,
  );
  Object.assign(plat.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`, transform: `translateZ(${z}px)` });
  return plat;
}

/** Where a stack stands on a tile: in front of a castle's gate or a lighthouse, or beside an enemy stack. */
// Where each side's stack stands when two or more sides share a still tile: red left, blue right
// (team battles as before), green and gold a step behind them (free for all).
const SHARE_OFFSET = { red: [-16, 0], blue: [16, 0], green: [-6, -12], gold: [6, -12] };

/** Whether a side's figures face left: those whose base is on the right half of the map. */
export function facesLeft(map, team) {
  const b = map && map.bases.find((x) => x.tileId != null && x.team === team);
  if (!b) return team !== 'red';
  return tileCentre(map, b.tileId).x > (map.width * TILE) / 2;
}

export function standPoint(map, tileId, team, shared) {
  const c = tileCentre(map, tileId);
  const onBase = map.bases.some((b) => b.tileId === tileId);
  // On a lighthouse the stack stands at its foot, in front, so the lamp stays in view.
  const onLight = !onBase && ((map.lighthouses || []).some((l) => l.tileId === tileId) || S.structureTiles.has(tileId));
  return {
    x: c.x + (shared ? (SHARE_OFFSET[team] || SHARE_OFFSET.red)[0] : 0),
    y: c.y + (onBase ? 44 : onLight ? 30 : 14) + (shared ? (SHARE_OFFSET[team] || SHARE_OFFSET.red)[1] : 0),
    z: elevationAt(map, tileId),
  };
}

// Billboards stand at rotateX(-40deg) (battlefield.css .bb): `d` px up one is d·cos40 back in y and
// d·sin40 up in z; its face normal (toward the camera) is (sin40, cos40) in (y, z).
const BB_COS = Math.cos((40 * Math.PI) / 180);
const BB_SIN = Math.sin((40 * Math.PI) / 180);

/**
 * Where a Tower's garrison stands: on the roof deck of the Tower drawn on `tileId`
 * (structures.js puts it at the tile centre, 4px forward), nudged a little toward the
 * camera so the figures stand in front of the deck rather than inside the wall.
 */
export function roofPoint(map, tileId) {
  const c = tileCentre(map, tileId);
  const nudge = 8;
  return {
    x: c.x,
    y: c.y + 4 - TOWER_ROOF_PX * BB_COS + nudge * BB_SIN,
    z: elevationAt(map, tileId) + TOWER_ROOF_PX * BB_SIN + nudge * BB_COS,
  };
}

const CLIMB_PX = 16; // how far (world px) a stack walks while scaling a cliff edge
const smooth = (t) => t * t * (3 - 2 * t);

/**
 * A point `t` (0..1) of the way along one step from tile `a` to the adjacent tile `b`.
 * Height follows the ground under the stack's feet: it stays level on each tile and
 * climbs (or drops) at the cliff edge between them — up just *before* the edge so it
 * stands on top of the plateau as it crosses, down just *after* it — instead of
 * rising evenly across the whole step and sinking into the hill's wall.
 */
export function stepPoint(map, team, a, b, t) {
  const p = standPoint(map, a, team, false);
  const q = standPoint(map, b, team, false);
  const x = p.x + (q.x - p.x) * t;
  const y = p.y + (q.y - p.y) * t;
  let z = p.z;
  if (q.z !== p.z) {
    // Where the stand point crosses the shared tile edge, as a fraction of the step.
    const ca = tileCentre(map, a);
    const cb = tileCentre(map, b);
    const horiz = ca.y === cb.y;
    const edge = horiz ? (ca.x + cb.x) / 2 : (ca.y + cb.y) / 2;
    const from = horiz ? p.x : p.y;
    const to = horiz ? q.x : q.y;
    const tEdge = to === from ? 0.5 : Math.max(0, Math.min(1, (edge - from) / (to - from)));
    const w = Math.min(0.45, CLIMB_PX / (Math.hypot(q.x - p.x, q.y - p.y) || 1));
    const up = q.z > p.z;
    const t0 = up ? tEdge - w : tEdge;
    const k = Math.max(0, Math.min(1, (t - t0) / w));
    z = p.z + (q.z - p.z) * smooth(k);
  }
  return { x, y, z };
}

/** "north-west", "central", "east" ... where a tile sits on the map, for notice lines. */
export function compass(map, tileId) {
  const x = tileId % map.width;
  const y = Math.floor(tileId / map.width);
  const ns = y < map.height / 3 ? 'north' : y >= (map.height * 2) / 3 ? 'south' : '';
  const we = x < map.width / 3 ? 'west' : x >= (map.width * 2) / 3 ? 'east' : '';
  return ns && we ? `${ns}-${we}` : ns || we || 'central';
}
