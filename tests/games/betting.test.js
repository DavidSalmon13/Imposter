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
