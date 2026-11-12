'use strict';

// Warfront engine, layer 9: stepSim, which only calls the systems' step* functions in a fixed
// order. Must NOT contain: rules of its own. Plan "Architecture".

const { WF_MAX_DT_MS } = require('./constants');
const { stepConstruction, stepWorkshop } = require('./systems/facilities');
const { stepProduction } = require('./systems/production');
const { stepEconomy } = require('./systems/economy');
const { stepMovement } = require('./systems/movement');
const { stepCombat } = require('./systems/combat');
const { stepLighthouses } = require('./systems/lighthouses');
const { checkWinner } = require('./systems/victory');

/**
 * Advances the world by one sim step ending at `now` (`dtMs` long, already
 * clamped by the caller). Mutates and returns `state` with this step's events.
 * Systems arrive step by step: movement (Step 5), combat (Step 6), economy and
 * production (Step 7), the win check (Step 8), construction and the Workshop
 * (Step 9); battlefield events come later.
 * Once a winner is set the match is over and further steps do nothing.
 */
function stepSim(state, dtMs, { now }) {
  const events = [];
  if (state.winner) return { state, events };
  const dt = Math.max(0, Math.min(dtMs, WF_MAX_DT_MS));
  stepMovement(state, dt, now, events);
  stepConstruction(state, now, events);
  stepCombat(state, now, events);
  stepLighthouses(state, events);
  stepEconomy(state, dt, now, events);
  stepProduction(state, now, events);
  stepWorkshop(state, now, events);
  state.tick += 1;
  state.clock.lastTickAt = now;
  const result = checkWinner(state, now);
  if (result) {
    state.winner = result.winner;
    state.clock.endedAt = Math.min(now, state.clock.matchEndsAt);
    events.push({ type: 'gameOver', winner: result.winner, reason: result.reason });
  }
  return { state, events };
}

module.exports = {
  stepSim,
};
