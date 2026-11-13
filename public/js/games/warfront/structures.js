/**
 * Warfront client: facilities and towers on the field (Step 9) and build-mode hints
 * (the tiles you may build on). Must NOT contain: the Build tab cards (console/build.js).
 * Spec: "Facilities"; plan Step 9 / D17; mockup 2c-command-cards.html structure frames.
 */

import { S } from './store.js';
import { FACILITY_SPRITES } from './sprites.js';
import { el } from './util.js';
import { tileCentre, elevationAt, ent, billboard } from './world/geometry.js';
import { serverNow } from './clock.js';
import { FACILITY_TYPES, UNIT_MAX_HP } from './constants.js';

// ---------- Facilities and towers on the field (Step 9) ----------

/** How long a facility takes to build (from the Build catalog), for a site's progress bar. */
function facilityBuildMs(type) {
  const c = ((S.state && S.state.buildCatalog) || []).find((f) => f.facility === type);
  return c ? c.buildMs : 0;
}

/**
 * One billboard per facility or tower in view: the mockup's building (or the new
 * Refinery) in its owner's colour, pale behind scaffolding with a build bar while it is a
 * construction site, an HP bar once it's been hit, and a green ring when you've picked it.
 */
export function renderStructures() {
  if (!S.structLayer || !S.live || !S.state) return;
  const { map } = S.state;
  const now = serverNow();
  const seen = new Set();
  S.structureTiles = new Set();
  S.live.units.forEach((u) => {
    if (!FACILITY_TYPES.has(u.type)) return;
    seen.add(u.id);
    S.structureTiles.add(u.tileId);
    const art = FACILITY_SPRITES[u.type];
    let entry = S.structNodes.get(u.id);
    if (!entry) {
      const c = tileCentre(map, u.tileId);
      const node = ent(c.x, c.y + 4, elevationAt(map, u.tileId), `tm-${u.team}`);
      const shadow = el('span', 'dec tshadow');
      Object.assign(shadow.style, { width: `${Math.round(art.w * 1.05)}px`, height: `${Math.round(art.w * 0.45)}px` });
      node.appendChild(shadow);
      const bb = billboard(art.svg, art.w, art.h);
      if (art.extra) bb.insertAdjacentHTML('afterbegin', art.extra);
      node.appendChild(bb);
      S.structLayer.appendChild(node);
      entry = { node, bb, sig: '' };
      S.structNodes.set(u.id, entry);
    }
    const site = Boolean(u.buildDoneAt);
    const pct = Math.max(0, Math.min(100, Math.round((u.hp / (UNIT_MAX_HP[u.type] || u.hp)) * 100)));
    const picked = S.selStructure === u.id;
    const off = Boolean(u.disabledUntil && u.disabledUntil > now); // switched off by an EMP (Step 10)
    const sig = `${site ? 1 : 0}|${pct}|${picked ? 1 : 0}|${off ? 1 : 0}`;
    if (sig !== entry.sig) {
      entry.sig = sig;
      const { node, bb } = entry;
      bb.classList.toggle('wf-site', site);
      bb.classList.toggle('wf-emp', off);
      // Smoke only rises from a working smithy.
      bb.querySelectorAll(':scope > .smoke').forEach((sm) => sm.classList.toggle('hidden', site));
      let hpb = bb.querySelector(':scope > .hpb');
      if (pct < 100) {
        if (!hpb) {
          hpb = el('span', 'hpb', '<span></span>');
          bb.appendChild(hpb);
        }
        hpb.firstChild.className = pct >= 75 ? 'hp-g' : pct >= 35 ? 'hp-y' : 'hp-r';
        hpb.firstChild.style.width = `${pct}%`;
      } else if (hpb) hpb.remove();
      let bar = bb.querySelector(':scope > .wf-sbar');
      if (site && !bar) bb.appendChild(el('span', 'wf-sbar', '<span style="width: 0%"></span>'));
      if (!site && bar) bar.remove();
      let ring = node.querySelector(':scope > .selr');
      if (picked && !ring) {
        ring = el('span', 'dec selr');
        const rh = Math.round(art.w * 0.5);
        Object.assign(ring.style, { width: `${art.w}px`, height: `${rh}px`, margin: `${-Math.round(rh / 2)}px 0 0 ${-Math.round(art.w / 2)}px` });
        node.insertBefore(ring, bb);
      }
      if (!picked && ring) ring.remove();
    }
    if (site) {
      const total = facilityBuildMs(u.type);
      const p = total ? Math.max(0, Math.min(1, 1 - (u.buildDoneAt - now) / total)) : 0;
      const fill = entry.bb.querySelector(':scope > .wf-sbar > span');
      if (fill) fill.style.width = `${Math.round(p * 100)}%`;
    }
  });
  S.structNodes.forEach((entry, id) => {
    if (!seen.has(id)) {
      entry.node.remove();
      S.structNodes.delete(id);
    }
  });
  if (S.selStructure != null && !seen.has(S.selStructure)) S.selStructure = null;
  renderBaseRing();
}

