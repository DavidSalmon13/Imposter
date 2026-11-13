/**
 * Warfront client: projectiles in flight and the impact they make. A shot is a small
 * camera-facing sprite that flies from the shooter to its target along a real 3D arc
 * (arrows and javelins lob, spells fly flatter), turning to follow its path. Spells leave
 * a glittering trail. When a shot lands it bursts on the target: sparks and dust for
 * arrows, bolts and spears, a coloured magic blast for orbs, wisps and stars.
 * Must NOT contain: deciding who shoots or when (attacks.js), damage numbers (fx.js).
 */

import { S } from './store.js';
import { el } from './util.js';
import { standPoint, roofPoint } from './world/geometry.js';

const TILT = (40 * Math.PI) / 180; // the world's rotateX (battlefield.css .world)
const COS = Math.cos(TILT);
const SIN = Math.sin(TILT);
// Sprites are drawn --lift (attacks.css) up their face, so paths run at the figures' feet:
// a face anchored at its foot never swings under the ground plane and gets cut in half.

// Sprites point right (+x), centred on the projectile's position.
const SPRITES = {
  arrow: `<svg width="42" height="12" viewBox="-36 -6 42 12">
    <line x1="-34" y1="0" x2="-2" y2="0" stroke="#e9d5ff" stroke-width="1.6"/>
    <path d="M-34 0 L-29 -4.5 L-25 -4.5 L-29 0 L-25 4.5 L-29 4.5 Z" fill="#c084fc"/>
    <path d="M-3 -3.6 L6 0 L-3 3.6 Z" fill="#faf5ff" stroke="#a855f7" stroke-width=".8"/></svg>`,
  bolt: `<svg width="28" height="10" viewBox="-22 -5 28 10">
    <line x1="-21" y1="0" x2="-1" y2="0" stroke="#8b5a2b" stroke-width="2.4"/>
    <path d="M-21 0 L-17 -3.5 L-15 -3.5 L-17 0 L-15 3.5 L-17 3.5 Z" fill="#e5e7eb"/>
    <path d="M-2 -3 L6 0 L-2 3 Z" fill="#cbd5e1" stroke="#475569" stroke-width=".7"/></svg>`,
  javelin: `<svg width="44" height="8" viewBox="-38 -4 44 8">
    <line x1="-37" y1="0" x2="-1" y2="0" stroke="#a16207" stroke-width="2"/>
    <path d="M-2 -2.8 L6 0 L-2 2.8 Z" fill="#e2e8f0" stroke="#64748b" stroke-width=".7"/></svg>`,
  spear: `<svg width="58" height="14" viewBox="-50 -7 58 14">
    <line x1="-49" y1="0" x2="-2" y2="0" stroke="#7c5a2e" stroke-width="4"/>
    <path d="M-49 0 L-42 -6 L-37 -6 L-41 0 L-37 6 L-42 6 Z" fill="#b91c1c"/>
    <path d="M-4 -5 L8 0 L-4 5 Z" fill="#e5e7eb" stroke="#334155" stroke-width="1"/></svg>`,
  orb: '<i class="wf-pj-orb"></i>',
  wisp: '<i class="wf-pj-wisp"></i>',
  star: '<i class="wf-pj-star"></i>',
};

/** How each shot flies: arc height as a share of its length, and its trail/impact colour. */
const KINDS = {
  arrow: { arc: 0.28, trail: '#c084fc', impact: 'arcane' },
  bolt: { arc: 0.12, impact: 'thunk' },
  javelin: { arc: 0.32, impact: 'thunk' },
  spear: { arc: 0.1, impact: 'heavy' },
  orb: { arc: 0.08, trail: '#d8b4fe', impact: 'arcane', spin: true },
  wisp: { arc: 0.16, trail: '#86efac', impact: 'spirit', wave: true },
  star: { arc: 0.14, trail: '#fde68a', impact: 'astral', spin: true },
};

const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const flying = new Set();
let raf = 0;

/** Fires one shot of `kind` from tile to tile (from a Tower's roof when `fromRoof`); it lands after `fly` ms. */
export function launch(map, fromId, toId, kind, fly, team, fromRoof = false, targetTeam = null) {
  if (!S.fxLayer || !SPRITES[kind]) return;
  const a = fromRoof ? roofPoint(map, fromId) : standPoint(map, fromId, team, false);
  const b = standPoint(map, toId, targetTeam || (team === 'red' ? 'blue' : 'red'), false);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1) return;
  const k = KINDS[kind];
  const node = el('div', 'ent wf-pj');
  const face = el('div', 'wf-pj-face');
  const spr = el('div', `wf-pj-s wf-pj-${kind}`, SPRITES[kind]);
  face.appendChild(spr);
  node.appendChild(face);
  S.fxLayer.appendChild(node);
  // Muzzle flare where a spell leaves the caster's hands.
  if (k.trail) burst(a.x, a.y, a.z, `wf-flare wf-imp-${k.impact}`, 260);
  flying.add({
    node, spr, k, kind, fly, team, map, toId,
    a: { x: a.x, y: a.y, z: a.z },
    b: { x: b.x, y: b.y, z: b.z },
    h: Math.min(90, len * k.arc), start: performance.now(), lastTrail: 0,
  });
  if (!raf) raf = requestAnimationFrame(frame);
}

