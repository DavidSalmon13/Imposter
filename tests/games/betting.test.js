'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.BETTING_ENABLED = 'true';
const db = require('../../server/db');
const betting = require('../../server/betting');

/** Fake pg client/pool: records every query call and returns canned results in order. */
function fakeQueryable(results = []) {
  const calls = [];
  let i = 0;
  return {
    calls,
    query: async (text, params) => {
      calls.push({ text, params });
      return results[i++] || { rows: [], rowCount: 0 };
    },
  };
}

test('createWallet: seeds a wallet with the signup grant, ignoring a conflict', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  const client = fakeQueryable();
  await betting.createWallet(client, 42);
  assert.equal(client.calls.length, 1);
  assert.match(client.calls[0].text, /INSERT INTO wallets/);
  assert.match(client.calls[0].text, /ON CONFLICT \(user_id\) DO NOTHING/);
  assert.deepEqual(client.calls[0].params, [42, betting.TOKENS_SIGNUP_GRANT]);
});

test('createWallet: no-op when betting is disabled', async (t) => {
  t.mock.method(db, 'isEnabled', () => false);
  const client = fakeQueryable();
  await betting.createWallet(client, 42);
  assert.equal(client.calls.length, 0);
});

test('grantDailyIfNeeded: a matched UPDATE does not fall back to inserting a wallet', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  const fake = fakeQueryable([{ rows: [], rowCount: 1 }]);
  t.mock.method(db, 'query', fake.query);
  await betting.grantDailyIfNeeded(7);
  assert.equal(fake.calls.length, 1);
  assert.match(fake.calls[0].text, /UPDATE wallets/);
  assert.match(fake.calls[0].text, /last_grant_date < CURRENT_DATE/);
  assert.deepEqual(fake.calls[0].params, [7, betting.TOKENS_DAILY_GRANT]);
});

test('grantDailyIfNeeded: seeds a wallet with just the daily grant when none matched', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  const fake = fakeQueryable([{ rows: [], rowCount: 0 }, { rows: [], rowCount: 1 }]);
  t.mock.method(db, 'query', fake.query);
  await betting.grantDailyIfNeeded(7);
  assert.equal(fake.calls.length, 2);
  assert.match(fake.calls[1].text, /INSERT INTO wallets/);
  assert.deepEqual(fake.calls[1].params, [7, betting.TOKENS_DAILY_GRANT]);
});

test('grantDailyIfNeeded: no query at all when betting is disabled', async (t) => {
  t.mock.method(db, 'isEnabled', () => false);
  const fake = fakeQueryable();
  t.mock.method(db, 'query', fake.query);
  await betting.grantDailyIfNeeded(7);
  assert.equal(fake.calls.length, 0);
});

test('grantDailyIfNeeded: a failed write is swallowed, never thrown', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  t.mock.method(db, 'query', async () => {
    throw new Error('connection reset');
  });
  await assert.doesNotReject(betting.grantDailyIfNeeded(7));
});

test('getBalance: reads the wallet balance', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  t.mock.method(db, 'query', async () => ({ rows: [{ balance: 250 }] }));
  assert.equal(await betting.getBalance(7), 250);
});

test('getBalance: 0 when no wallet row exists', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  t.mock.method(db, 'query', async () => ({ rows: [] }));
  assert.equal(await betting.getBalance(7), 0);
});

test('getBalance: 0 without querying when betting is disabled', async (t) => {
  t.mock.method(db, 'isEnabled', () => false);
  const fake = fakeQueryable();
  t.mock.method(db, 'query', fake.query);
  assert.equal(await betting.getBalance(7), 0);
  assert.equal(fake.calls.length, 0);
});

test('getBalance: 0, never throws, when the read fails', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  t.mock.method(db, 'query', async () => {
    throw new Error('connection reset');
  });
  assert.equal(await betting.getBalance(7), 0);
});

/** Stands in for db.transaction: runs fn against a fake client sharing one call log. */
function mockTransaction(t, results = []) {
  const fake = fakeQueryable(results);
  t.mock.method(db, 'transaction', (fn) => fn(fake));
  return fake;
}

test('openGlobalBetWindow: freezes eligible/offerTo on the room, keyed by trigger', (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  const room = {};
  betting.openGlobalBetWindow(room, 'ABCD', { trigger: 'start', offerTo: ['Ann', 'Bo'], eligible: ['Ann', 'Bo', 'Cy'] });
  assert.deepEqual(room.betGlobalWindows.start.eligible, ['Ann', 'Bo', 'Cy']);
  assert.deepEqual(room.betGlobalWindows.start.offerTo, ['Ann', 'Bo']);
  assert.equal(room.betGlobalWindows.start.responded.size, 0);
});

test('openGlobalBetWindow: no-op when betting is disabled', (t) => {
  t.mock.method(db, 'isEnabled', () => false);
  const room = {};
  betting.openGlobalBetWindow(room, 'ABCD', { trigger: 'start', offerTo: ['Ann'], eligible: ['Ann'] });
  assert.equal(room.betGlobalWindows, undefined);
});

