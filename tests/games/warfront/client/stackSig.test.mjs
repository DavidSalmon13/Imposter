// Warfront client: the pure stack helpers (public/js/games/warfront/stackSig.js). When a stack is
// rebuilt (make-up only, never HP) and how its per-soldier HP reads. Plan Steps 16 and 22.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeupSig, hpSegments, hpSig, hpClass, hpFraction, MAX_HP_SEGMENTS,
} from '../../../../public/js/games/warfront/stackSig.js';

const MAX = { warrior: 20, archer: 10 };
const u = (type, hp) => ({ type, hp });

test('make-up sig ignores HP', () => {
  const a = makeupSig([u('warrior', 20), u('warrior', 20)], 'red');
  const b = makeupSig([u('warrior', 3), u('warrior', 11)], 'red');
  assert.equal(a, b);
});

test('make-up sig changes on type, count, team, selection and load', () => {
  const base = [u('warrior', 20), u('archer', 10)];
  const sig = makeupSig(base, 'red');
  assert.notEqual(makeupSig([...base, u('archer', 10)], 'red'), sig);
  assert.notEqual(makeupSig([u('warrior', 20), u('warrior', 10)], 'red'), sig);
  assert.notEqual(makeupSig(base, 'blue'), sig);
  assert.notEqual(makeupSig(base, 'red', { selected: true }), sig);
  assert.notEqual(makeupSig(base, 'red', { loaded: true }), sig);
});

test('make-up sig does not depend on unit order', () => {
  assert.equal(makeupSig([u('warrior', 1), u('archer', 1)], 'red'), makeupSig([u('archer', 1), u('warrior', 1)], 'red'));
});

test('hpFraction clamps and falls back to the unit hp when the max is unknown', () => {
  assert.equal(hpFraction(u('warrior', 10), MAX), 0.5);
  assert.equal(hpFraction(u('warrior', 30), MAX), 1);
  assert.equal(hpFraction(u('warrior', -2), MAX), 0);
  assert.equal(hpFraction(u('golem', 7), MAX), 1);
});

test('hpClass thresholds: green from 75%, amber from 35%, red below', () => {
  assert.equal(hpClass(1), 'hp-g');
  assert.equal(hpClass(0.75), 'hp-g');
  assert.equal(hpClass(0.74), 'hp-y');
  assert.equal(hpClass(0.35), 'hp-y');
  assert.equal(hpClass(0.34), 'hp-r');
});

test('one segment per soldier, lowest first', () => {
  assert.deepEqual(hpSegments([u('warrior', 20), u('archer', 2), u('warrior', 10)], MAX), [0.2, 0.5, 1]);
});

test('segments are capped, keeping the most wounded', () => {
  const units = Array.from({ length: 12 }, (_, i) => u('warrior', 20 - i));
  const segs = hpSegments(units, MAX);
  assert.equal(segs.length, MAX_HP_SEGMENTS);
  assert.equal(segs[0], 9 / 20);
});

test('hpSig changes when one soldier is hurt, not when units swap places', () => {
  const a = hpSig(hpSegments([u('warrior', 20), u('warrior', 10)], MAX));
  assert.equal(a, hpSig(hpSegments([u('warrior', 10), u('warrior', 20)], MAX)));
  assert.notEqual(a, hpSig(hpSegments([u('warrior', 19), u('warrior', 10)], MAX)));
});
