/**
 * Tokens & betting: wallets and bets for signed-in players, Bluff only in v1. See
 * specs/betting-specs.md for the player-facing rules and plans/betting-implementation-plan.md
 * for the design this mirrors (data model, flows, visibility rules).
 *
 * Shape mirrors server/accounts.js deliberately: every function here is a no-op (or
 * returns a harmless default) when the database is disabled, and nothing here ever
 * throws into a game module's call site - a failed wallet/bet write is just a bet that
 * didn't happen, never something that blocks or desyncs the actual game.
 *
 * `bets.status` note: a global bet (vs. the house) has no separate "accept" step, so it
 * goes straight from not-existing to `'accepted'` on placement - that status means
 * "live, awaiting resolution" for a global bet, vs. "an opponent still needs to accept
 * this" for a side bet. `'pending'` is reserved for an unaccepted side-bet proposal.
 */
const db = require('./db');

const TOKENS_SIGNUP_GRANT = 1000;
const TOKENS_DAILY_GRANT = 100;
const BET_MIN_STAKE = 10;
const BET_HOUSE_EDGE = 0.1;

const BETTING_ENABLED = process.env.BETTING_ENABLED === 'true';

/** Whether betting is live at all: the feature flag, on top of accounts being configured. */
function isEnabled() {
  return BETTING_ENABLED && db.isEnabled();
}

module.exports = {
  TOKENS_SIGNUP_GRANT,
  TOKENS_DAILY_GRANT,
  BET_MIN_STAKE,
  BET_HOUSE_EDGE,
  isEnabled,
};