/** Your picked base gets the same green ring as a picked building, sized to the castle. */
function renderBaseRing() {
  const team = S.state && S.state.myTeam;
  const bb = team && S.castleBoards[team];
  const node = bb && bb.parentNode;
  if (!node) return;
  let ring = node.querySelector(':scope > .selr');
  if (S.selBase && !ring) {
    const w = 130; // the castle billboard's width (world/build.js)
    const h = Math.round(w * 0.5);
    ring = el('span', 'dec selr');
    Object.assign(ring.style, { width: `${w}px`, height: `${h}px`, margin: `${-Math.round(h / 2)}px 0 0 ${-Math.round(w / 2)}px` });
    node.insertBefore(ring, bb);
  }
  if (!S.selBase && ring) ring.remove();
}

/**
 * Build mode: a dashed green square on every tile you may build the armed facility on
 * (the server's rule, D4: in your team's sight, passable, not a base, no enemy and no
 * structure there; a Refinery on or beside a vein). The server has the last word.
 */
export function renderBuildHints() {
  if (!S.hintLayer) return;
  S.hintLayer.innerHTML = '';
  if (S.fireMode) {
    renderFireHints();
    return;
  }
  if (!S.buildMode || !S.live || !S.state || !S.state.map) return;
  const { map } = S.state;
  const vis = S.live.visible || '';
  const blocked = new Set(map.bases.map((b) => b.tileId));
  S.live.units.forEach((u) => {
    if (u.team !== S.state.myTeam || FACILITY_TYPES.has(u.type) || u.type === 'bastion' || u.type === 'golem') blocked.add(u.tileId);
  });
  const nearVein = (id) => map.veins.some((v) => Math.abs((v.tileId % map.width) - (id % map.width))
    + Math.abs(Math.floor(v.tileId / map.width) - Math.floor(id / map.width)) <= 1);
  map.tiles.forEach((t, id) => {
    if (vis[id] !== '1' || t === 'water' || t === 'rock' || blocked.has(id)) return;
    if (S.buildMode === 'refinery' && !nearVein(id)) return;
    const c = tileCentre(map, id);
    const hint = el('span', 'wf-bhint');
    Object.assign(hint.style, { left: `${c.x}px`, top: `${c.y}px`, transform: `translateZ(${elevationAt(map, id) + 2}px)` });
    S.hintLayer.appendChild(hint);
  });
}

/**
 * Firing mode (Step 10): where the armed weapon may land. Airdrop: every passable tile your team
 * sees (green); EMP: enemy buildings in sight; Bombard / Aegis: the enemy / your base (red ring
 * for a strike, gold for the shield). Artillery may land anywhere, so it marks nothing.
 */
function renderFireHints() {
  if (!S.live || !S.state || !S.state.map) return;
  const { map, myTeam } = S.state;
  const vis = S.live.visible || '';
  const mark = (id, kind) => {
    const c = tileCentre(map, id);
    const hint = el('span', `wf-bhint wf-fhint ${kind}`);
    Object.assign(hint.style, { left: `${c.x}px`, top: `${c.y}px`, transform: `translateZ(${elevationAt(map, id) + 2}px)` });
    S.hintLayer.appendChild(hint);
  };
  const baseOf = (team) => (map.bases.find((b) => b.team === team) || {}).tileId;
  if (S.fireMode === 'airdrop') {
    map.tiles.forEach((t, id) => {
      if (vis[id] === '1' && t !== 'water' && t !== 'rock') mark(id, '');
    });
  } else if (S.fireMode === 'emp') {
    S.live.units.forEach((u) => {
      if (u.team !== myTeam && FACILITY_TYPES.has(u.type) && vis[u.tileId] === '1') mark(u.tileId, 'wf-fh-foe');
    });
  } else if (S.fireMode === 'bombard') {
    mark(baseOf(myTeam === 'red' ? 'blue' : 'red'), 'wf-fh-foe');
  } else if (S.fireMode === 'aegis') {
    mark(baseOf(myTeam), 'wf-fh-gold');
  }
}
