/**
 * Warfront client: the 1:10 minimap. Terrain, units, fog. Lighthouse markers are drawn by
 * map-objects.js. Must NOT contain: camera moves (camera.js). Mockup: 2-battlefield.html.
 */

import { S } from './store.js';
import { el } from './util.js';
import { TILE } from './constants.js';
import { minimap } from './dom.js';
import { tileCentre } from './world/geometry.js';

// ---------- Minimap (1:10, like the mockup) ----------

const MINI_COLOURS = { forest: '#1f3a18', hills: '#7a8a4a', water: '#16557a', rock: '#8b8c74' };

function miniRect(x, y, w, h, colour, radius = '0') {
  const r = el('span');
  Object.assign(r.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`, background: colour, borderRadius: radius });
  return r;
}

export function buildMinimap(map) {
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
  (map.supplyWalls || map.supplySources || []).forEach((w) => {
    const c = tileCentre(map, w.tileId);
    minimap.appendChild(miniRect(c.x / 10 - 1.5, c.y / 10 - 1.5, 3, 3, '#e8a33a'));
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
  S.miniFog = el('span');
  Object.assign(S.miniFog.style, { position: 'absolute', inset: '0' });
  minimap.appendChild(S.miniFog);
  S.miniUnits = el('span');
  Object.assign(S.miniUnits.style, { position: 'absolute', inset: '0' });
  minimap.appendChild(S.miniUnits);
  miniLights.forEach(([tileId, m]) => {
    minimap.appendChild(m);
    const entry = S.lighthouseNodes.get(tileId);
    if (entry) entry.mini = m;
  });
  S.miniView = el('span');
  Object.assign(S.miniView.style, { border: '1px solid #fff', boxShadow: '0 0 4px #fff', boxSizing: 'border-box' });
  minimap.appendChild(S.miniView);
}

export function renderMiniUnits() {
  if (!S.miniUnits || !S.live) return;
  S.miniUnits.innerHTML = '';
  const seen = new Set();
  S.live.units.forEach((u) => {
    const key = `${u.tileId}:${u.team}`;
    if (seen.has(key)) return;
    seen.add(key);
    const c = tileCentre(S.state.map, u.tileId);
    S.miniUnits.appendChild(miniRect(c.x / 10 - 2, c.y / 10 + 1, 4, 4, u.team === 'red' ? '#ff5a5f' : '#4f93ff', '50%'));
  });
}

/** Fogged tiles darken on the minimap too (the mockup's dark edge over unseen ground). */
export function renderMiniFog(vis) {
  if (!S.miniFog) return;
  S.miniFog.innerHTML = '';
  const { map } = S.state;
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
      S.miniFog.appendChild(miniRect(x0 * s2, y * s2, (x - x0) * s2, s2, 'rgba(0,0,0,.6)'));
    }
  }
}
