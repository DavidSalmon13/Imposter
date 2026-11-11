'use strict';

// Tiny seeded PRNG helpers (no dependencies). Used by the Warfront engine so its
// simulation stays deterministic: step N of a match draws from rngFor(seed, N).

/** mulberry32: returns a function producing floats in [0, 1) from a 32-bit seed. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mixes a match seed and a step counter into one well-spread 32-bit seed. */
function hashSeed(seed, tick) {
  let h = (seed >>> 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = (h ^ Math.imul((tick >>> 0) + 0x632be5ab, 0xc2b2ae35)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0x27d4eb2f) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x165667b1) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

/** The RNG for one simulation step: same (seed, tick) → same sequence. */
function rngFor(seed, tick) {
  return mulberry32(hashSeed(seed, tick));
}

/** A fresh non-deterministic 32-bit seed (called once per match, outside the engine). */
function randomSeed() {
  return Math.floor(Math.random() * 4294967296) >>> 0;
}

module.exports = { mulberry32, hashSeed, rngFor, randomSeed };
