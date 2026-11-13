/**
 * Warfront client: things on the map that are not units. Weapon tokens, dropped loads and
 * gains, lighthouses, castles (burning below half HP). Must NOT contain: facilities (structures.js).
 * Spec: "Lighthouses", "Hauling"; mockups 2-battlefield.html, 3-resolution.html.
 */

import { S } from './store.js';
import { DROP_SPRITE } from './sprites.js';
import { el } from './util.js';
import { tileCentre, elevationAt, ent, billboard } from './world/geometry.js';
import { serverNow } from './clock.js';

/** Weapon tokens disappear once someone walks over them; dropped loads come and go. */
export function renderPickups() {
  if (!S.live) return;
  const drops = S.live.pickups.mineralDrops || {};
  S.dropNodes.forEach((node, tileId) => {
    if (!drops[tileId]) {
      node.remove();
      S.dropNodes.delete(tileId);
    }
  });
  Object.keys(drops).forEach((key) => {
    const tileId = Number(key);
    if (S.dropNodes.has(tileId) || !S.unitLayer) return;
    const c = tileCentre(S.state.map, tileId);
    const node = ent(c.x + 14, c.y + 22, elevationAt(S.state.map, tileId));
    node.appendChild(el('span', 'dec wf-dropglow'));
    node.appendChild(billboard(DROP_SPRITE, 34, 22));
    S.unitLayer.parentNode.insertBefore(node, S.unitLayer);
    S.dropNodes.set(tileId, node);
  });
  const left = new Set(S.live.pickups.weapons.map((w) => w.tileId));
  S.pickupNodes.forEach((node, tileId) => {
    if (!left.has(tileId)) {
      node.remove();
      S.pickupNodes.delete(tileId);
      S.decor = S.decor.filter((d) => d.bb.parentNode !== node);
    }
  });
}

/** Lamp colours: every player sees who holds each lighthouse (static map feature). */
export function renderLighthouses() {
  if (!S.live || !S.live.lighthouses) return;
  S.live.lighthouses.forEach((l) => {
    const entry = S.lighthouseNodes.get(l.tileId);
    if (!entry || entry.team === l.team) return;
    entry.team = l.team;
    const cls = l.team ? `tm-${l.team}` : 'tm-none';
    entry.node.classList.remove('tm-red', 'tm-blue', 'tm-none');
    entry.node.classList.add(cls);
    if (entry.mini) entry.mini.className = `wf-mlh ${cls}`;
  });
}

const BURN = '<span class="wf-burn"><span class="flame" style="left: 107px; top: 35px"></span><span class="flame" style="left: 115px; top: 40px; animation-delay: -.2s; transform: scale(.8)"></span><span class="flame" style="left: 73px; top: 30px; animation-delay: -.1s"></span><span class="flame" style="left: 23px; top: 44px; animation-delay: -.25s; transform: scale(.7)"></span><span class="smoke" style="left: 86%; bottom: 92px"><span></span><span></span><span></span></span><span class="smoke" style="left: 58%; bottom: 98px"><span></span><span></span><span></span></span></span>';

/** Below half HP a castle burns like the siege frame's; under an Aegis (Step 10) a gold dome covers it. */
export function renderCastles(bases) {
  const now = serverNow();
  ['red', 'blue'].forEach((team) => {
    const bb = S.castleBoards[team];
    const base = bases[team];
    if (!bb || !base) return;
    const burning = base.hp > 0 && base.hp / base.maxHp < 0.5;
    const flames = bb.querySelector('.wf-burn');
    if (burning && !flames) bb.insertAdjacentHTML('beforeend', BURN);
    if (!burning && flames) flames.remove();
    const shielded = base.hp > 0 && base.shieldUntil > now;
    const dome = bb.querySelector(':scope > .wf-aegis');
    if (shielded && !dome) bb.insertAdjacentHTML('beforeend', '<span class="wf-aegis"></span>');
    if (!shielded && dome) dome.remove();
  });
}
