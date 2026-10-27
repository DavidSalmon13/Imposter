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

/** Thrown inside a db.transaction() callback to force a rollback on a failed debit. */
class InsufficientFundsError extends Error {}

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

/** True if a stake is a whole number at least BET_MIN_STAKE. */
function validStake(stake) {
  return Number.isInteger(Number(stake)) && Number(stake) >= BET_MIN_STAKE;
}

/**
 * Proposes a side bet on `pick` being this round's loser (round-loser prediction only,
 * per betting-specs.md). No stake is at risk yet - nothing is debited until
 * `acceptSideBet` locks it in. `eligible` is the currently-active roster (the caller's
 * job to compute, since "active" is a Bluff concept betting.js doesn't know about);
 * `targetName` is null for an open-to-the-table proposal. Stored on
 * `room.betSideProposals[roundNumber]`, keyed by round so it's automatically
 * unreachable (not voided, just orphaned) the instant the round changes.
 */
async function proposeSideBet(room, roomCode, { roundNumber, bettorName, userId, pick, stake, targetName, eligible }) {
  if (!isEnabled()) return { ok: false, error: 'Betting is not enabled' };
  if (!validStake(stake)) return { ok: false, error: `Minimum bet is ${BET_MIN_STAKE} tokens` };
  if (!eligible.includes(pick)) return { ok: false, error: 'That pick is not eligible' };
  if (!room.betSideProposals) room.betSideProposals = {};
  const allProposals = Object.values(room.betSideProposals).flat();
  if (allProposals.some((p) => p.bettorName === bettorName)) {
    return { ok: false, error: 'You already have a bet proposal open' };
  }
  const balance = await getBalance(userId);
  if (Number(stake) > balance) return { ok: false, error: 'Not enough tokens' };

  if (!room.betSideProposals[roundNumber]) room.betSideProposals[roundNumber] = [];
  room.betSideProposalSeq = (room.betSideProposalSeq || 0) + 1;
  const proposal = {
    id: room.betSideProposalSeq,
    bettorName,
    userId,
    pick,
    stake: Number(stake),
    targetName: targetName || null,
  };
  room.betSideProposals[roundNumber].push(proposal);
  return { ok: true, proposal };
}

/**
 * Accepts an open side-bet proposal, locking both stakes at the proposer's amount.
 * `roundNumber` must be the *current* round - a proposal from an earlier round is
 * already unreachable (see proposeSideBet's doc comment), which is what makes a round
 * change implicitly expire every unaccepted proposal with no extra cleanup call.
 * Debits both wallets atomically (race-safe on balance) and inserts one `bets` row
 * covering the pair; the row's `bettor_user_id`/`opponent_user_id` keep proposer vs.
 * accepter distinct so resolution knows who gets paid without a second pick to compare.
 */
async function acceptSideBet(room, roomCode, { roundNumber, proposalId, accepterName, accepterUserId }) {
  if (!isEnabled()) return { ok: false, error: 'Betting is not enabled' };
  const list = (room.betSideProposals && room.betSideProposals[roundNumber]) || [];
  const proposal = list.find((p) => p.id === proposalId);
  if (!proposal) return { ok: false, error: 'That bet is no longer available' };
  if (proposal.bettorName === accepterName) return { ok: false, error: "You can't accept your own bet" };
  if (proposal.targetName && proposal.targetName !== accepterName) {
    return { ok: false, error: 'That bet was not offered to you' };
  }

  try {
    await db.transaction(async (client) => {
      // Both debits must hold or neither does - a failed second debit must roll back the
      // first, so this throws rather than returning false (which would still commit).
      const debitBettor = await client.query(
        `UPDATE wallets SET balance = balance - $2 WHERE user_id = $1 AND balance >= $2`,
        [proposal.userId, proposal.stake]
      );
      if (debitBettor.rowCount === 0) throw new InsufficientFundsError();
      const debitAccepter = await client.query(
        `UPDATE wallets SET balance = balance - $2 WHERE user_id = $1 AND balance >= $2`,
        [accepterUserId, proposal.stake]
      );
      if (debitAccepter.rowCount === 0) throw new InsufficientFundsError();
      await client.query(
        `INSERT INTO bets (kind, room_code, bettor_user_id, opponent_user_id, pick_name, stake, status)
         VALUES ('side', $1, $2, $3, $4, $5, 'accepted')`,
        [roomCode, proposal.userId, accepterUserId, proposal.pick, proposal.stake]
      );
    });
  } catch (err) {
    if (err instanceof InsufficientFundsError) return { ok: false, error: 'Not enough tokens to accept that bet' };
    console.error('Accepting a side bet failed:', err.message);
    return { ok: false, error: 'Something went wrong accepting that bet' };
  }

  room.betSideProposals[roundNumber] = list.filter((p) => p.id !== proposalId);
  return { ok: true, proposal };
}