test('placeGlobalBet: rejects when no window is open for that trigger', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  const room = {};
  const result = await betting.placeGlobalBet(room, 'ABCD', { playerName: 'Ann', userId: 1, trigger: 'start', pick: 'Ann', stake: 50 });
  assert.equal(result.ok, false);
});

test('placeGlobalBet: rejects a player the window was not offered to', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  const room = {};
  betting.openGlobalBetWindow(room, 'ABCD', { trigger: 'elimination:Cy', offerTo: ['Cy'], eligible: ['Ann', 'Bo'] });
  const result = await betting.placeGlobalBet(room, 'ABCD', { playerName: 'Ann', userId: 1, trigger: 'elimination:Cy', pick: 'Ann', stake: 50 });
  assert.equal(result.ok, false);
});

test('placeGlobalBet: rejects a pick outside the frozen eligible roster', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  const room = {};
  betting.openGlobalBetWindow(room, 'ABCD', { trigger: 'start', offerTo: ['Ann'], eligible: ['Ann', 'Bo'] });
  const result = await betting.placeGlobalBet(room, 'ABCD', { playerName: 'Ann', userId: 1, trigger: 'start', pick: 'Zed', stake: 50 });
  assert.equal(result.ok, false);
});

test('placeGlobalBet: rejects a stake below BET_MIN_STAKE', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  const room = {};
  betting.openGlobalBetWindow(room, 'ABCD', { trigger: 'start', offerTo: ['Ann'], eligible: ['Ann'] });
  const result = await betting.placeGlobalBet(room, 'ABCD', { playerName: 'Ann', userId: 1, trigger: 'start', pick: 'Ann', stake: 5 });
  assert.equal(result.ok, false);
});

test('placeGlobalBet: one bet per window - a second attempt by the same player is rejected', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  const room = {};
  betting.openGlobalBetWindow(room, 'ABCD', { trigger: 'start', offerTo: ['Ann'], eligible: ['Ann'] });
  mockTransaction(t, [{ rows: [], rowCount: 1 }]);
  const first = await betting.placeGlobalBet(room, 'ABCD', { playerName: 'Ann', userId: 1, trigger: 'start', pick: 'Ann', stake: 50 });
  assert.equal(first.ok, true);
  const second = await betting.placeGlobalBet(room, 'ABCD', { playerName: 'Ann', userId: 1, trigger: 'start', pick: 'Ann', stake: 50 });
  assert.equal(second.ok, false);
});

test('placeGlobalBet: insufficient balance (debit affects no rows) is rejected without inserting a bet', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  const room = {};
  betting.openGlobalBetWindow(room, 'ABCD', { trigger: 'start', offerTo: ['Ann'], eligible: ['Ann'] });
  const fake = mockTransaction(t, [{ rows: [], rowCount: 0 }]);
  const result = await betting.placeGlobalBet(room, 'ABCD', { playerName: 'Ann', userId: 1, trigger: 'start', pick: 'Ann', stake: 5000 });
  assert.equal(result.ok, false);
  assert.equal(fake.calls.length, 1, 'only the debit attempt, no insert when it fails');
  assert.equal(room.betGlobalWindows.start.responded.has('Ann'), false);
});

test('placeGlobalBet: success debits the stake and inserts an accepted global bet', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  const room = {};
  betting.openGlobalBetWindow(room, 'ABCD', { trigger: 'start', offerTo: ['Ann'], eligible: ['Ann', 'Bo'] });
  const fake = mockTransaction(t, [{ rows: [], rowCount: 1 }]);
  const result = await betting.placeGlobalBet(room, 'ABCD', { playerName: 'Ann', userId: 1, trigger: 'start', pick: 'Bo', stake: 50 });
  assert.equal(result.ok, true);
  assert.match(fake.calls[0].text, /UPDATE wallets SET balance = balance - \$2/);
  assert.deepEqual(fake.calls[0].params, [1, 50]);
  assert.match(fake.calls[1].text, /INSERT INTO bets/);
  // No odds inputs = even odds: 2 eligible * (1 - 0.10) = 1.8, locked onto the row.
  assert.deepEqual(fake.calls[1].params, ['ABCD', 1, 'Bo', 50, 'start', 1.8]);
  assert.equal(result.odds, 1.8);
  assert.equal(room.betGlobalWindows.start.responded.has('Ann'), true);
});

