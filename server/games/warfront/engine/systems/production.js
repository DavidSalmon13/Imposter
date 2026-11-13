'use strict';

// Warfront engine system: spawn points, produce orders and the per-spawn-point build queue.
// Imports layers 1–6 and systems/economy.js (autoCarve: fresh Workers start carving). Must NOT contain:
// the haul cycle (economy.js). Spec: "Production".

const { WF_MAX_UNITS_PER_PLAYER } = require('../constants');
const { RACES, UNIT_TYPES } = require('../data');
const { makeUnit, buildMs, slotsFor, unitSlotsUsed, builtFacilities, isDisabled, round3 } = require('../state');
const { autoCarve } = require('./economy');

/** Tiles where `army` may produce: its base, then every finished Forward Barracks an EMP hasn't switched off. */
function spawnPoints(state, army, now) {
  return [state.bases[army.team].tileId, ...builtFacilities(army, 'barracks', now).map((u) => u.tileId)];
}

/**
 * Produce (D2, D10, D12): own race, under the unit cap, affordable in 🔩 (and 💎 for
 * advanced units). Pays now; the unit joins the spawn point's sequential queue and
 * appears buildMs later than the one ahead of it.
 */
function orderProduce(state, name, army, cmd, now) {
  const t = UNIT_TYPES[cmd.unitType];
  if (!t || !t.producible) return { ok: false, error: 'Unknown unit' };
  if (t.race !== army.race) return { ok: false, error: `Only ${RACES[t.race].name} can produce that` };
  const points = spawnPoints(state, army, now);
  const at = cmd.atTileId == null ? points[0] : cmd.atTileId;
  if (!points.includes(at)) return { ok: false, error: 'Units can only be produced at your base or a Forward Barracks' };
  if (unitSlotsUsed(army) + slotsFor(t.id) > WF_MAX_UNITS_PER_PLAYER) {
    return { ok: false, error: `Army is at the ${WF_MAX_UNITS_PER_PLAYER}-unit cap` };
  }
  if (army.supply < t.supply) return { ok: false, error: 'Not enough Supply' };
  if (army.minerals < t.minerals) return { ok: false, error: 'Not enough Minerals' };
  army.supply = round3(army.supply - t.supply);
  army.minerals = round3(army.minerals - t.minerals);
  const queue = army.queues[at] || (army.queues[at] = []);
  const startsAt = queue.length ? Math.max(queue[queue.length - 1].doneAt, now) : now;
  queue.push({ unitType: t.id, doneAt: startsAt + buildMs(t.id) });
  return { ok: true };
}

/**
 * Finished queue items step onto their spawn tile; a Summoner brings a Golem to the base.
 * A Forward Barracks switched off by an EMP holds its queue: every item waits `dtMs` longer.
 */
function stepProduction(state, dtMs, now, events) {
  for (const [owner, army] of Object.entries(state.armies)) {
    for (const [key, queue] of Object.entries(army.queues)) {
      const tile = Number(key);
      const barracks = army.units.find((u) => u.type === 'barracks' && u.tileId === tile && u.hp > 0);
      if (barracks && isDisabled(barracks, now)) {
        for (const item of queue) item.doneAt += dtMs;
        continue;
      }
      while (queue.length && queue[0].doneAt <= now) {
        const { unitType } = queue.shift();
        const spawned = [[unitType, tile]];
        if (UNIT_TYPES[unitType].flags.includes('summonsGolem')) spawned.push(['golem', state.bases[army.team].tileId]);
        for (const [type, at] of spawned) {
          const u = makeUnit(state.nextUnitId++, type, owner, at);
          army.units.push(u);
          autoCarve(state, army, u, now); // a fresh Worker gets to work on the supply wall by itself
          events.push({ type: 'spawn', tileId: at, owner, team: army.team, unitId: u.id, unitType: type });
        }
      }
      if (!queue.length) delete army.queues[key];
    }
  }
}

module.exports = {
  spawnPoints,
  orderProduce,
  stepProduction,
};
