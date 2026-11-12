'use strict';

// Warfront engine, layer 8: applyCommand, the dispatcher that validates a player command and
// routes it to a system's order* function. Must NOT contain: rules beyond input validation.
// Spec: "Commands"; plan "Event & function naming reference".

const { unitStats } = require('./data');
const { isPassable } = require('./grid');
const { MAX_UNITS_PER_COMMAND } = require('./state');
const { orderMove, climbTower } = require('./systems/movement');
const { orderProduce } = require('./systems/production');
const { orderHaul } = require('./systems/economy');
const { orderBuild, orderCraft } = require('./systems/facilities');

/**
 * Applies one player command instantly (spec "Commands"). Pure apart from
 * mutating `state`; returns { ok: true } or { ok: false, error }. An invalid
 * command changes nothing.
 */
function applyCommand(state, name, cmd, now) {
  const army = state.armies[name];
  if (!army) return { ok: false, error: 'You have no army in this battle' };
  if (!cmd || typeof cmd !== 'object') return { ok: false, error: 'Invalid command' };
  if (cmd.kind === 'move') {
    const { unitIds, toTileId } = cmd;
    if (!Array.isArray(unitIds) || !unitIds.length || unitIds.length > MAX_UNITS_PER_COMMAND) {
      return { ok: false, error: 'Pick some units first' };
    }
    if (!isPassable(state.map, toTileId)) return { ok: false, error: "Units can't go there" };
    const wanted = new Set(unitIds);
    const units = army.units.filter((u) => wanted.has(u.id) && unitStats(u.type).move > 0);
    if (!units.length) return { ok: false, error: 'Those units are not yours to move' };
    let moved = 0;
    for (const u of units) {
      // Sent to the Tower it already stands beside: climb straight up.
      if (u.tileId === toTileId && !u.path.length && !u.garrison) {
        u.haul = null;
        u.holding = false;
        climbTower(state, army, u, []);
        if (u.garrison) moved++;
        continue;
      }
      if (orderMove(state, u, toTileId, now)) moved++;
    }
    if (!moved) return { ok: false, error: 'Already there' };
    return { ok: true, moved };
  }
  if (cmd.kind === 'produce') return orderProduce(state, name, army, cmd, now);
  if (cmd.kind === 'haul') return orderHaul(state, army, cmd, now);
  if (cmd.kind === 'build') return orderBuild(state, name, army, cmd, now);
  if (cmd.kind === 'craft') return orderCraft(state, army, cmd, now);
  if (cmd.kind === 'hold') {
    const { unitIds } = cmd;
    if (!Array.isArray(unitIds) || !unitIds.length || unitIds.length > MAX_UNITS_PER_COMMAND) {
      return { ok: false, error: 'Pick some units first' };
    }
    const wanted = new Set(unitIds);
    const units = army.units.filter((u) => wanted.has(u.id) && unitStats(u.type).move > 0);
    if (!units.length) return { ok: false, error: 'Those units are not yours to command' };
    for (const u of units) {
      // Stop where it stands: a step in progress finishes (no snapping back), then nothing.
      if (u.path.length > 1) u.path = [u.path[0]];
      u.haul = null;
      u.holding = true;
    }
    return { ok: true, held: units.length };
  }
  return { ok: false, error: 'Unknown command' };
}

module.exports = {
  applyCommand,
};
