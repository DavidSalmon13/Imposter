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

/**
 * Opens a global (vs. the house) bet window on `room` for one trigger id ('start', or
 * 'elimination:<name>' - see bluff.js's call sites). `eligible` is frozen here and
 * reused at resolution time for the payout formula; `offerTo` is who the offer is shown
 * to (the whole roster at match start, just the newly-eliminated player on elimination).
 * No-op when betting is disabled, so room.betGlobalWindows simply never exists then.
 */
function openGlobalBetWindow(room, roomCode, { trigger, offerTo, eligible }) {
  if (!isEnabled()) return;
  if (!room.betGlobalWindows) room.betGlobalWindows = {};
  // `responded`: who among offerTo has already placed or dismissed this window - not to
  // be confused with the bets themselves being resolved, which happens at match end.
  room.betGlobalWindows[trigger] = { eligible: eligible.slice(), offerTo: offerTo.slice(), responded: new Set() };
}

/**
 * Places one global bet for `playerName` on `trigger`, after validating the window is
 * open and offered to them, they haven't already placed on it, the pick is inside the
 * window's frozen eligible roster, and the stake is between BET_MIN_STAKE and their
 * current balance. Debits the stake and inserts the bet row atomically. Returns
 * `{ ok: true }` or `{ ok: false, error }` - every rejection is something the client
 * should show the player, never a thrown exception.
 */
async function placeGlobalBet(room, roomCode, { playerName, userId, trigger, pick, stake }) {
  if (!isEnabled()) return { ok: false, error: 'Betting is not enabled' };
  const window = room.betGlobalWindows && room.betGlobalWindows[trigger];
  if (!window) return { ok: false, error: 'That bet window is no longer open' };
  if (!window.offerTo.includes(playerName)) return { ok: false, error: 'That bet was not offered to you' };
  if (window.responded.has(playerName)) return { ok: false, error: 'You already placed a bet on this' };
  if (!window.eligible.includes(pick)) return { ok: false, error: 'That pick is not eligible' };
  const stakeAmount = Number(stake);
  if (!Number.isInteger(stakeAmount) || stakeAmount < BET_MIN_STAKE) {
    return { ok: false, error: `Minimum bet is ${BET_MIN_STAKE} tokens` };
  }

  try {
    const placed = await db.transaction(async (client) => {
      // Race-safe debit: only succeeds if the balance still covers the stake.
      const debit = await client.query(
        `UPDATE wallets SET balance = balance - $2 WHERE user_id = $1 AND balance >= $2`,
        [userId, stakeAmount]
      );
      if (debit.rowCount === 0) return false;
      await client.query(
        `INSERT INTO bets (kind, room_code, bettor_user_id, pick_name, stake, status, trigger)
         VALUES ('global', $1, $2, $3, $4, 'accepted', $5)`,
        [roomCode, userId, pick, stakeAmount, trigger]
      );
      return true;
    });
    if (!placed) return { ok: false, error: 'Not enough tokens' };
  } catch (err) {
    console.error('Placing a global bet failed:', err.message);
    return { ok: false, error: 'Something went wrong placing that bet' };
  }

  window.responded.add(playerName);
  return { ok: true };
}

/**
 * Resolves every open global-bet window on `room` at match end: for each trigger,
 * every bettor whose pick matches `winnerName` is credited
 * `stake * eligibleCandidateCount * (1 - BET_HOUSE_EDGE)` (floored), everyone else gets
 * nothing further (their stake was already debited at placement time).
 * `eligibleCandidateCount` is that window's frozen `eligible` length, the same for every
 * bet placed on that trigger. Backfills `game_id` onto every resolved bet for later
 * joinability. Clears room.betGlobalWindows when done (a new match opens fresh ones).
 *
 * Returns `[{ userId, pick, stake, payout, won }]` for every bet resolved, so the
 * caller (ctx.betting, see server.js) can map userId back to a room player name and
 * pop a resolution toast on their phone. Betting.js itself doesn't know player names,
 * only account ids.
 */
async function resolveGlobalBets(room, roomCode, { gameId, winnerName }) {
  if (!isEnabled()) return [];
  const windows = room.betGlobalWindows || {};
  const results = [];
  for (const [trigger, window] of Object.entries(windows)) {
    const eligibleCount = window.eligible.length;
    try {
      const { rows } = await db.query(
        `SELECT id, bettor_user_id, pick_name, stake FROM bets
          WHERE room_code = $1 AND kind = 'global' AND trigger = $2
            AND status = 'accepted' AND game_id IS NULL`,
        [roomCode, trigger]
      );
      for (const bet of rows) {
        const won = bet.pick_name === winnerName;
        const payout = won ? Math.floor(bet.stake * eligibleCount * (1 - BET_HOUSE_EDGE)) : 0;
        await db.transaction(async (client) => {
          if (payout > 0) {
            await client.query('UPDATE wallets SET balance = balance + $2 WHERE user_id = $1', [
              bet.bettor_user_id,
              payout,
            ]);
          }
          await client.query(
            `UPDATE bets SET status = 'resolved', payout = $2, game_id = $3, resolved_at = now()
              WHERE id = $1`,
            [bet.id, payout, gameId]
          );
        });
        results.push({ userId: bet.bettor_user_id, pick: bet.pick_name, stake: bet.stake, payout, won });
      }
    } catch (err) {
      console.error(`Resolving global bets for trigger ${trigger} failed:`, err.message);
    }
  }
  room.betGlobalWindows = {};
  return results;
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
  openGlobalBetWindow,
  placeGlobalBet,
  resolveGlobalBets,
};
