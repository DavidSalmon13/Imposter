/**
 * Warfront client: own orders on the ground. Dashed march lines and the destination marker.
 * Must NOT contain: sending orders (console/selection.js, input.js). Mockup: 2-battlefield.html.
 */

import { S } from './store.js';
import { el } from './util.js';
import { tileCentre, elevationAt } from './world/geometry.js';

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

export function renderOrders() {
  if (!S.orderLayer || !S.live || !S.state) return;
  const { map } = S.state;
  const lines = [];
  const dests = new Set();
  const seen = new Set();
  S.live.units.forEach((u) => {
    if (u.team !== S.state.myTeam || !u.path || !u.path.length) return;
    const mine = u.owner === S.state.you;
    const key = `${mine ? 1 : 0}|${u.tileId}|${u.path.join(',')}`;
    if (seen.has(key)) return;
    seen.add(key);
    lines.push({ mine, pts: corners(map, u.tileId, u.path) });
    if (mine) dests.add(u.path[u.path.length - 1]);
  });
  // Enemies in sight: only the step they're taking (the mockup's short .foe arrow).
  S.live.units.forEach((u) => {
    if (u.team === S.state.myTeam || u.nextTileId == null) return;
    const key = `foe|${u.tileId}|${u.nextTileId}`;
    if (seen.has(key)) return;
    seen.add(key);
    lines.push({ foe: true, pts: [{ id: u.tileId }, { id: u.nextTileId }] });
  });
  const sig = JSON.stringify(lines.map((l) => [l.mine, l.foe, l.pts.map((p) => p.id)]));
  if (sig !== S.ordersSig) {
    S.ordersSig = sig;
    S.orderLayer.querySelectorAll('.gline').forEach((n) => n.remove());
    lines.forEach(({ mine, foe, pts }) => {
      for (let i = 0; i < pts.length - 1; i++) {
        const a = tileCentre(map, pts[i].id);
        const b = tileCentre(map, pts[i + 1].id);
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
        const z = Math.max(elevationAt(map, pts[i].id), elevationAt(map, pts[i + 1].id)) + 2;
        const last = i === pts.length - 2;
        const kind = foe ? ' foe' : mine ? '' : ` ally wf-ally-${S.state.myTeam}`;
        const line = el('div', `gline${kind}${last ? '' : ' wf-noarrow'}`);
        Object.assign(line.style, {
          left: `${a.x}px`,
          top: `${a.y}px`,
          width: `${Math.max(0, len - (last ? (foe ? 30 : 18) : 0))}px`,
          transform: `translateZ(${z}px) rotate(${ang}deg)`,
        });
        S.orderLayer.appendChild(line);
      }
    });
  }
  // Destination markers are keyed so their pulse doesn't restart every tick.
  S.clickNodes.forEach((node, id) => {
    if (!dests.has(id)) {
      node.remove();
      S.clickNodes.delete(id);
    }
  });
  dests.forEach((id) => {
    if (S.clickNodes.has(id)) return;
    const c = tileCentre(map, id);
    const node = el('div', 'click');
    Object.assign(node.style, { left: `${c.x}px`, top: `${c.y}px`, transform: `translateZ(${elevationAt(map, id) + 2}px)` });
    S.orderLayer.appendChild(node);
    S.clickNodes.set(id, node);
  });
}