test('placeGlobalBet: prices the pick from oddsInputs and locks those odds onto the row', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  const room = {};
  betting.openGlobalBetWindow(room, 'ABCD', { trigger: 'start', offerTo: ['Ann'], eligible: ['Ann', 'Bo'] });
  const fake = mockTransaction(t, [{ rows: [], rowCount: 1 }]);
  const oddsInputs = { Ann: { cards: 15, rating: 50 }, Bo: { cards: 5, rating: 50 } };
  const result = await betting.placeGlobalBet(room, 'ABCD', { playerName: 'Ann', userId: 1, trigger: 'start', pick: 'Bo', stake: 50, oddsInputs });
  assert.equal(result.ok, true);
  // Bo: 0.75 * 5/20 + 0.25 * 1/2 = 0.3125 -> 0.9 / 0.3125 = 2.88 -> 2.8
  assert.equal(fake.calls[1].params[5], 2.8);
});

test('placeGlobalBet: refuses when the odds the client was shown have since moved', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  const room = {};
  betting.openGlobalBetWindow(room, 'ABCD', { trigger: 'start', offerTo: ['Ann'], eligible: ['Ann', 'Bo'] });
  const fake = mockTransaction(t, [{ rows: [], rowCount: 1 }]);
  const oddsInputs = { Ann: { cards: 15, rating: 50 }, Bo: { cards: 5, rating: 50 } };
  const result = await betting.placeGlobalBet(room, 'ABCD', { playerName: 'Ann', userId: 1, trigger: 'start', pick: 'Bo', stake: 50, oddsInputs, odds: 1.8 });
  assert.equal(result.ok, false);
  assert.match(result.error, /×2\.8/);
  assert.equal(fake.calls.length, 0, 'nothing debited');
  assert.equal(room.betGlobalWindows.start.responded.has('Ann'), false);
});

test('placeGlobalBet: rejects a frozen-eligible pick who has since run out of cards', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  const room = {};
  betting.openGlobalBetWindow(room, 'ABCD', { trigger: 'start', offerTo: ['Ann'], eligible: ['Ann', 'Bo', 'Cy'] });
  const oddsInputs = { Ann: { cards: 3 }, Bo: { cards: 2 }, Cy: { cards: 0 } };
  const result = await betting.placeGlobalBet(room, 'ABCD', { playerName: 'Ann', userId: 1, trigger: 'start', pick: 'Cy', stake: 50, oddsInputs });
  assert.equal(result.ok, false);
});

test('computeGlobalOdds: even table reproduces the flat eligible * (1 - edge)', () => {
  const odds = betting.computeGlobalOdds(['Ann', 'Bo', 'Cy'], {
    Ann: { cards: 10, rating: 60 },
    Bo: { cards: 10, rating: 60 },
    Cy: { cards: 10, rating: 60 },
  });
  assert.deepEqual(odds, { Ann: 2.7, Bo: 2.7, Cy: 2.7 });
});

test('computeGlobalOdds: cards left move the odds more than rating does', () => {
  // Same rating gap and same card gap, in opposite directions: the card leader is still
  // the favourite.
  const odds = betting.computeGlobalOdds(['Ann', 'Bo'], {
    Ann: { cards: 15, rating: 40 },
    Bo: { cards: 5, rating: 80 },
  });
  assert.ok(odds.Ann < odds.Bo, JSON.stringify(odds));
  // Ann: 0.75 * 0.75 + 0.25 * (40/120) = 0.6458 -> 1.39 -> 1.3
  // Bo:  0.75 * 0.25 + 0.25 * (80/120) = 0.3542 -> 2.54 -> 2.5
  assert.deepEqual(odds, { Ann: 1.3, Bo: 2.5 });
});

test('computeGlobalOdds: with equal cards, the higher-rated player is the favourite', () => {
  const odds = betting.computeGlobalOdds(['Ann', 'Bo'], {
    Ann: { cards: 8, rating: 90 },
    Bo: { cards: 8, rating: 30 },
  });
  assert.ok(odds.Ann < odds.Bo, JSON.stringify(odds));
});

test('computeGlobalOdds: guests/unrated get the 50 baseline, out players get no odds, heavy favourite floors at 1.1', () => {
  const odds = betting.computeGlobalOdds(['Ann', 'Bo', 'Cy'], {
    Ann: { cards: 30, rating: null },
    Bo: { cards: 1 },
    Cy: { cards: 0, rating: 99 },
  });
  assert.equal('Cy' in odds, false);
  assert.equal(odds.Ann, 1.1);
  assert.ok(odds.Bo > 2);
});

test('resolveGlobalBets: pays the house-edge-adjusted, floored payout to the winning pick', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  const room = {};
  betting.openGlobalBetWindow(room, 'ABCD', { trigger: 'start', offerTo: ['Ann', 'Bo'], eligible: ['Ann', 'Bo', 'Cy'] });
  t.mock.method(db, 'query', async (text) => {
    if (/^SELECT/.test(text)) {
      return { rows: [{ id: 1, bettor_user_id: 1, pick_name: 'Ann', stake: 100 }] };
    }
    return { rows: [], rowCount: 1 };
  });
  const fake = mockTransaction(t);
  const results = await betting.resolveGlobalBets(room, 'ABCD', { gameId: 99, winnerName: 'Ann' });
  // A row with no locked odds (placed before odds existed): 100 * 3 eligible * (1 - 0.10) = 270
  assert.deepEqual(results, [{ userId: 1, pick: 'Ann', stake: 100, payout: 270, won: true }]);
  assert.match(fake.calls[0].text, /UPDATE wallets SET balance = balance \+ \$2/);
  assert.deepEqual(fake.calls[0].params, [1, 270]);
  assert.match(fake.calls[1].text, /UPDATE bets SET status = 'resolved'/);
  assert.deepEqual(fake.calls[1].params, [1, 270, 99]);
  assert.deepEqual(room.betGlobalWindows, {});
});

