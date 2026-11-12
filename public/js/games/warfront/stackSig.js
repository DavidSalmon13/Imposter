/**
 * Warfront client: pure helpers that decide when a unit stack must be rebuilt and how its
 * per-soldier HP reads. A stack is rebuilt only when its make-up changes (types and counts,
 * selection, a carried load); HP changes repaint the existing bar in place.
 * Must NOT contain: DOM, store reads or imports (tests import it under node --test).
 * Spec: "Game feel" (stacks update in place, soldier HP). Mockup: 2-battlefield.html squads.
 */

/** At most this many HP segments on a stack's bar (lowest HP first); the console lists the rest. */
export const MAX_HP_SEGMENTS = 8;

/** Colour class for one soldier's HP fraction: green ≥ 75%, amber ≥ 35%, red below. */
export function hpClass(f) {
  return f >= 0.75 ? 'hp-g' : f >= 0.35 ? 'hp-y' : 'hp-r';
}

/** One soldier's HP as a fraction of its max, clamped to 0..1. */
export function hpFraction(u, maxHp) {
  const max = maxHp[u.type] || u.hp || 1;
  return Math.max(0, Math.min(1, u.hp / max));
}

/** What a stack is made of. When this changes the stack is rebuilt; HP is deliberately left out. */
export function makeupSig(units, team, { selected = false, loaded = false } = {}) {
  const counts = new Map();
  units.forEach((u) => counts.set(u.type, (counts.get(u.type) || 0) + 1));
  return `${team}|${[...counts.entries()].sort().join(',')}|${selected ? 1 : 0}|${loaded ? 1 : 0}`;
}

/** Each soldier's HP fraction, lowest first, capped at `cap` (the stack bar's segments). */
export function hpSegments(units, maxHp, cap = MAX_HP_SEGMENTS) {
  return units.map((u) => hpFraction(u, maxHp)).sort((a, b) => a - b).slice(0, cap);
}

/** A short key for the segments, so an unchanged bar isn't repainted. */
export function hpSig(segments) {
  return segments.map((f) => Math.round(f * 100)).join(',');
}