/** Where a shot is at progress t (0..1): a straight line plus a parabolic lift. */
function at(p, t) {
  return {
    x: p.a.x + (p.b.x - p.a.x) * t,
    y: p.a.y + (p.b.y - p.a.y) * t,
    z: p.a.z + (p.b.z - p.a.z) * t + p.h * 4 * t * (1 - t),
  };
}

function frame(now) {
  raf = 0;
  if (!S.fxLayer || !S.fxLayer.isConnected) {
    flying.forEach((p) => p.node.remove());
    flying.clear();
    return;
  }
  const calm = reduced();
  flying.forEach((p) => {
    const t = Math.min(1, (now - p.start) / p.fly);
    const c = at(p, t);
    const n = at(p, Math.min(1, t + 0.02));
    const pv = t >= 0.98 ? at(p, t - 0.02) : c;
    // The path's direction on screen: world y and z both fold into screen y under the tilt.
    const dx = (t >= 0.98 ? c.x - pv.x : n.x - c.x);
    const dy = (t >= 0.98 ? c.y - pv.y : n.y - c.y) * COS - (t >= 0.98 ? c.z - pv.z : n.z - c.z) * SIN;
    let ang = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (p.k.wave) ang += Math.sin(t * 18) * 14;
    p.node.style.transform = `translate3d(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px, ${c.z.toFixed(1)}px)`;
    p.spr.style.transform = `translate(-50%, -50%) rotate(${ang.toFixed(1)}deg)`;
    if (p.k.trail && !calm && now - p.lastTrail > 28) {
      p.lastTrail = now;
      trail(c, p.k.trail);
    }
    if (t >= 1) {
      p.node.remove();
      flying.delete(p);
      impact(p);
    }
  });
  if (flying.size) raf = requestAnimationFrame(frame);
}

/** A glowing mote left behind a spell, fading where it was dropped. */
function trail(c, colour) {
  const node = el('div', 'ent wf-pj');
  node.style.transform = `translate3d(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px, ${c.z.toFixed(1)}px)`;
  const face = el('div', 'wf-pj-face');
  const mote = el('i', 'wf-mote');
  mote.style.setProperty('--c', colour);
  mote.style.setProperty('--dx', `${(Math.random() * 10 - 5).toFixed(1)}px`);
  mote.style.setProperty('--dy', `${(Math.random() * 8 - 2).toFixed(1)}px`);
  face.appendChild(mote);
  node.appendChild(face);
  S.fxLayer.appendChild(node);
  setTimeout(() => node.remove(), 420);
}

/** A one-shot burst billboard at a world point (impact or muzzle flare). */
function burst(x, y, z, cls, life, html = '') {
  if (!S.fxLayer) return;
  const node = el('div', 'ent wf-pj');
  node.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, ${z.toFixed(1)}px)`;
  const face = el('div', 'wf-pj-face');
  face.appendChild(el('div', `wf-imp ${cls}`, html));
  node.appendChild(face);
  S.fxLayer.appendChild(node);
  setTimeout(() => node.remove(), life);
}

// Sparks fan out over the upper half only: one that reaches below the ground line gets the
// whole burst culled inside the tilted 3D world.
const RAYS = (n) => Array.from({ length: n }, (_, i) =>
  `<b style="--r: ${Math.round(100 + (160 / (n - 1)) * i + Math.random() * 10 - 5)}deg; --d: ${Math.round(Math.random() * 60)}ms"></b>`).join('');

/** The shot lands: what it looks like depends on what was fired. */
function impact(p) {
  const { b, k } = p;
  const big = k.impact === 'astral' || k.impact === 'heavy';
  const html = `<span class="core"></span><span class="ring"></span>${RAYS(big ? 10 : 7)}`;
  burst(b.x, b.y, b.z, `wf-imp-${k.impact}`, big ? 800 : 700, html);
  // Physical shots kick up dust at the target's feet.
  if (!k.trail) burst(b.x, b.y + 2, b.z, 'wf-imp-dust', 600, '<span></span><span></span><span></span>');
}