test('resolveGlobalBets: pays the odds locked onto the row, whatever the window size', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  const room = {};
  betting.openGlobalBetWindow(room, 'ABCD', { trigger: 'start', offerTo: ['Ann'], eligible: ['Ann', 'Bo', 'Cy'] });
  t.mock.method(db, 'query', async (text) => {
    // pg hands NUMERIC back as a string.
    if (/^SELECT/.test(text)) return { rows: [{ id: 1, bettor_user_id: 1, pick_name: 'Ann', stake: 50, odds: '4.3' }] };
    return { rows: [], rowCount: 1 };
  });
  mockTransaction(t);
  const results = await betting.resolveGlobalBets(room, 'ABCD', { gameId: 99, winnerName: 'Ann' });
  // 50 * 4.3 = 215
  assert.equal(results[0].payout, 215);
});

test('resolveGlobalBets: floors a payout that would not land on a whole token', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  const room = {};
  betting.openGlobalBetWindow(room, 'ABCD', { trigger: 'start', offerTo: ['Ann'], eligible: ['Ann', 'Bo', 'Cy'] });
  t.mock.method(db, 'query', async (text) => {
    if (/^SELECT/.test(text)) return { rows: [{ id: 1, bettor_user_id: 1, pick_name: 'Ann', stake: 11 }] };
    return { rows: [], rowCount: 1 };
  });
  mockTransaction(t);
  const results = await betting.resolveGlobalBets(room, 'ABCD', { gameId: 99, winnerName: 'Ann' });
  // 11 * 3 eligible * 0.9 = 29.7, floored to 29.
  assert.equal(results[0].payout, 29);
});

test('resolveGlobalBets: a losing pick gets payout 0 and no wallet credit query', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  const room = {};
  betting.openGlobalBetWindow(room, 'ABCD', { trigger: 'start', offerTo: ['Ann'], eligible: ['Ann', 'Bo'] });
  t.mock.method(db, 'query', async (text) => {
    if (/^SELECT/.test(text)) return { rows: [{ id: 1, bettor_user_id: 1, pick_name: 'Bo', stake: 100 }] };
    return { rows: [], rowCount: 1 };
  });
  const fake = mockTransaction(t);
  const results = await betting.resolveGlobalBets(room, 'ABCD', { gameId: 99, winnerName: 'Ann' });
  assert.deepEqual(results, [{ userId: 1, pick: 'Bo', stake: 100, payout: 0, won: false }]);
  // Only the bet-status update ran - no balance credit for a loss (already debited at placement).
  assert.equal(fake.calls.length, 1);
  assert.match(fake.calls[0].text, /UPDATE bets SET status = 'resolved'/);
});

test('resolveGlobalBets: an elimination-moment window uses its own (smaller) eligible count', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  const room = {};
  betting.openGlobalBetWindow(room, 'ABCD', { trigger: 'start', offerTo: ['Ann', 'Bo', 'Cy'], eligible: ['Ann', 'Bo', 'Cy'] });
  betting.openGlobalBetWindow(room, 'ABCD', { trigger: 'elimination:Cy', offerTo: ['Cy'], eligible: ['Ann', 'Bo'] });
  t.mock.method(db, 'query', async (text, params) => {
    if (/^SELECT/.test(text) && params[1] === 'start') {
      return { rows: [{ id: 1, bettor_user_id: 1, pick_name: 'Ann', stake: 30 }] };
    }
    if (/^SELECT/.test(text) && params[1] === 'elimination:Cy') {
      return { rows: [{ id: 2, bettor_user_id: 3, pick_name: 'Ann', stake: 30 }] };
    }
    return { rows: [], rowCount: 1 };
  });
  mockTransaction(t);
  const results = await betting.resolveGlobalBets(room, 'ABCD', { gameId: 99, winnerName: 'Ann' });
  const byUser = new Map(results.map((r) => [r.userId, r.payout]));
  // start: 30 * 3 * 0.9 = 81; elimination:Cy: 30 * 2 * 0.9 = 54
  assert.equal(byUser.get(1), 81);
  assert.equal(byUser.get(3), 54);
});

