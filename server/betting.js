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

/**
 * Seeds a new account's wallet with the signup grant. Called by accounts.js inside the
 * same transaction that inserts the `users` row, so a wallet never exists without a
 * user or vice versa. No-op (not even attempted) when betting is disabled - a user
 * created while betting is off simply gets a wallet later if betting is ever turned on
 * and they're next granted (see grantDailyIfNeeded).
 */
async function createWallet(client, userId) {
  if (!isEnabled()) return;
  await client.query(
    `INSERT INTO wallets (user_id, balance) VALUES ($1, $2)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, TOKENS_SIGNUP_GRANT]
  );
}

/**
 * Tops up the daily grant the first time this account is seen on a new calendar day
 * (server clock). Single race-safe UPDATE, no read-then-write. If the account somehow
 * has no wallet yet (e.g. created while betting was disabled), seeds one with just the
 * daily grant rather than the full signup grant - the signup grant is a one-time,
 * account-creation-moment thing, not something a late wallet should backfill.
 */
async function grantDailyIfNeeded(userId) {
  if (!isEnabled()) return;
  try {
    const result = await db.query(
      `UPDATE wallets SET balance = balance + $2, last_grant_date = CURRENT_DATE
        WHERE user_id = $1 AND last_grant_date < CURRENT_DATE`,
      [userId, TOKENS_DAILY_GRANT]
    );
    if (result.rowCount === 0) {
      await db.query(
        `INSERT INTO wallets (user_id, balance) VALUES ($1, $2)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId, TOKENS_DAILY_GRANT]
      );
    }
  } catch (err) {
    console.error('Daily token grant failed:', err.message);
  }
}

/** Current balance for a signed-in user, or 0 if betting is disabled or there's no wallet. */
async function getBalance(userId) {
  if (!isEnabled()) return 0;
  try {
    const { rows } = await db.query('SELECT balance FROM wallets WHERE user_id = $1', [userId]);
    return rows[0] ? rows[0].balance : 0;
  } catch (err) {
    console.error('Wallet balance read failed:', err.message);
    return 0;
  }
}

module.exports = {
  TOKENS_SIGNUP_GRANT,
  TOKENS_DAILY_GRANT,
  BET_MIN_STAKE,
  BET_HOUSE_EDGE,
  isEnabled,
  createWallet,
  grantDailyIfNeeded,
  getBalance,
};
