/**
 * Warfront client: one-shot combat effects played from snapshot events (damage numbers,
 * losses, booms, bolts, sparks, march dust) and the private "Under attack" alert.
 * Must NOT contain: persistent map objects. Mockup: 3-resolution.html. Spec: "Under attack".
 */

import { S } from './store.js';
import { sfx, haptics, haptic } from '../../fx.js';
import { el, feed } from './util.js';
import { hpSegEl, minimap, alertEl, alertText } from './dom.js';
import { tileCentre, ent, billboard, standPoint, compass } from './world/geometry.js';
import { FACILITY_NAMES, WEAPON_NAMES, UNIT_NAMES } from './constants.js';

// ---------- Live combat effects (3-resolution.html, played once on the map) ----------

const FX_LIFE = { dmg: 1400, loss: 1600, boom: 1100, spark: 800, bolt: 450, dust: 1600 };
// Types whose own projectile attacks.js flies; anything else ranged gets the plain beam.
const OWN_SHOTS = new Set(['crossbow', 'ballista', 'skirmisher', 'apprentice', 'mysticArcher', 'summoner', 'archmage']);
const ARCANE_TYPES = new Set(['acolyte', 'apprentice', 'mysticArcher', 'battlemage', 'summoner', 'archmage', 'golem']);

/** A one-shot billboard on the fx layer at a tile's stand point, removed after `life` ms. */
function fxBoard(tileId, html, { w = 120, h = 120, dy = 0, z = 0, life = 1400, team = null } = {}) {
  if (!S.fxLayer) return null;
  const { map } = S.state;
  const p = standPoint(map, tileId, team || 'red', false);
  const node = ent(p.x, p.y + dy, p.z + z);
  const bb = billboard(html, w, h);
  bb.style.setProperty('--life', `${life}ms`);
  node.appendChild(bb);
  S.fxLayer.appendChild(node);
  setTimeout(() => node.remove(), life);
  return node;
}

const fmtDmg = (n) => `−${n >= 3 ? Math.round(n) : Math.max(0.1, n).toFixed(1).replace(/\.0$/, '')}`;

/** A bolt lying on the ground plane from the shooter to its target (frame 2's .bolt). */
function fxBolt(fromTileId, toTileId, arcane) {
  const { map } = S.state;
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
  S.fxLayer.appendChild(bolt);
  setTimeout(() => bolt.remove(), FX_LIFE.bolt);
}

const SPARKS = [20, 80, 140, -40, -100, 200]
  .map((r, i) => `<span class="spk" style="top: 50px; transform: rotate(${r}deg)"><i style="animation-delay: -${(i % 3) * 0.1}s"></i></span>`)
  .join('');

/** Turns one snapshot's events into on-map effects. Hits are summed per tile so a big fight stays readable. */
export function playEffects(events) {
  if (!S.fxLayer || !S.state || !S.state.map) return;
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
        shots.set(`${e.fromTileId}>${e.tileId}`, { from: e.fromTileId, to: e.tileId, ranged: e.ranged, arcane: ARCANE_TYPES.has(e.by), by: e.by });
      }
    } else if (e.type === 'deposit' && e.owner === S.state.you) {
      gains.set(e.tileId, (gains.get(e.tileId) || 0) + e.minerals);
    } else if (e.type === 'spawn' && e.owner === S.state.you) {
      feed(`${UNIT_NAMES[e.unitType] || 'Unit'} ready`);
    } else if (e.type === 'built' && e.owner === S.state.you) {
      feed(`${FACILITY_NAMES[e.unitType] || 'Building'} ready`);
      haptics.success();
    } else if (e.type === 'crafted' && e.owner === S.state.you) {
      feed(`${WEAPON_NAMES[e.weaponId] || 'Weapon'} ready · in your arsenal`);
      haptics.success();
    } else if (e.type === 'lighthouse') {
      // A flip: a flash of the new colour round the lamp, and a notice line.
      fxBoard(e.tileId, `<span class="wf-lflash wf-lf-${e.team}"></span>`, { w: 140, h: 140, dy: -10, z: 30, life: FX_LIFE.boom, team: e.team });
      const who = e.team === 'red' ? 'Red' : 'Blue';
      feed(`${who} took the ${compass(S.state.map, e.tileId)} lighthouse`, e.team);
      if (e.team === S.state.myTeam) haptics.success();
    } else if (e.type === 'death') {
      const k = `${e.tileId}|${e.team}`;
      const l = losses.get(k) || { tileId: e.tileId, team: e.team, n: 0 };
      l.n++;
      losses.set(k, l);
    }
  });
  shots.forEach((s) => {
    if (s.ranged) {
      if (!OWN_SHOTS.has(s.by)) fxBolt(s.from, s.to, s.arcane);
    }
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
    const prev = S.gainNodes.get(tileId);
    if (prev && prev.node.isConnected) {
      prev.total += n;
      prev.node.querySelector('.wf-gain').textContent = `+${Math.round(prev.total)}💎`;
      return;
    }
    const node = fxBoard(tileId, `<span class="dmg wf-gain" style="left: 34px; top: 0">+${Math.round(n)}💎</span>`, { w: 110, h: 120, dy: -40, z: 24, life: FX_LIFE.dmg, team: S.state.myTeam });
    if (node) S.gainNodes.set(tileId, { node, total: n });
  });
  losses.forEach((l) => {
    fxBoard(l.tileId, `<span class="boom" style="left: 20px; top: 40px; width: 70px; height: 70px"></span><span class="loss c-${l.team}" style="left: 38px; top: -26px">−${l.n}</span>`,
      { w: 110, h: 120, z: 30, life: FX_LIFE.loss, team: l.team });
  });
}

/** Frame 1's dust: a puff behind every stack that sets off on a new step. */
export function marchDust() {
  if (!S.fxLayer) return;
  const live2 = new Set();
  S.stackNodes.forEach((entry, key) => {
    const g = entry.group;
    if (g.next == null) return;
    live2.add(key);
    if (S.stepSeen.get(key) === g.stepStartedAt) return;
    S.stepSeen.set(key, g.stepStartedAt);
    fxBoard(g.tileId, '<span class="smoke dust"><span></span><span></span><span></span></span>', { w: 30, h: 10, life: FX_LIFE.dust, team: g.team });
  });
  [...S.stepSeen.keys()].forEach((k) => {
    if (!live2.has(k)) S.stepSeen.delete(k);
  });
}

// ---------- Under attack (private alert from the server) ----------

export function onAlert({ tileId, base }) {
  if (!S.state || S.state.phase !== 'playing' || !S.state.map) return;
  S.alertTile = tileId;
  alertText.textContent = base ? '▲ BASE UNDER ATTACK' : '▲ UNDER ATTACK';
  alertEl.classList.remove('hidden');
  clearTimeout(S.alertTimer);
  S.alertTimer = setTimeout(() => alertEl.classList.add('hidden'), 4000);
  haptic([120, 60, 120]);
  sfx.error();
  // The mockup's amber ping on the tile, and a blinking marker on the minimap.
  fxBoard(tileId, '<span class="ping" style="display: block"></span>', { w: 30, h: 30, z: 8, life: 3000 });
  if (minimap) {
    const c = tileCentre(S.state.map, tileId);
    const m = el('span', 'wf-mping');
    Object.assign(m.style, { left: `${c.x / 10}px`, top: `${c.y / 10}px` });
    minimap.appendChild(m);
    setTimeout(() => m.remove(), 3000);
  }
}