test('proposeSideBet: rejects a pick outside the active roster', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  const room = {};
  const result = await betting.proposeSideBet(room, 'ABCD', {
    roundNumber: 1, bettorName: 'Ann', userId: 1, pick: 'Zed', stake: 20, targetName: null, eligible: ['Bo', 'Cy'],
  });
  assert.equal(result.ok, false);
});

test('proposeSideBet: rejects a stake below BET_MIN_STAKE', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  const room = {};
  const result = await betting.proposeSideBet(room, 'ABCD', {
    roundNumber: 1, bettorName: 'Ann', userId: 1, pick: 'Bo', stake: 5, targetName: null, eligible: ['Bo', 'Cy'],
  });
  assert.equal(result.ok, false);
});

test('proposeSideBet: rejects a stake above current balance', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  t.mock.method(db, 'query', async () => ({ rows: [{ balance: 15 }] }));
  const room = {};
  const result = await betting.proposeSideBet(room, 'ABCD', {
    roundNumber: 1, bettorName: 'Ann', userId: 1, pick: 'Bo', stake: 20, targetName: null, eligible: ['Bo', 'Cy'],
  });
  assert.equal(result.ok, false);
});

test('proposeSideBet: only one unaccepted proposal at a time per player', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  t.mock.method(db, 'query', async () => ({ rows: [{ balance: 500 }] }));
  const room = {};
  const first = await betting.proposeSideBet(room, 'ABCD', {
    roundNumber: 1, bettorName: 'Ann', userId: 1, pick: 'Bo', stake: 20, targetName: null, eligible: ['Bo', 'Cy'],
  });
  assert.equal(first.ok, true);
  const second = await betting.proposeSideBet(room, 'ABCD', {
    roundNumber: 1, bettorName: 'Ann', userId: 1, pick: 'Cy', stake: 20, targetName: null, eligible: ['Bo', 'Cy'],
  });
  assert.equal(second.ok, false);
});

test('acceptSideBet: rejects a proposal from a round that has since moved on', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  t.mock.method(db, 'query', async () => ({ rows: [{ balance: 500 }] }));
  const room = {};
  const { proposal } = await betting.proposeSideBet(room, 'ABCD', {
    roundNumber: 1, bettorName: 'Ann', userId: 1, pick: 'Bo', stake: 20, targetName: null, eligible: ['Bo', 'Cy'],
  });
  const result = await betting.acceptSideBet(room, 'ABCD', {
    roundNumber: 2, proposalId: proposal.id, accepterName: 'Cy', accepterUserId: 3,
  });
  assert.equal(result.ok, false);
});

test('acceptSideBet: a targeted proposal rejects anyone but the target', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  t.mock.method(db, 'query', async () => ({ rows: [{ balance: 500 }] }));
  const room = {};
  const { proposal } = await betting.proposeSideBet(room, 'ABCD', {
    roundNumber: 1, bettorName: 'Ann', userId: 1, pick: 'Bo', stake: 20, targetName: 'Cy', eligible: ['Bo', 'Cy'],
  });
  const result = await betting.acceptSideBet(room, 'ABCD', {
    roundNumber: 1, proposalId: proposal.id, accepterName: 'Dee', accepterUserId: 4,
  });
  assert.equal(result.ok, false);
});

test('acceptSideBet: rejects the proposer accepting their own bet', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  t.mock.method(db, 'query', async () => ({ rows: [{ balance: 500 }] }));
  const room = {};
  const { proposal } = await betting.proposeSideBet(room, 'ABCD', {
    roundNumber: 1, bettorName: 'Ann', userId: 1, pick: 'Bo', stake: 20, targetName: null, eligible: ['Bo', 'Cy'],
  });
  const result = await betting.acceptSideBet(room, 'ABCD', {
    roundNumber: 1, proposalId: proposal.id, accepterName: 'Ann', accepterUserId: 1,
  });
  assert.equal(result.ok, false);
});

test('acceptSideBet: success debits both stakes, inserts one accepted bet, and removes the proposal', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  t.mock.method(db, 'query', async () => ({ rows: [{ balance: 500 }] }));
  const room = {};
  const { proposal } = await betting.proposeSideBet(room, 'ABCD', {
    roundNumber: 1, bettorName: 'Ann', userId: 1, pick: 'Bo', stake: 20, targetName: null, eligible: ['Bo', 'Cy'],
  });
  const fake = mockTransaction(t, [{ rows: [], rowCount: 1 }, { rows: [], rowCount: 1 }]);
  const result = await betting.acceptSideBet(room, 'ABCD', {
    roundNumber: 1, proposalId: proposal.id, accepterName: 'Cy', accepterUserId: 3,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(fake.calls[0].params, [1, 20]);
  assert.deepEqual(fake.calls[1].params, [3, 20]);
  assert.match(fake.calls[2].text, /INSERT INTO bets/);
  assert.deepEqual(fake.calls[2].params, ['ABCD', 1, 3, 'Bo', 20]);
  assert.deepEqual(room.betSideProposals[1], []);
});

test('acceptSideBet: a failed second debit rolls back the first (no lost stake)', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  t.mock.method(db, 'query', async () => ({ rows: [{ balance: 500 }] }));
  const room = {};
  const { proposal } = await betting.proposeSideBet(room, 'ABCD', {
    roundNumber: 1, bettorName: 'Ann', userId: 1, pick: 'Bo', stake: 20, targetName: null, eligible: ['Bo', 'Cy'],
  });
  // First debit (bettor) succeeds, second (accepter) fails for insufficient balance.
  const fake = mockTransaction(t, [{ rows: [], rowCount: 1 }, { rows: [], rowCount: 0 }]);
  const result = await betting.acceptSideBet(room, 'ABCD', {
    roundNumber: 1, proposalId: proposal.id, accepterName: 'Cy', accepterUserId: 3,
  });
  assert.equal(result.ok, false);
  assert.equal(fake.calls.length, 2, 'never reaches the insert');
  // The proposal is still there - a rolled-back accept must not consume it.
  assert.equal(room.betSideProposals[1].length, 1);
});

