/**
 * Warfront client: unit stacks. One stack per tile and team, its sprite and labels, and
 * tweening between ticks using stepStartedAt/stepEndsAt. Must NOT contain: orders, structures.
 * Mockups: 2-battlefield.html squads, 2b-unit-roster.html.
 */

import { S } from './store.js';
import { UNIT_SPRITES, UNIT_ICONS, LOAD_SPRITE, SUPPLY_LOAD_SPRITE } from './sprites.js';
import { el } from './util.js';
import { FORMATIONS, FACILITY_TYPES, UNIT_MAX_HP } from './constants.js';
import { tileCentre, ent, standPoint, stepPoint, roofPoint } from './world/geometry.js';
import { serverNow } from './clock.js';
import { renderStructures } from './structures.js';
import { renderMiniUnits } from './minimap.js';
import { resumeAttacks } from './attacks.js';
import { makeupSig, hpSegments, hpSig, hpClass } from './stackSig.js';

// ---------- Units: one stack per tile and team, tweened between ticks ----------

/** The tile a unit is stepping onto (own units: path[0]; enemies: nextTileId), or null. */
function nextTileOf(u) {
  if (!u.stepEndsAt) return null;
  if (u.path && u.path.length) return u.path[0];
  return u.nextTileId != null ? u.nextTileId : null;
}

/** The tile after that (own units: path[1]; enemies: afterTileId when it's in sight), or null. */
function afterTileOf(u) {
  if (!u.stepEndsAt || !u.afterStepMs) return null;
  if (u.path && u.path.length > 1) return u.path[1];
  return u.afterTileId != null ? u.afterTileId : null;
}

/**
 * Groups units into stacks: everyone of one team standing on one tile, or walking the
 * same step together. Keyed by the lowest unit id, so a squad keeps its node while it walks.
 */
