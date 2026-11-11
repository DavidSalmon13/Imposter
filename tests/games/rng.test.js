'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { mulberry32, hashSeed, rngFor, randomSeed } = require('../../server/lib/rng');

function take(rng, n) {
  return Array.from({ length: n }, () => rng());
}

test('rngFor: same seed + tick gives the same sequence', () => {
  assert.deepEqual(take(rngFor(12345, 7), 50), take(rngFor(12345, 7), 50));
});

test('rngFor: a different tick gives a different sequence', () => {
  assert.notDeepEqual(take(rngFor(12345, 7), 10), take(rngFor(12345, 8), 10));
  assert.notDeepEqual(take(rngFor(12345, 0), 10), take(rngFor(12346, 0), 10));
});

test('rngFor: neighbouring ticks are not shifted copies of each other', () => {
  const a = take(rngFor(1, 0), 20);
  const b = take(rngFor(1, 1), 20);
  for (const x of b) assert.ok(!a.includes(x));
});

test('rng output is in [0, 1) and roughly uniform', () => {
  const rng = rngFor(99, 3);
  const buckets = new Array(10).fill(0);
  for (let i = 0; i < 20000; i++) {
    const x = rng();
    assert.ok(x >= 0 && x < 1, `out of range: ${x}`);
    buckets[Math.floor(x * 10)]++;
  }
  for (const c of buckets) assert.ok(c > 1700 && c < 2300, `bucket count ${c}`);
});

test('mulberry32 is deterministic and hashSeed is a 32-bit uint', () => {
  assert.deepEqual(take(mulberry32(42), 5), take(mulberry32(42), 5));
  const h = hashSeed(0xffffffff, 123456);
  assert.ok(Number.isInteger(h) && h >= 0 && h < 2 ** 32);
});

test('randomSeed returns a 32-bit uint', () => {
  const s = randomSeed();
  assert.ok(Number.isInteger(s) && s >= 0 && s < 2 ** 32);
});