test('resolveSideBets: the bettor wins both stakes when their pick matches the loser', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  const room = { betSideProposals: { 3: [{ id: 99, bettorName: 'Zed' }] } };
  t.mock.method(db, 'query', async (text) => {
    if (/^SELECT/.test(text)) {
      return { rows: [{ id: 1, bettor_user_id: 1, opponent_user_id: 3, pick_name: 'Bo', stake: 20 }] };
    }
    return { rows: [], rowCount: 1 };
  });
  const fake = mockTransaction(t);
  const results = await betting.resolveSideBets(room, 'ABCD', { roundNumber: 3, loserName: 'Bo' });
  assert.deepEqual(results, [{ bettorUserId: 1, opponentUserId: 3, pick: 'Bo', stake: 20, bettorWon: true, payout: 40 }]);
  assert.deepEqual(fake.calls[0].params, [1, 40], 'credits the bettor, not the opponent');
  assert.equal(room.betSideProposals[3], undefined, 'leftover unaccepted proposals for the round are dropped');
});

test('resolveSideBets: the opponent wins both stakes when the bettor\'s pick is wrong', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  const room = {};
  t.mock.method(db, 'query', async (text) => {
    if (/^SELECT/.test(text)) {
      return { rows: [{ id: 1, bettor_user_id: 1, opponent_user_id: 3, pick_name: 'Bo', stake: 20 }] };
    }
    return { rows: [], rowCount: 1 };
  });
  const fake = mockTransaction(t);
  const results = await betting.resolveSideBets(room, 'ABCD', { roundNumber: 3, loserName: 'Cy' });
  assert.equal(results[0].bettorWon, false);
  assert.deepEqual(fake.calls[0].params, [3, 40], 'credits the opponent, not the bettor');
});

test('resolveSideBets: an unaccepted proposal with no accept just disappears, no wallet writes', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  const room = { betSideProposals: { 3: [{ id: 99, bettorName: 'Zed', pick: 'Bo', stake: 20 }] } };
  const fake = fakeQueryable([{ rows: [] }]);
  t.mock.method(db, 'query', fake.query);
  const results = await betting.resolveSideBets(room, 'ABCD', { roundNumber: 3, loserName: 'Bo' });
  assert.deepEqual(results, []);
  assert.equal(room.betSideProposals[3], undefined);
  assert.equal(fake.calls.length, 1, 'only the lookup query, no wallet writes');
});

test('voidSideBets: refunds both stakes on an accepted bet and drops any pending proposal', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  const room = { betSideProposals: { 3: [{ id: 5, bettorName: 'Someone' }] } };
  t.mock.method(db, 'query', async (text) => {
    if (/^SELECT/.test(text)) {
      return { rows: [{ id: 1, bettor_user_id: 1, opponent_user_id: 3, pick_name: 'Bo', stake: 20 }] };
    }
    return { rows: [], rowCount: 1 };
  });
  const fake = mockTransaction(t);
  const results = await betting.voidSideBets(room, 'ABCD', 3);
  assert.deepEqual(results, [{ bettorUserId: 1, opponentUserId: 3, pick: 'Bo', stake: 20 }]);
  assert.deepEqual(fake.calls[0].params, [1, 20]);
  assert.deepEqual(fake.calls[1].params, [3, 20]);
  assert.match(fake.calls[2].text, /UPDATE bets SET status = 'voided'/);
  assert.equal(room.betSideProposals[3], undefined);
});

test('expireDanglingBets: scopes to one room, only accepted + unresolved (game_id NULL) rows', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  const fake = fakeQueryable([{ rows: [], rowCount: 2 }]);
  t.mock.method(db, 'query', fake.query);
  await betting.expireDanglingBets('ABCD');
  assert.equal(fake.calls.length, 1);
  assert.match(fake.calls[0].text, /UPDATE bets SET status = 'expired'/);
  assert.match(fake.calls[0].text, /room_code = \$1/);
  assert.match(fake.calls[0].text, /status = 'accepted'/);
  assert.match(fake.calls[0].text, /game_id IS NULL/);
  assert.deepEqual(fake.calls[0].params, ['ABCD']);
});

