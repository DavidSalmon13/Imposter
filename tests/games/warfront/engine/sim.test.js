'use strict';

// Warfront engine tests: stepSim determinism.
// Exercises server/games/warfront/engine/sim.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeBattle, run, move } = require('../fixtures');

test('the same orders and seed give the same world (no hidden clock or randomness)', () => {
  const play = () => {
    const b = makeBattle({
      rows: ['R..f..h..~', '.........B', '...#......'],
      units: [{ owner: 'Red', type: 'raider', at: [0, 1] }, { owner: 'Blue', type: 'outrider', at: [9, 1] }],
    });
    move(b.st, 'Red', [b.unit('Red').id], b.at(8, 2), 0);
    move(b.st, 'Blue', [b.unit('Blue').id], b.at(0, 0), 0);
    run(b.st, 0, 3000);
    move(b.st, 'Red', [b.unit('Red').id], b.at(2, 0), 3000);
    run(b.st, 3000, 12000);
    return JSON.stringify(b.st);
  };
  assert.equal(play(), play());
});