/** Every currently-live (accepted, unresolved) side bet for this room. */
async function liveSideBets(roomCode) {
  const { rows } = await db.query(
    `SELECT id, bettor_user_id, opponent_user_id, pick_name, stake FROM bets
      WHERE room_code = $1 AND kind = 'side' AND status = 'accepted'`,
    [roomCode]
  );
  return rows;
}

/**
 * Resolves every accepted side bet for the round that just ended: whichever side's
 * pick matches `loserName` takes both stakes. Relying on an invariant the call sites
 * maintain: a round's side bets are always resolved or voided before the next round is
 * dealt, so "every currently-accepted side bet in this room" and "every accepted side
 * bet for this round" are the same set - no round_number column needed on `bets`.
 * Any still-unaccepted proposal for the round is just dropped, no wallet involved.
 * Returns `[{ bettorUserId, opponentUserId, pick, stake, bettorWon, payout }]`.
 */
async function resolveSideBets(room, roomCode, { roundNumber, loserName }) {
  if (!isEnabled()) return [];
  if (room.betSideProposals) delete room.betSideProposals[roundNumber];
  const results = [];
  try {
    const bets = await liveSideBets(roomCode);
    for (const bet of bets) {
      const bettorWon = bet.pick_name === loserName;
      const winnerUserId = bettorWon ? bet.bettor_user_id : bet.opponent_user_id;
      const payout = bet.stake * 2;
      await db.transaction(async (client) => {
        await client.query('UPDATE wallets SET balance = balance + $2 WHERE user_id = $1', [winnerUserId, payout]);
        await client.query(
          `UPDATE bets SET status = 'resolved', payout = $2, resolved_at = now() WHERE id = $1`,
          [bet.id, payout]
        );
      });
      results.push({
        bettorUserId: bet.bettor_user_id,
        opponentUserId: bet.opponent_user_id,
        pick: bet.pick_name,
        stake: bet.stake,
        bettorWon,
        payout,
      });
    }
  } catch (err) {
    console.error('Resolving side bets failed:', err.message);
  }
  return results;
}

/**
 * Voids every side bet touching the round a host edit just corrected: accepted bets
 * refund both stakes (nobody wins or loses off a correction), unaccepted proposals are
 * just dropped. Same accepted-bets-belong-to-the-current-round invariant as
 * resolveSideBets. Returns `[{ bettorUserId, opponentUserId, pick, stake }]` for the
 * caller to notify both sides their bet was refunded.
 */
async function voidSideBets(room, roomCode, roundNumber) {
  if (!isEnabled()) return [];
  if (room.betSideProposals) delete room.betSideProposals[roundNumber];
  const results = [];
  try {
    const bets = await liveSideBets(roomCode);
    for (const bet of bets) {
      await db.transaction(async (client) => {
        await client.query('UPDATE wallets SET balance = balance + $2 WHERE user_id = $1', [bet.bettor_user_id, bet.stake]);
        await client.query('UPDATE wallets SET balance = balance + $2 WHERE user_id = $1', [bet.opponent_user_id, bet.stake]);
        await client.query(`UPDATE bets SET status = 'voided', resolved_at = now() WHERE id = $1`, [bet.id]);
      });
      results.push({
        bettorUserId: bet.bettor_user_id,
        opponentUserId: bet.opponent_user_id,
        pick: bet.pick_name,
        stake: bet.stake,
      });
    }
  } catch (err) {
    console.error('Voiding side bets failed:', err.message);
  }
  return results;
}

/** userId for a name currently in the room, or null (guest, or not in the room). */
function userIdFor(room, name) {
  const player = room.players && room.players.get(name);
  return (player && player.userId) || null;
}

/** Name currently holding this userId in the room, or null if they've left/aren't in it. */
function nameForUserId(room, userId) {
  if (!room.players) return null;
  for (const [name, player] of room.players) {
    if (player.userId === userId) return name;
  }
  return null;
}

/** Every open global-bet window still offered to (not yet responded to by) `viewerName`. */
function openWindowsFor(room, viewerName) {
  return Object.entries(room.betGlobalWindows || {})
    .filter(([, w]) => w.offerTo.includes(viewerName) && !w.responded.has(viewerName))
    .map(([trigger, w]) => ({ trigger, eligible: w.eligible.slice() }));
}