test('expireDanglingBets: with no roomCode sweeps every room (boot cleanup), no params', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  const fake = fakeQueryable([{ rows: [], rowCount: 5 }]);
  t.mock.method(db, 'query', fake.query);
  await betting.expireDanglingBets();
  assert.equal(fake.calls.length, 1);
  assert.match(fake.calls[0].text, /UPDATE bets SET status = 'expired'/);
  assert.doesNotMatch(fake.calls[0].text, /room_code/);
  assert.equal(fake.calls[0].params, undefined);
});

test('expireDanglingBets: no query when betting is disabled', async (t) => {
  t.mock.method(db, 'isEnabled', () => false);
  const fake = fakeQueryable();
  t.mock.method(db, 'query', fake.query);
  await betting.expireDanglingBets('ABCD');
  assert.equal(fake.calls.length, 0);
});

test('expireDanglingBets: a failed write is swallowed, never thrown', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  t.mock.method(db, 'query', async () => {
    throw new Error('db down');
  });
  await betting.expireDanglingBets('ABCD'); // must not reject
});

test('a dangling accepted bet, once expired, is not swept by a later match\'s resolution', async (t) => {
  // Models the cross-match leak the expire fixes: the DB sweep keys on room_code +
  // status='accepted', so expiring a row (status -> 'expired') removes it from the set
  // resolveGlobalBets/liveSideBets ever see again.
  t.mock.method(db, 'isEnabled', () => true);
  const store = [
    { id: 1, room_code: 'ABCD', kind: 'global', trigger: 'start', status: 'accepted', game_id: null, bettor_user_id: 1, pick_name: 'Gone', stake: 50 },
  ];
  t.mock.method(db, 'query', async (text, params) => {
    if (/UPDATE bets SET status = 'expired'/.test(text)) {
      store.forEach((b) => {
        if (b.status === 'accepted' && b.game_id === null) b.status = 'expired';
      });
      return { rows: [], rowCount: 1 };
    }
    if (/^SELECT.*bets/s.test(text)) {
      return { rows: store.filter((b) => b.status === 'accepted' && b.game_id === null && b.trigger === params[1]) };
    }
    return { rows: [], rowCount: 1 };
  });
  mockTransaction(t);

  await betting.expireDanglingBets('ABCD');
  // A brand-new match opens its own 'start' window and resolves - the stale row is gone.
  const room = { betGlobalWindows: { start: { eligible: ['Alice', 'Bob'] } } };
  const results = await betting.resolveGlobalBets(room, 'ABCD', { gameId: 99, winnerName: 'Gone' });
  assert.deepEqual(results, [], 'the expired bet is not resolved against the new match');
});

/** A room.players Map with { userId } for each signed-in name; omit userId for a guest. */
function playersMap(entries) {
  return new Map(Object.entries(entries));
}

test('bettingViewFor: null when betting is disabled', async (t) => {
  t.mock.method(db, 'isEnabled', () => false);
  const room = { players: playersMap({ Ann: { userId: 1 } }) };
  assert.equal(await betting.bettingViewFor(room, 'ABCD', 'Ann'), null);
});

test('bettingViewFor: null for a guest (no userId)', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  const room = { players: playersMap({ Ann: {} }) };
  assert.equal(await betting.bettingViewFor(room, 'ABCD', 'Ann'), null);
});

test('bettingViewFor: only shows global windows offered to this viewer that they have not responded to', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  t.mock.method(db, 'query', async () => ({ rows: [] }));
  const room = { players: playersMap({ Ann: { userId: 1 }, Bo: { userId: 2 } }) };
  betting.openGlobalBetWindow(room, 'ABCD', { trigger: 'start', offerTo: ['Ann', 'Bo'], eligible: ['Ann', 'Bo'] });
  betting.openGlobalBetWindow(room, 'ABCD', { trigger: 'elimination:Bo', offerTo: ['Bo'], eligible: ['Ann'] });
  room.betGlobalWindows.start.responded.add('Ann');
  const view = await betting.bettingViewFor(room, 'ABCD', 'Ann');
  assert.deepEqual(view.openGlobalWindows, []);
  const boView = await betting.bettingViewFor(room, 'ABCD', 'Bo');
  assert.deepEqual(boView.openGlobalWindows, [
    { trigger: 'start', eligible: ['Ann', 'Bo'], odds: { Ann: 1.8, Bo: 1.8 } },
    { trigger: 'elimination:Bo', eligible: ['Ann'], odds: { Ann: 1.1 } },
  ]);
});

