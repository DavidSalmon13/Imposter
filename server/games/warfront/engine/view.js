'use strict';

// Warfront engine, layer 10: what each player is sent: the fogged live view, own economy,
// filtered events and the fog-lifted final view. Must NOT contain: rule changes to state.
// Spec: "Fog of war", "Hidden information".

const { WF_MAX_UNITS_PER_PLAYER, TUNING } = require('./constants');
const { teamOf, allUnits, stepMs, buildMs, unitSlotsUsed, round3 } = require('./state');
const { supplyRate } = require('./systems/economy');
const { visionFor, lighthouseView } = require('./vision');

/**
 * The live (dynamic) part of the battle as `name` may see it. Own team: every
 * unit with its full path. Enemies: only units on a tile in the team's vision,
 * with just the tile they're stepping onto (never their destination), and a
 * Worker's `carrying` only then. Spectators (no army) see no units at all.
 * `visible` is a '0'/'1' string per tile (row-major). Static map features are
 * in the wfState payload, not here.
 */
function viewForPlayer(state, name) {
  const army = state.armies[name] || null;
  const team = army ? army.team : null;
  const vision = visionFor(state, team);
  const now = state.clock.lastTickAt;
  const units = [];
  for (const { unit: u, owner, team: t } of allUnits(state)) {
    if (!team) break;
    const v = { id: u.id, type: u.type, tileId: u.tileId, hp: u.hp, owner, team: t };
    if (u.buildDoneAt) v.buildDoneAt = u.buildDoneAt;
    if (u.garrison) v.garrison = u.garrison; // on a Tower's roof (everyone who sees it sees that)
    if (t === team) {
      v.path = u.path.slice();
      v.stepStartedAt = u.stepStartedAt;
      v.stepEndsAt = u.stepEndsAt;
      v.carrying = u.carrying;
      v.haul = u.haul;
      v.holding = Boolean(u.holding);
      // How long the step after this one takes, so the client can keep the unit
      // gliding past the tile edge until the next snapshot lands (no stop-start).
      if (u.path.length > 1) v.afterStepMs = stepMs(state.map, u.type, u.path[1]);
    } else {
      if (!vision.has(u.tileId)) {
        // An attacker that just hit this team stays in sight for WF_REVEAL_MS (D14).
        if (!(u.revealedUntil && u.revealedUntil[team] > now)) continue;
        v.revealed = true;
      }
      if (u.path.length) {
        v.nextTileId = u.path[0];
        v.stepStartedAt = u.stepStartedAt;
        v.stepEndsAt = u.stepEndsAt;
        // The step after, only onto a tile this team can already see (never leaks the route into fog).
        if (u.path.length > 1 && vision.has(u.path[1])) {
          v.afterTileId = u.path[1];
          v.afterStepMs = stepMs(state.map, u.type, u.path[1]);
        }
      }
      if (u.class === 'worker') v.carrying = u.carrying;
    }
    units.push(v);
  }
  let visible = '';
  for (let i = 0; i < state.map.width * state.map.height; i++) visible += vision.has(i) ? '1' : '0';
  return {
    tick: state.tick,
    bases: state.bases,
    clock: state.clock,
    event: state.event,
    me: army ? ownEconomy(state, army) : null,
    units,
    visible,
    lighthouses: lighthouseView(state),
    pickups: {
      weapons: state.pickups.weapons.map((w) => ({ tileId: w.tileId, weaponId: w.weaponId })),
      mineralDrops: { ...state.pickups.mineralDrops },
    },
  };
}

/**
 * A player's own resources (never shown to anyone else): 🔩 with its rate per
 * second, 💎, arsenal, unit slots used toward the cap, and each spawn point's
 * queue with when the item being built started.
 */
function ownEconomy(state, army) {
  const queues = Object.entries(army.queues).map(([key, q]) => ({
    tileId: Number(key),
    items: q.map((item) => ({ unitType: item.unitType, startedAt: item.doneAt - buildMs(item.unitType), doneAt: item.doneAt })),
  }));
  return {
    supply: army.supply,
    supplyRate: round3(supplyRate(state, army)),
    minerals: army.minerals,
    arsenal: army.arsenal.slice(),
    units: unitSlotsUsed(army),
    unitCap: WF_MAX_UNITS_PER_PLAYER,
    queues,
    workshop: (army.workshop || []).map((w) => ({ weaponId: w.weaponId, startedAt: w.doneAt - TUNING.workshopWeaponMs, doneAt: w.doneAt })),
  };
}

/** The events of one step that `name` may hear about (own team's, or on a tile they can see). */
function eventsForPlayer(state, name, events) {
  const team = teamOf(state, name);
  if (!team || !events.length) return [];
  const vision = visionFor(state, team);
  // A lighthouse flip is news to everyone: its owner is never hidden (D15).
  return events.filter((e) => e.team === team || e.type === 'lighthouse' || vision.has(e.tileId));
}

/**
 * The finished battle with the fog lifted, for the game-over screen: every unit
 * where it stood (no orders), both bases, the pickups left on the map, the clock,
 * and each player's battle stats.
 */
function finalView(state) {
  const units = allUnits(state).map(({ unit: u, owner, team }) => ({
    id: u.id, type: u.type, tileId: u.tileId, hp: u.hp, owner, team, carrying: u.carrying || 0,
  }));
  const stats = Object.entries(state.armies).map(([name, a]) => ({
    name, team: a.team, race: a.race, kills: 0, lost: 0, baseDmg: 0, ...a.stats,
  }));
  return {
    winner: state.winner,
    bases: state.bases,
    clock: state.clock,
    units,
    visible: '1'.repeat(state.map.width * state.map.height),
    lighthouses: lighthouseView(state),
    pickups: {
      weapons: state.pickups.weapons.map((w) => ({ tileId: w.tileId, weaponId: w.weaponId })),
      mineralDrops: { ...state.pickups.mineralDrops },
    },
    stats,
  };
}

module.exports = {
  viewForPlayer,
  eventsForPlayer,
  finalView,
};
