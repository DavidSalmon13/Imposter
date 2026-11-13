'use strict';

// Warfront engine system: Supply income, Refinery bonus, haul orders and the Worker haul cycle.
// May import layers 1–6 and systems/movement.js. Must NOT contain: unit production (production.js).
// Spec: "Economy", "Hauling".

const { TUNING } = require('../constants');
const { manhattan } = require('../grid');
const { MAX_UNITS_PER_COMMAND, builtFacilities, round3 } = require('../state');
const { headFor, nearestTile } = require('./movement');
const { rngFor } = require('../../../../lib/rng');

/** Tiles where `army`'s haulers may unload: its base, then every finished Refinery an EMP hasn't switched off. */
function depositTiles(state, army, now) {
  return [state.bases[army.team].tileId, ...builtFacilities(army, 'refinery', now).map((u) => u.tileId)];
}

/**
 * Haul: Workers enter the auto-haul loop on a vein. One already loaded heads
 * straight for a deposit; the rest walk to the vein (a step in progress finishes first).
 */
function orderHaul(state, army, cmd, now) {
  const { workerIds, veinTileId } = cmd;
  if (!Array.isArray(workerIds) || !workerIds.length || workerIds.length > MAX_UNITS_PER_COMMAND) {
    return { ok: false, error: 'Pick some Workers first' };
  }
  if (!state.map.veins.some((v) => v.tileId === veinTileId)) return { ok: false, error: 'Haul from a mineral vein' };
  const wanted = new Set(workerIds);
  const workers = army.units.filter((u) => wanted.has(u.id) && u.class === 'worker');
  if (!workers.length) return { ok: false, error: 'Only Workers can haul' };
  for (const u of workers) {
    if (u.carrying >= TUNING.carryCap) {
      u.haul = { veinTileId, stage: 'toDeposit', luck: 0 };
      headFor(state, army, u, nearestTile(state, u, depositTiles(state, army, now)), now);
    } else {
      u.haul = { veinTileId, stage: 'toVein', luck: 0 };
      headFor(state, army, u, veinTileId, now);
    }
  }
  return { ok: true, hauling: workers.length };
}

/** 🔩 Supply per second for one army: trickle + Workers on/beside a friendly supply source (+Forge bonus). */
function supplyRate(state, army) {
  const { width } = state.map;
  const sources = state.map.supplySources.filter((s) => s.team === army.team).map((s) => s.tileId);
  let rate = TUNING.baseTrickleSec;
  if (!sources.length) return rate;
  const perWorker = TUNING.supplyPerWorkerSec + (army.race === 'forge' ? TUNING.forgeWorkerBonusSec : 0);
  for (const u of army.units) {
    if (u.class === 'worker' && sources.some((s) => manhattan(s, u.tileId, width) <= 1)) rate += perWorker;
  }
  return rate;
}

/**
 * Extra 💎/sec `army`'s Workers load on a vein (D17): refineryVeinBonus when the
 * army has a finished Refinery on or beside it. Several Refineries don't stack,
 * and an enemy's Refinery gives nothing.
 */
function refineryBonus(state, army, veinTileId, now) {
  const { width } = state.map;
  return builtFacilities(army, 'refinery', now).some((r) => manhattan(r.tileId, veinTileId, width) <= 1) ? TUNING.refineryVeinBonus : 0;
}

/**
 * Supply accrual, then every hauler's loop: walk to the vein, load at
 * mineLoadSec × richness (a contested vein swings ±veinLuckMagnitude, rolled once
 * per load), carry carryCap to the nearest deposit, unload, go back.
 */
function stepEconomy(state, dtMs, now, events) {
  const rng = rngFor((state.seed ^ 0x5bd1e995) >>> 0, state.tick); // its own stream, apart from combat's
  const secs = dtMs / 1000;
  for (const [owner, army] of Object.entries(state.armies)) {
    army.supply = round3(army.supply + supplyRate(state, army) * secs);
    for (const u of army.units) {
      const h = u.haul;
      if (!h || u.hp <= 0) continue;
      const vein = state.map.veins.find((v) => v.tileId === h.veinTileId);
      if (!vein) {
        u.haul = null;
        continue;
      }
      if (u.path.length) continue; // still walking this leg
      if (h.stage === 'toVein') {
        if (u.tileId !== vein.tileId) {
          headFor(state, army, u, vein.tileId, now);
          continue;
        }
        h.stage = 'loading';
        h.luck = vein.contested ? (rng() * 2 - 1) * TUNING.veinLuckMagnitude : 0;
      }
      if (h.stage === 'loading') {
        const rate = TUNING.mineLoadSec * vein.richness * (1 + (h.luck || 0)) + refineryBonus(state, army, vein.tileId, now);
        u.carrying = Math.min(TUNING.carryCap, round3(u.carrying + rate * secs));
        if (u.carrying < TUNING.carryCap) continue;
        h.stage = 'toDeposit';
        headFor(state, army, u, nearestTile(state, u, depositTiles(state, army, now)), now);
        continue;
      }
      if (h.stage === 'toDeposit') {
        const deposits = depositTiles(state, army, now);
        if (!deposits.includes(u.tileId)) {
          headFor(state, army, u, nearestTile(state, u, deposits), now);
          continue;
        }
        if (u.carrying > 0) {
          army.minerals = round3(army.minerals + u.carrying);
          events.push({ type: 'deposit', tileId: u.tileId, owner, team: army.team, unitId: u.id, minerals: u.carrying });
          u.carrying = 0;
        }
        h.stage = 'toVein';
        headFor(state, army, u, vein.tileId, now);
      }
    }
  }
}

module.exports = {
  depositTiles,
  orderHaul,
  supplyRate,
  stepEconomy,
};