/** This viewer's own open proposal (there's at most one, per proposeSideBet), or null. */
function mySideProposal(room, viewerName) {
  for (const [roundNumber, list] of Object.entries(room.betSideProposals || {})) {
    const mine = list.find((p) => p.bettorName === viewerName);
    if (mine) return { ...mine, roundNumber: Number(roundNumber) };
  }
  return null;
}

/** Proposals this viewer could accept: targeted at them, or open to the table. */
function incomingSideOffersFor(room, viewerName) {
  const offers = [];
  for (const [roundNumber, list] of Object.entries(room.betSideProposals || {})) {
    for (const p of list) {
      if (p.bettorName === viewerName) continue;
      if (p.targetName && p.targetName !== viewerName) continue;
      offers.push({ ...p, roundNumber: Number(roundNumber) });
    }
  }
  return offers;
}

/**
 * The `betting` key on Bluff's state payload (see bluffStatePayload in
 * server/games/bluff.js), per betting-specs.md "Who can see whose bets": `null`
 * entirely when betting is off or the viewer is a guest. `isSpectator` and
 * `othersToReveal` (names of OTHER eliminated players) are the caller's job to compute
 * - they're Bluff's own idea of "eliminated," which this game-agnostic module has no
 * business knowing about. `othersToReveal` is ignored unless `isSpectator` is true.
 */
async function bettingViewFor(room, roomCode, viewerName, { isSpectator = false, othersToReveal = [] } = {}) {
  if (!isEnabled()) return null;
  const userId = userIdFor(room, viewerName);
  if (!userId) return null;

  const base = {
    balance: await getBalance(userId),
    minStake: BET_MIN_STAKE,
    openGlobalWindows: openWindowsFor(room, viewerName),
    myGlobalBets: [],
    mySideProposal: mySideProposal(room, viewerName),
    incomingSideOffers: incomingSideOffersFor(room, viewerName),
    mySideBets: [],
    visibleOthersBets: [],
  };

  try {
    const { rows } = await db.query(
      `SELECT kind, trigger, pick_name, stake, bettor_user_id, opponent_user_id FROM bets
        WHERE room_code = $1 AND status = 'accepted' AND (bettor_user_id = $2 OR opponent_user_id = $2)`,
      [roomCode, userId]
    );
    base.myGlobalBets = rows.filter((r) => r.kind === 'global').map((r) => ({ trigger: r.trigger, pick: r.pick_name, stake: r.stake }));
    base.mySideBets = rows
      .filter((r) => r.kind === 'side')
      .map((r) => {
        const isBettor = r.bettor_user_id === userId;
        return {
          pick: r.pick_name,
          stake: r.stake,
          role: isBettor ? 'bettor' : 'opponent',
          opponentName: nameForUserId(room, isBettor ? r.opponent_user_id : r.bettor_user_id),
        };
      });
  } catch (err) {
    console.error('Reading own bets for betting view failed:', err.message);
  }

  if (isSpectator && othersToReveal.length) {
    const otherUserIds = othersToReveal.map((name) => userIdFor(room, name)).filter(Boolean);
    if (otherUserIds.length) {
      try {
        const { rows } = await db.query(
          `SELECT kind, trigger, pick_name, stake, bettor_user_id, opponent_user_id FROM bets
            WHERE room_code = $1 AND status = 'accepted'
              AND (bettor_user_id = ANY($2) OR opponent_user_id = ANY($2))`,
          [roomCode, otherUserIds]
        );
        base.visibleOthersBets = rows
          // A bet the viewer is also a side of is already in mySideBets above - skip it
          // here rather than risk nameForUserId resolving to the viewer themselves.
          .filter((r) => r.bettor_user_id !== userId && r.opponent_user_id !== userId)
          .map((r) => ({
            kind: r.kind,
            pick: r.pick_name,
            stake: r.stake,
            bettorName: nameForUserId(room, r.bettor_user_id),
            opponentName: r.opponent_user_id ? nameForUserId(room, r.opponent_user_id) : null,
          }));
      } catch (err) {
        console.error('Reading others\' bets for betting view failed:', err.message);
      }
    }
  }

  return base;
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
  proposeSideBet,
  acceptSideBet,
  resolveSideBets,
  voidSideBets,
  bettingViewFor,
  nameForUserId,
};
