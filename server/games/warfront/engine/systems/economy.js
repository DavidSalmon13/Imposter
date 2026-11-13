'use strict';

// Warfront engine system: the Worker haul cycle for both resources (🔩 carved from the supply wall
// beside the base, 💎 loaded at a vein), haul orders, the Refinery bonus and the HUD income rate.
// May import layers 1–6 and systems/movement.js. Must NOT contain: unit production (production.js).
// Spec: "Economy", "Hauling".

const { TUNING } = require('../constants');
const { manhattan, supplyWallOf } = require('../grid');
const { MAX_UNITS_PER_COMMAND, builtFacilities, round3 } = require('../state');
const { headFor, nearestTile } = require('./movement');
const { rngFor } = require('../../../../lib/rng');

/**
 * Tiles where `army`'s haulers may unload a load of `kind`: 🔩 Supply only at its base; 💎 Minerals at
 * its base or any finished Refinery an EMP hasn't switched off.
 */
function depositTiles(state, army, now, kind = 'minerals') {
  const base = state.bases[army.team].tileId;
  if (kind === 'supply') return [base];
  return [base, ...builtFacilities(army, 'refinery', now).map((u) => u.tileId)];
}

/** What a haul target tile yields for `army`: 'minerals' (a vein), 'supply' (its own supply wall) or null. */
function haulKindAt(state, army, tileId) {
  if (state.map.veins.some((v) => v.tileId === tileId)) return 'minerals';
  if (supplyWallOf(state.map, army.team).some((w) => w.tileId === tileId)) return 'supply';
  return null;
}

/** How much a Worker carries of `kind` at most. */
function capFor(kind) {
  return kind === 'supply' ? TUNING.supplyCarryCap : TUNING.carryCap;
}

/** Puts `u` into the auto-haul loop on `targetTileId` (a vein or a supply-wall tile). Loaded with
 * anything already, it drops that off first. */
function startHaul(state, army, u, targetTileId, kind, now) {
  const loadKind = u.carryKind || 'minerals';
  const full = u.carrying > 0 && (loadKind !== kind || u.carrying >= capFor(kind));
  u.haul = { veinTileId: targetTileId, kind, stage: full ? 'toDeposit' : 'toVein', luck: 0 };
  if (full) headFor(state, army, u, nearestTile(state, u, depositTiles(state, army, now, loadKind)), now);
  else headFor(state, army, u, targetTileId, now);
}

/**
 * Haul: Workers enter the auto-haul loop on a vein (💎) or a tile of their own supply wall (🔩).
 * One already full (or loaded with the other resource) heads for a deposit first; the rest walk
 * to the target (a step in progress finishes first).
 */
function orderHaul(state, army, cmd, now) {
  const { workerIds, veinTileId } = cmd;
  if (!Array.isArray(workerIds) || !workerIds.length || workerIds.length > MAX_UNITS_PER_COMMAND) {
    return { ok: false, error: 'Pick some Workers first' };
  }
  const kind = haulKindAt(state, army, veinTileId);
  if (!kind) return { ok: false, error: 'Send Workers to a mineral vein or your supply wall' };
  const wanted = new Set(workerIds);
  const workers = army.units.filter((u) => wanted.has(u.id) && u.class === 'worker');
  if (!workers.length) return { ok: false, error: 'Only Workers can haul' };
  for (const u of workers) startHaul(state, army, u, veinTileId, kind, now);
  return { ok: true, hauling: workers.length };
}

/** 🔩 Supply per second `army` has been bringing home lately (what was deposited over incomeWindowMs). */
function supplyRate(state, army, now = state.clock.lastTickAt) {
  const since = now - TUNING.incomeWindowMs;
  const total = (army.supplyLog || []).reduce((sum, [at, amount]) => (at > since ? sum + amount : sum), 0);
  return total / (TUNING.incomeWindowMs / 1000);
}