function groupUnits(units) {
  const byKey = new Map();
  units.forEach((u) => {
    const next = nextTileOf(u);
    // A Tower's garrison is its own stack, up on the roof.
    // A unit that turned round mid-step walks from `stepFrom` back onto its tile.
    const from = next != null && u.stepFrom != null ? u.stepFrom : u.tileId;
    const k = next == null ? `${u.team}|${u.tileId}${u.garrison ? '^' : ''}` : `${u.team}|${from}>${next}@${u.stepEndsAt}`;
    if (!byKey.has(k)) {
      const after = next == null ? null : afterTileOf(u);
      byKey.set(k, {
        team: u.team, tileId: u.tileId, from, next, garrison: next == null && Boolean(u.garrison), stepStartedAt: u.stepStartedAt, stepEndsAt: u.stepEndsAt,
        after, afterStepMs: after == null ? 0 : u.afterStepMs, units: [],
      });
    }
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
  const selected = g.units.some((u) => u.owner === you && S.selected.has(u.id));
  const loaded = g.units.some((u) => u.carrying > 0);
  return makeupSig(g.units, g.team, { selected, loaded });
}

/**
 * Paints a stack's HP bar in place: one segment per soldier (lowest first, up to 8), each
 * filled with a scaleX transform. Rebuilds the segment nodes only if their number changed.
 */
function paintHp(entry, g) {
  const segs = hpSegments(g.units, UNIT_MAX_HP);
  const sig = hpSig(segs);
  if (entry.hpSig === sig) return;
  entry.hpSig = sig;
  const bar = entry.node.querySelector('.hpb');
  if (!bar) return;
  if (bar.children.length !== segs.length) {
    bar.innerHTML = segs.map(() => '<i><b></b></i>').join('');
  }
  segs.forEach((f, i) => {
    const b = bar.children[i].firstChild;
    b.className = hpClass(f);
    b.style.transform = `scaleX(${f.toFixed(3)})`;
  });
}

/** Builds a stack's billboard (the mockup's squad: ring, figures, count chip, HP bar). */
function fillStack(node, g, you) {
  node.innerHTML = '';
  const counts = new Map();
  g.units.forEach((u) => counts.set(u.type, (counts.get(u.type) || 0) + 1));
  const types = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  const figTypes = [];
  for (let i = 0; figTypes.length < Math.min(g.units.length, 4); i++) figTypes.push(types[i % types.length]);
  const isSel = g.units.some((u) => u.owner === you && S.selected.has(u.id));
  const form = FORMATIONS[figTypes.length];

  node.appendChild(el('span', 'dec sqsh'));
  // Selected: the team ring gives way to a bright full-tile green ring, a green ring under
  // each figure and a ▼ over the stack (2-battlefield.html, plan Step 21).
  node.appendChild(el('span', `dec ${isSel ? 'selg' : `rg-${g.team}`}`));
  if (isSel) {
    form.forEach(([fx, fy]) => {
      const r = el('span', 'selr');
      r.style.left = `${fx - 21}px`;
      r.style.top = `${Math.round((fy - 22) * 0.9)}px`;
      node.appendChild(r);
    });
  }
  const bb = el('div', `bb sqbb tm-${g.team}`);
  if (isSel) bb.appendChild(el('span', 'selm'));
  bb.appendChild(el('span', 'hpb sqhp')); // segments painted by paintHp (plan Step 22)
  bb.appendChild(el('span', `chip c-${g.team}`)).textContent = `${UNIT_ICONS[types[0]] || '?'}×${g.units.length}`;
  form.forEach(([fx, fy], i) => {
    const fig = el('span', `fig d${i}${g.team !== 'red' ? ' flip' : ''}`);
    fig.dataset.type = figTypes[i];
    fig.style.left = `${fx}px`;
    fig.style.top = `${fy}px`;
    fig.appendChild(el('span', 'spw', (UNIT_SPRITES[figTypes[i]] || '').replace('<svg ', '<svg class="sp" ')));
    bb.appendChild(fig);
  });
  // A hauler with a load (yours, or an enemy's in sight) carries it over the squad: a 💎 crystal,
  // or an amber chunk of carved 🔩 Supply rock.
  const loaded = g.units.find((u) => u.carrying > 0);
  if (loaded) bb.appendChild(el('span', `wf-load${loaded.carryKind === 'supply' ? ' sup' : ''}`, loaded.carryKind === 'supply' ? SUPPLY_LOAD_SPRITE : LOAD_SPRITE));
  node.appendChild(bb);
  resumeAttacks(node, g);
}

/**
 * Positions one stack for the current moment: slides along its step and, once that
 * step is over but the next snapshot hasn't arrived yet, carries on into the step
 * after (the server sends its length), so walking never stalls at a tile edge.
 */
function placeStack(map, entry, now) {
  const g = entry.group;
  let p;
  if (g.next != null && g.stepEndsAt > g.stepStartedAt) {
    if (now > g.stepEndsAt && g.after != null && g.afterStepMs > 0) {
      const t = Math.min(1, (now - g.stepEndsAt) / g.afterStepMs);
      p = stepPoint(map, g.team, g.next, g.after, t);
    } else {
      const t = Math.max(0, Math.min(1, (now - g.stepStartedAt) / (g.stepEndsAt - g.stepStartedAt)));
      p = stepPoint(map, g.team, g.from, g.next, t);
    }
  } else if (g.garrison) {
    p = roofPoint(map, g.tileId);
  } else {
    p = standPoint(map, g.tileId, g.team, entry.shared);
  }
  // One composited transform (no left/top layout, no whole-pixel rounding) so the
  // slide is smooth sub-pixel motion on the GPU.
  const { node } = entry;
  if (node.style.left !== '0px') {
    node.style.left = '0px';
    node.style.top = '0px';
  }
  node.style.transform = `translate3d(${p.x.toFixed(2)}px, ${p.y.toFixed(2)}px, ${p.z.toFixed(2)}px)`;
}

export function renderUnits() {
  if (!S.unitLayer || !S.live || !S.state) return;
  const { map } = S.state;
  const you = S.state.you;
  renderStructures();
  const groups = groupUnits(S.live.units.filter((u) => !FACILITY_TYPES.has(u.type)));
  const still = new Set();
  groups.forEach((g) => {
    if (g.next == null && !g.garrison) still.add(`${g.team}|${g.tileId}`);
  });
  S.stackNodes.forEach((entry, key) => {
    if (!groups.has(key)) {
      entry.node.remove();
      S.stackNodes.delete(key);
    }
  });
  const fresh = [];
  groups.forEach((g, key) => {
    let entry = S.stackNodes.get(key);
    if (!entry) {
      entry = { node: ent(0, 0, 0), sig: '' };
      S.stackNodes.set(key, entry);
      fresh.push({ y: tileCentre(map, g.tileId).y, node: entry.node });
    }
    entry.group = g;
    entry.shared = g.next == null && !g.garrison && still.has(`${g.team === 'red' ? 'blue' : 'red'}|${g.tileId}`);
    const sig = `${stackSig(g, you)}|${entry.shared ? 1 : 0}`;
    if (sig !== entry.sig) {
      fillStack(entry.node, g, you);
      entry.sig = sig;
      entry.hpSig = null;
    }
    paintHp(entry, g);
    placeStack(map, entry, serverNow());
  });
  fresh.sort((a, b) => a.y - b.y).forEach((f) => S.unitLayer.appendChild(f.node));
  renderMiniUnits();
  startTween();
}

/** Slides walking stacks every frame between the 5 Hz snapshots. */
function startTween() {
  if (S.rafId) return;
  const frame = () => {
    S.rafId = null;
    if (!S.state || S.state.phase !== 'playing' || !S.live) return;
    let moving = false;
    const now = serverNow();
    S.stackNodes.forEach((entry) => {
      if (entry.group.next != null) {
        placeStack(S.state.map, entry, now);
        moving = true;
      }
    });
    if (moving) S.rafId = requestAnimationFrame(frame);
  };
  S.rafId = requestAnimationFrame(frame);
}
