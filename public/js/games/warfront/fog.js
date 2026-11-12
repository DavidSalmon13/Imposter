/**
 * Warfront client: the fog of war. The haze sheet over unseen ground and lifting it where
 * the team can see. Hiding is decided by the server (fogged views); this only draws it.
 * Must NOT contain: visibility rules. Spec: "Fog of war".
 */

import { S } from './store.js';
import { renderMiniFog } from './minimap.js';

/**
 * A fog sheet: one blurred rect per tile of a cols×rows block starting at (x0, y0),
 * registered in fogRects so renderFog can lift it where the team can see. `onlyTile`
 * makes a single-rect sheet (a castle pad) for that tile.
 */
export function fogSheet(map, x0, y0, cols, rows, onlyTile) {
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
      S.fogRects[id].push(r);
    }
  }
  svg.appendChild(g);
  return svg;
}

// ---------- Fog of war ----------

export function renderFog() {
  if (!S.live || S.live.visible === S.lastVisible || !S.fogRects.length) return;
  const vis = S.live.visible;
  S.fogRects.forEach((rects, id) => rects.forEach((r) => r.setAttribute('class', vis[id] === '1' ? '' : 'on')));
  S.decor.forEach(({ tileId, bb }) => bb.classList.toggle('dim', vis[tileId] !== '1'));
  renderMiniFog(vis);
  S.lastVisible = vis;
}
