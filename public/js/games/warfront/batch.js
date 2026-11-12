/**
 * Warfront client: pure maths for the ×5 recruit switch. How many of one unit fit in a batch
 * given your Supply, Minerals and room under the unit cap, and what stops the batch short.
 * Must NOT contain: DOM, store reads or imports (tests import it under node --test).
 * Spec: "Game feel" (bulk actions). Plan Step 23.
 */

export const BATCH_SIZE = 5;

/**
 * How many units costing `cost` ({ supply, minerals, slots }) you can queue right now, up to
 * `want`, and why it stops there: 'supply' | 'minerals' | 'cap' | null (got them all).
 * `me` is the snapshot's own economy ({ supply, minerals, units, unitCap }).
 */
export function batchFit(me, cost, want = BATCH_SIZE) {
  let supply = me.supply;
  let minerals = me.minerals;
  let room = me.unitCap - me.units;
  const slots = cost.slots || 1;
  for (let n = 0; n < want; n++) {
    if (room < slots) return { n, short: 'cap' };
    if (supply < (cost.supply || 0)) return { n, short: 'supply' };
    if (minerals < (cost.minerals || 0)) return { n, short: 'minerals' };
    supply -= cost.supply || 0;
    minerals -= cost.minerals || 0;
    room -= slots;
  }
  return { n: want, short: null };
}

/** The notice after a short batch, e.g. "Recruited 3 of 5 · not enough 🔩". */
export function batchNotice(n, want, short) {
  const why = { supply: 'not enough 🔩', minerals: 'not enough 💎', cap: 'army is at the unit cap' }[short];
  return `Recruited ${n} of ${want}${why ? ` · ${why}` : ''}`;
}