test('bettingViewFor: splits own accepted bets into myGlobalBets and mySideBets', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  const room = { players: playersMap({ Ann: { userId: 1 }, Bo: { userId: 2 } }) };
  t.mock.method(db, 'query', async () => ({
    rows: [
      { kind: 'global', trigger: 'start', pick_name: 'Ann', stake: 50, odds: '2.7', bettor_user_id: 1, opponent_user_id: null },
      { kind: 'side', trigger: null, pick_name: 'Bo', stake: 20, bettor_user_id: 1, opponent_user_id: 2 },
    ],
  }));
  const view = await betting.bettingViewFor(room, 'ABCD', 'Ann');
  assert.deepEqual(view.myGlobalBets, [{ trigger: 'start', pick: 'Ann', stake: 50, odds: 2.7 }]);
  assert.deepEqual(view.mySideBets, [{ pick: 'Bo', stake: 20, role: 'bettor', opponentName: 'Bo' }]);
});

test('bettingViewFor: resolves the opponent role/name when the viewer is the one who accepted', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  const room = { players: playersMap({ Ann: { userId: 1 }, Bo: { userId: 2 } }) };
  t.mock.method(db, 'query', async () => ({
    rows: [{ kind: 'side', trigger: null, pick_name: 'Cy', stake: 20, bettor_user_id: 1, opponent_user_id: 2 }],
  }));
  const view = await betting.bettingViewFor(room, 'ABCD', 'Bo');
  assert.deepEqual(view.mySideBets, [{ pick: 'Cy', stake: 20, role: 'opponent', opponentName: 'Ann' }]);
});

test('bettingViewFor: mySideProposal and incomingSideOffers (open and targeted)', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  t.mock.method(db, 'query', async (text) => (/SELECT balance/.test(text) ? { rows: [{ balance: 500 }] } : { rows: [] }));
  const room = { players: playersMap({ Ann: { userId: 1 }, Bo: { userId: 2 }, Cy: { userId: 3 } }) };
  await betting.proposeSideBet(room, 'ABCD', {
    roundNumber: 1, bettorName: 'Bo', userId: 2, pick: 'Ann', stake: 20, targetName: null, eligible: ['Ann', 'Cy'],
  });
  await betting.proposeSideBet(room, 'ABCD', {
    roundNumber: 1, bettorName: 'Cy', userId: 3, pick: 'Ann', stake: 15, targetName: 'Ann', eligible: ['Ann', 'Bo'],
  });

  const annView = await betting.bettingViewFor(room, 'ABCD', 'Ann');
  assert.equal(annView.mySideProposal, null);
  assert.deepEqual(
    annView.incomingSideOffers.map((o) => o.bettorName).sort(),
    ['Bo', 'Cy'],
    'Ann sees both: Bo\'s open offer and Cy\'s offer targeted at her'
  );

  const boView = await betting.bettingViewFor(room, 'ABCD', 'Bo');
  assert.equal(boView.mySideProposal.pick, 'Ann');
  assert.deepEqual(boView.incomingSideOffers, [], 'Cy\'s offer is targeted at Ann, not Bo - and Bo cannot see his own');
});

test('bettingViewFor: visibleOthersBets is empty when the viewer is not a spectator', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  const room = { players: playersMap({ Ann: { userId: 1 }, Bo: { userId: 2 } }) };
  t.mock.method(db, 'query', async () => ({ rows: [] }));
  const view = await betting.bettingViewFor(room, 'ABCD', 'Ann', { isSpectator: false, othersToReveal: ['Bo'] });
  assert.deepEqual(view.visibleOthersBets, []);
});

test('bettingViewFor: a spectator sees other eliminated players\' bets, but not their own again', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  const room = { players: playersMap({ Ann: { userId: 1 }, Bo: { userId: 2 }, Cy: { userId: 3 } }) };
  t.mock.method(db, 'query', async (text) => {
    if (/SELECT balance/.test(text)) return { rows: [] };
    // The "others" query uses = ANY($2) on an array of userIds; the "my bets" query
    // compares a single userId with OR - distinguish on that rather than call order.
    if (/= ANY/.test(text)) {
      return {
        rows: [
          { kind: 'global', trigger: 'start', pick_name: 'Bo', stake: 50, bettor_user_id: 2, opponent_user_id: null },
          { kind: 'side', trigger: null, pick_name: 'Cy', stake: 10, bettor_user_id: 3, opponent_user_id: 1 },
        ],
      };
    }
    return { rows: [] }; // Ann has no bets of her own in this scenario.
  });
  const view = await betting.bettingViewFor(room, 'ABCD', 'Ann', { isSpectator: true, othersToReveal: ['Bo', 'Cy'] });
  assert.deepEqual(view.myGlobalBets, []);
  assert.deepEqual(view.mySideBets, []);
  // The Cy-vs-Ann side bet is skipped here since Ann (the viewer) is a side of it.
  assert.deepEqual(view.visibleOthersBets, [
    { kind: 'global', pick: 'Bo', stake: 50, bettorName: 'Bo', opponentName: null },
  ]);
});
