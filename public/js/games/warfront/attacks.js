/**
 * Warfront client: per-unit attack animations. Every unit type has its own strike (the
 * figures in the attacking stack lunge, chop, recoil or cast toward their target), ranged
 * types fire their own projectile that flies to the target, and figures that get hit flash
 * and flinch. Driven by the underAttack/baseHit events in each snapshot.
 * Must NOT contain: damage numbers, deaths, alerts (fx.js); stack layout (units.js).
 */

import { S } from './store.js';
import { el } from './util.js';
import { tileCentre, standPoint } from './world/geometry.js';

/**
 * Each type's strike: the CSS animation (attacks.css `wf-atk-<anim>`), its length, and
 * for ranged types the projectile it fires (`wf-proj-<proj>`) and how long it flies.
 */
const STYLES = {
  // Workers: a pickaxe swing.
  laborer: { anim: 'pick', ms: 380 },
  peon: { anim: 'pick', ms: 380 },
  acolyte: { anim: 'pick', ms: 380 },
  // Forge
  militiaman: { anim: 'thrust', ms: 420 },
  crossbow: { anim: 'recoil', ms: 300, proj: 'bolt', fly: 200 },
  outrider: { anim: 'charge', ms: 520 },
  bastion: { anim: 'brace', ms: 380 },
  ballista: { anim: 'heavy', ms: 480, proj: 'spear', fly: 260 },
  // Horde
  warrior: { anim: 'chop', ms: 480 },
  skirmisher: { anim: 'throw', ms: 420, proj: 'javelin', fly: 320 },
  raider: { anim: 'hitrun', ms: 540 },
  berserker: { anim: 'frenzy', ms: 540 },
  warchief: { anim: 'slam', ms: 620, ring: 'shock' },
  // Arcane
  apprentice: { anim: 'cast', ms: 440, proj: 'orb', fly: 320 },
  mysticArcher: { anim: 'draw', ms: 460, proj: 'arrow', fly: 240 },
  battlemage: { anim: 'nova', ms: 580, ring: 'nova' },
  summoner: { anim: 'summon', ms: 520, proj: 'wisp', fly: 380 },
  archmage: { anim: 'arcana', ms: 640, proj: 'star', fly: 300 },
  golem: { anim: 'stomp', ms: 480 },
};
const HIT_MS = 300;

/** Live animations, so a stack rebuilt mid-strike (its HP changed) picks them back up. */
const live = new Map(); // "team|tileId|type" (or "|hit") -> { cls, start, ms, ax, ay }

const nowMs = () => performance.now();
const other = (team) => (team === 'red' ? 'blue' : 'red');

/** Unit vector from one tile to another in map pixels ({0,0} when they're the same tile). */
function dir(map, fromId, toId) {
  const a = tileCentre(map, fromId);
  const b = tileCentre(map, toId);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  return len < 1 ? { ax: 0, ay: 0 } : { ax: (b.x - a.x) / len, ay: (b.y - a.y) / len };
}

/** Plays (or resumes) `a` on one figure, offset so a resumed strike stays in step. */
function playOn(fig, a, now) {
  fig.classList.remove(fig.dataset.atk || '_');
  fig.style.setProperty('--ax', a.ax.toFixed(3));
  fig.style.setProperty('--ay', a.ay.toFixed(3));
  // Facing: which way a swing tips (towards the target, or the team's side when straight up/down).
  fig.style.setProperty('--as', a.ax > 0.2 ? '1' : a.ax < -0.2 ? '-1' : fig.classList.contains('flip') ? '-1' : '1');
  fig.style.animationDuration = `${a.ms}ms`;
  fig.style.animationDelay = `${Math.round(a.start - now)}ms`;
  void fig.offsetWidth; // restart the animation when the same class plays again
  fig.classList.add(a.cls);
  fig.dataset.atk = a.cls;
}

/** The figures of `team` standing on (or setting off from) `tileId`, optionally of one type. */
function figsAt(team, tileId, type) {
  const out = [];
  S.stackNodes.forEach((entry) => {
    const g = entry.group;
    if (!g || g.team !== team || g.tileId !== tileId) return;
    entry.node.querySelectorAll('.fig').forEach((f) => {
      if (!type || f.dataset.type === type) out.push(f);
    });
  });
  return out;
}

