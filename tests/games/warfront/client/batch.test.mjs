// Warfront client: the ×5 recruit switch's maths (public/js/games/warfront/batch.js). Plan Step 23.
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchFit, batchNotice, BATCH_SIZE } from '../../../../public/js/games/warfront/batch.js';

const me = (supply, minerals, units = 0, unitCap = 30) => ({ supply, minerals, units, unitCap });
const militia = { supply: 3, minerals: 0, slots: 1 };

test('enough of everything: the whole batch', () => {
  assert.deepEqual(batchFit(me(100, 0), militia), { n: BATCH_SIZE, short: null });
});

test('Supply for three: three, short on supply', () => {
  assert.deepEqual(batchFit(me(9.5, 0), militia), { n: 3, short: 'supply' });
});

test('Minerals run out before Supply', () => {
  assert.deepEqual(batchFit(me(100, 5), { supply: 4, minerals: 2, slots: 1 }), { n: 2, short: 'minerals' });
});

test('never goes over the unit cap, counting multi-slot units', () => {
  assert.deepEqual(batchFit(me(100, 100, 28), militia), { n: 2, short: 'cap' });
  assert.deepEqual(batchFit(me(100, 100, 25), { supply: 6, minerals: 0, slots: 2 }), { n: 2, short: 'cap' });
});

test('nothing affordable: zero, with the reason', () => {
  assert.deepEqual(batchFit(me(2, 0), militia), { n: 0, short: 'supply' });
});

test('the notice names the reason', () => {
  assert.equal(batchNotice(3, 5, 'supply'), 'Recruited 3 of 5 · not enough 🔩');
  assert.equal(batchNotice(2, 5, 'cap'), 'Recruited 2 of 5 · army is at the unit cap');
  assert.equal(batchNotice(5, 5, null), 'Recruited 5 of 5');
});