/** Puts a fresh Worker to carving its team's supply wall (the wall tile nearest to it). */
function autoCarve(state, army, u, now) {
  const wall = supplyWallOf(state.map, army.team).map((w) => w.tileId);
  if (!wall.length || u.class !== 'worker') return;
  startHaul(state, army, u, nearestTile(state, u, wall), 'supply', now);
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

/** Loading rate (per second) for `u` working the haul target `h` of `army`. */
function loadRate(state, army, h, now) {
  if (h.kind === 'supply') return TUNING.supplyCarveSec * (1 + (army.race === 'forge' ? TUNING.forgeCarveBonus : 0));
  const vein = state.map.veins.find((v) => v.tileId === h.veinTileId);
  return TUNING.mineLoadSec * vein.richness * (1 + (h.luck || 0)) + refineryBonus(state, army, vein.tileId, now);
}

/**
 * Every hauler's loop: walk to the target, load there (a vein at mineLoadSec × richness, a contested
 * vein swinging ±veinLuckMagnitude rolled once per load; the supply wall at supplyCarveSec), carry the
 * load to the nearest deposit for its kind, unload, go back. There is no other income.
 */
function stepEconomy(state, dtMs, now, events) {
  const rng = rngFor((state.seed ^ 0x5bd1e995) >>> 0, state.tick); // its own stream, apart from combat's
  const secs = dtMs / 1000;
  for (const [owner, army] of Object.entries(state.armies)) {
    if (army.supplyLog) army.supplyLog = army.supplyLog.filter(([at]) => at > now - TUNING.incomeWindowMs);
    for (const u of army.units) {
      const h = u.haul;
      if (!h || u.hp <= 0) continue;
      const kind = h.kind || 'minerals'; // hauls saved before supply walls were all veins
      if (haulKindAt(state, army, h.veinTileId) !== kind) {
        u.haul = null;
        continue;
      }
      h.kind = kind;
      if (u.path.length) continue; // still walking this leg
      if (h.stage === 'toVein') {
        if (u.tileId !== h.veinTileId) {
          headFor(state, army, u, h.veinTileId, now);
          continue;
        }
        h.stage = 'loading';
        const vein = kind === 'minerals' && state.map.veins.find((v) => v.tileId === h.veinTileId);
        h.luck = vein && vein.contested ? (rng() * 2 - 1) * TUNING.veinLuckMagnitude : 0;
      }
      if (h.stage === 'loading') {
        const cap = capFor(kind);
        u.carryKind = kind;
        u.carrying = Math.min(cap, round3(u.carrying + loadRate(state, army, h, now) * secs));
        if (u.carrying < cap) continue;
        h.stage = 'toDeposit';
        headFor(state, army, u, nearestTile(state, u, depositTiles(state, army, now, kind)), now);
        continue;
      }
      if (h.stage === 'toDeposit') {
        const loadKind = u.carryKind || 'minerals';
        const deposits = depositTiles(state, army, now, loadKind);
        if (!deposits.includes(u.tileId)) {
          headFor(state, army, u, nearestTile(state, u, deposits), now);
          continue;
        }
        if (u.carrying > 0) {
          if (loadKind === 'supply') {
            army.supply = round3(army.supply + u.carrying);
            army.supplyLog = [...(army.supplyLog || []), [now, u.carrying]];
            events.push({ type: 'deposit', tileId: u.tileId, owner, team: army.team, unitId: u.id, supply: u.carrying });
          } else {
            army.minerals = round3(army.minerals + u.carrying);
            events.push({ type: 'deposit', tileId: u.tileId, owner, team: army.team, unitId: u.id, minerals: u.carrying });
          }
          u.carrying = 0;
        }
        h.stage = 'toVein';
        headFor(state, army, u, h.veinTileId, now);
      }
    }
  }
}

module.exports = {
  autoCarve,
  depositTiles,
  orderHaul,
  supplyRate,
  stepEconomy,
};
