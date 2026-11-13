/**
 * Warfront client: the per-snapshot orchestrator. renderBattle (wfState in playing) and
 * applyLive (every wfLive) call the renderers in a fixed order. Must NOT contain: drawing of
 * its own; nothing but index.js may import this file.
 */

import { S } from './store.js';
import { supplyEl, supplyRateEl, mineralsEl, armyEl, armyCapEl } from './dom.js';
import { buildWorld } from './world/build.js';
import { FACILITY_TYPES } from './constants.js';
import { syncClock } from './clock.js';
import { renderUnits } from './units.js';
import { renderOrders } from './orders.js';
import { renderFog } from './fog.js';
import { renderPickups, renderLighthouses, renderCastles } from './map-objects.js';
import { renderBuildHints } from './structures.js';
import { lookAt } from './camera.js';
import { playEffects, marchDust } from './fx.js';
import { playAttacks } from './attacks.js';
import { renderHp, tickClock, renderStrip } from './hud.js';
import { renderInfo, renderSys } from './console/selection.js';
import { buildCards, renderCards } from './console/cards.js';
import { renderBuildCards } from './console/build.js';

export function renderBattle(data) {
  const fresh = S.builtFor !== data.clock.startedAt;
  if (fresh) {
    S.selected.clear();
    S.mode = 'move';
    S.buildMode = null;
    S.selStructure = null;
    S.selBase = false;
    S.tab = 'produce';
    S.inspect = null;
    buildWorld(data);
    S.builtFor = data.clock.startedAt;
  }
  buildCards(data);
  clearInterval(S.clockTimer);
  S.clockTimer = setInterval(tickClock, 1000);
  S.stripSeen = null;
  applyLive(data);

  S.ctx.showScreen('warfront');
  if (fresh) {
    // Start the camera on your own castle (needs the screen laid out first).
    requestAnimationFrame(() => {
      const home = data.map.bases.find((b) => b.team === (data.myTeam || 'red'));
      lookAt(data.map, home ? home.tileId : 0);
    });
  }
}

/** One fogged snapshot (from wfState, then every wfLive tick). */
export function applyLive(view) {
  if (!S.state || S.state.phase !== 'playing' || !view || !view.units) return;
  if (view.serverNow) syncClock(view.serverNow);
  S.live = view;
  // Drop selected units that are gone (dead, or no longer mine).
  const mine = new Set(view.units.filter((u) => u.owner === S.state.you).map((u) => u.id));
  [...S.selected].forEach((id) => {
    if (!mine.has(id)) S.selected.delete(id);
  });
  const seen = view.units.some((u) => u.team !== S.state.myTeam);
  if (seen !== S.stripSeen) {
    S.stripSeen = seen;
    renderStrip(S.state);
  }
  renderFog();
  renderPickups();
  renderLighthouses();
  renderUnits();
  renderOrders();
  renderHp('red', view.bases.red);
  renderHp('blue', view.bases.blue);
  renderCastles(view.bases);
  if (view.events && view.events.length) {
    // Cosmetic only: a bug in the strike animations must never stop the rest of the update.
    try {
      playAttacks(view.events);
    } catch (err) {
      console.error('Warfront attack animation failed:', err);
    }
    playEffects(view.events);
  }
  marchDust();
  tickClock();
  renderInfo();
  renderSys();
  if (view.me) {
    supplyEl.textContent = Math.floor(view.me.supply);
    supplyRateEl.textContent = `+${(Math.round(view.me.supplyRate * 10) / 10).toFixed(1)}/s`;
    mineralsEl.textContent = Math.floor(view.me.minerals);
    // Soldiers on the field (not buildings, not ones still training); amber once the cap is
    // used up, since training units and buildings count toward it too (engine unitSlotsUsed).
    armyEl.textContent = view.units.filter((u) => u.owner === S.state.you && !FACILITY_TYPES.has(u.type)).length;
    armyCapEl.textContent = `/${view.me.unitCap}`;
    armyEl.parentNode.classList.toggle('wf-army-full', view.me.units >= view.me.unitCap);
  } else {
    supplyEl.textContent = '–';
    supplyRateEl.textContent = '';
    mineralsEl.textContent = '–';
    armyEl.textContent = '–';
    armyCapEl.textContent = '';
  }
  renderCards();
  renderBuildCards();
  if (S.buildMode) renderBuildHints();
}