/** A projectile that flies from one tile to the other, then is removed. */
function shoot(map, fromId, toId, kind, fly, team) {
  if (!S.fxLayer) return;
  const a = standPoint(map, fromId, team, false);
  const b = standPoint(map, toId, other(team), false);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1) return;
  const ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  const lane = el('div', 'wf-shot');
  Object.assign(lane.style, {
    left: `${Math.round(a.x)}px`,
    top: `${Math.round(a.y)}px`,
    transform: `translateZ(${Math.round(Math.max(a.z, b.z) + 22)}px) rotate(${ang}deg)`,
  });
  const p = el('div', `wf-proj wf-proj-${kind}`);
  p.style.setProperty('--len', `${Math.round(len)}px`);
  p.style.animationDuration = `${fly}ms`;
  lane.appendChild(p);
  S.fxLayer.appendChild(lane);
  setTimeout(() => lane.remove(), fly + 60);
}

/** A ground ring at a tile (Warchief's slam shockwave, Battlemage's nova). */
function ring(map, tileId, kind, team, delay) {
  if (!S.fxLayer) return;
  const c = tileCentre(map, tileId);
  const node = el('div', `wf-ring wf-ring-${kind} c-${team}`);
  Object.assign(node.style, { left: `${c.x}px`, top: `${c.y}px`, animationDelay: `${delay}ms` });
  S.fxLayer.appendChild(node);
  setTimeout(() => node.remove(), delay + 700);
}

/**
 * Turns one snapshot's hit events into strikes, projectiles and flinches. Called after
 * renderUnits, so the stacks on the map are the ones the events refer to.
 */
export function playAttacks(events) {
  if (!S.state || !S.state.map) return;
  const { map } = S.state;
  const now = nowMs();
  const struck = new Set(); // one strike per attacker type and tile per snapshot (AoE hits many)
  events.forEach((e) => {
    if ((e.type !== 'underAttack' && e.type !== 'baseHit') || e.fromTileId == null) return;
    const style = STYLES[e.by];
    const team = other(e.team);
    const d = dir(map, e.fromTileId, e.tileId);
    let impact = 0;
    if (style) {
      const k = `${team}|${e.fromTileId}|${e.by}`;
      // Ranged strikes release at ~40% of the wind-up; the shot then flies.
      impact = style.proj ? Math.round(style.ms * 0.4) + style.fly : Math.round(style.ms * 0.5);
      if (!struck.has(`${k}>${e.tileId}`)) {
        struck.add(`${k}>${e.tileId}`);
        const a = { cls: `wf-atk wf-atk-${style.anim}`, start: now, ms: style.ms, ...d };
        live.set(k, a);
        figsAt(team, e.fromTileId, e.by).forEach((f) => playOn(f, a, now));
        if (style.proj) {
          const release = Math.round(style.ms * 0.4);
          setTimeout(() => S.state && shoot(map, e.fromTileId, e.tileId, style.proj, style.fly, team), release);
        }
        if (style.ring) ring(map, style.ring === 'shock' ? e.fromTileId : e.tileId, style.ring, team, impact);
      }
    }
    // The victims flinch away from the blow when it lands (bases have no figures).
    if (e.type === 'underAttack') {
      const hk = `${e.team}|${e.tileId}|hit`;
      const h = { cls: 'wf-hit', start: now + impact, ms: HIT_MS, ...d };
      live.set(hk, h);
      // A figure mid-strike keeps striking rather than flinching.
      figsAt(e.team, e.tileId).forEach((f) => {
        const own = live.get(`${e.team}|${e.tileId}|${f.dataset.type}`);
        if (!own || own.start + own.ms < now) playOn(f, h, now);
      });
    }
  });
  live.forEach((a, k) => {
    if (a.start + a.ms < now) live.delete(k);
  });
}

/** Re-applies a strike or flinch still in progress to a stack that was just rebuilt. */
export function resumeAttacks(node, g) {
  if (!live.size) return;
  const now = nowMs();
  node.querySelectorAll('.fig').forEach((f) => {
    const a = live.get(`${g.team}|${g.tileId}|${f.dataset.type}`);
    const h = live.get(`${g.team}|${g.tileId}|hit`);
    if (a && a.start + a.ms > now) playOn(f, a, now);
    else if (h && h.start + h.ms > now) playOn(f, h, now);
  });
}
