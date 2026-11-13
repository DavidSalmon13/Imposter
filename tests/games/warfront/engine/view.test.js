'use strict';

// Warfront engine tests: fog of war and per-player views.
// Exercises server/games/warfront/engine/view.js + vision.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const E = require('../../../../server/games/warfront/engine');
const { makeBattle, move, produce } = require('../fixtures');

test('fog: an enemy 3 tiles away is hidden, at 2 it shows', () => {
  const b = makeBattle({
    rows: ['R.........B'],
    units: [{ owner: 'Red', type: 'warrior', at: [5, 0] }, { owner: 'Blue', type: 'militiaman', at: [8, 0] }],
  });
  const enemy = b.unit('Blue');
  let view = E.viewForPlayer(b.st, 'Red');
  assert.deepEqual(view.units.map((u) => u.owner), ['Red']);
  assert.equal(view.visible[b.at(8, 0)], '0');
  assert.equal(view.visible[b.at(7, 0)], '1');
  enemy.tileId = b.at(7, 0);
  view = E.viewForPlayer(b.st, 'Red');
  assert.deepEqual(view.units.map((u) => u.owner).sort(), ['Blue', 'Red']);
  // The own base also gives vision.
  assert.equal(view.visible[b.at(2, 0)], '1');
  assert.equal(view.visible[b.at(3, 0)], '1', 'from the warrior at x=5');
  // Each side sees its own units no matter what.
  assert.ok(E.viewForPlayer(b.st, 'Blue').units.some((u) => u.owner === 'Blue'));
});

test('fog: an enemy shows only the tile it steps onto, never its destination; own units show the path', () => {
  const b = makeBattle({
    rows: ['R......B'],
    units: [{ owner: 'Red', type: 'warrior', at: [2, 0] }, { owner: 'Blue', type: 'militiaman', at: [4, 0] }],
  });
  move(b.st, 'Blue', [b.unit('Blue').id], b.at(0, 0), 0);
  const seen = E.viewForPlayer(b.st, 'Red').units.find((u) => u.owner === 'Blue');
  assert.equal(seen.nextTileId, b.at(3, 0));
  assert.equal(seen.path, undefined);
  const own = E.viewForPlayer(b.st, 'Blue').units.find((u) => u.owner === 'Blue');
  assert.deepEqual(own.path, [3, 2, 1, 0].map((x) => b.at(x, 0)));
});

test('fog: an enemy hauler\'s carrying is absent outside vision and shown inside it', () => {
  const b = makeBattle({
    rows: ['R.........B'],
    units: [{ owner: 'Red', type: 'warrior', at: [3, 0] }, { owner: 'Blue', type: 'laborer', at: [8, 0] }],
  });
  b.unit('Blue').carrying = 4;
  const enemies = (view) => view.units.filter((u) => u.owner === 'Blue');
  assert.deepEqual(enemies(E.viewForPlayer(b.st, 'Red')), [], 'nothing about the hauler leaks');
  assert.ok(!JSON.stringify(E.viewForPlayer(b.st, 'Red')).includes('"carrying":4'));
  b.unit('Blue').tileId = b.at(5, 0);
  const seen = E.viewForPlayer(b.st, 'Red').units.find((u) => u.owner === 'Blue');
  assert.equal(seen.carrying, 4);
});

test('fog: a spectator with no army sees no units; events are filtered by team and vision', () => {
  const b = makeBattle({
    rows: ['R.........B'],
    units: [{ owner: 'Red', type: 'warrior', at: [1, 0] }, { owner: 'Blue', type: 'militiaman', at: [9, 0] }],
  });
  const view = E.viewForPlayer(b.st, 'Watcher');
  assert.deepEqual(view.units, []);
  assert.equal(view.me, null);
  assert.ok(!view.visible.includes('1'));
  const events = [{ type: 'pickup', tileId: b.at(9, 0), owner: 'Blue', team: 'blue' }];
  assert.deepEqual(E.eventsForPlayer(b.st, 'Red', events), []);
  assert.equal(E.eventsForPlayer(b.st, 'Blue', events).length, 1);
  assert.deepEqual(E.eventsForPlayer(b.st, 'Watcher', events), []);
});

test('view: a player sees only their own Supply rate, Minerals and queues', () => {
  const b = makeBattle({ rows: ['R.....B'], sources: [[1, 0, 'red'], [5, 0, 'blue']], units: [{ owner: 'Red', type: 'peon', at: [1, 0] }] });
  b.st.armies.Red.supply = 10;
  produce(b.st, 'Red', 'warrior', 0);
  produce(b.st, 'Red', 'warrior', 0);
  const me = E.viewForPlayer(b.st, 'Red').me;
  assert.equal(me.supply, 4);
  assert.equal(me.supplyRate, 0, 'nothing delivered yet');
  assert.equal(me.units, 3);
  assert.equal(me.unitCap, E.WF_MAX_UNITS_PER_PLAYER);
  const T = 3 * E.TUNING.buildMsPerCost;
  assert.deepEqual(me.queues, [{ tileId: b.at(0, 0), items: [
    { unitType: 'warrior', startedAt: 0, doneAt: T },
    { unitType: 'warrior', startedAt: T, doneAt: 2 * T },
  ] }]);
  const blue = E.viewForPlayer(b.st, 'Blue');
  assert.deepEqual(blue.me.queues, []);
  assert.equal(blue.me.supply, E.TUNING.startSupply);
  assert.ok(!JSON.stringify(blue).includes('"queues":[{'), 'no trace of Red\'s queue');
});

test('finalView: every unit with the fog lifted, plus each player\'s stats', () => {
  const b = makeBattle({
    rows: ['R........B'],
    units: [
      { owner: 'Red', type: 'warrior', at: [1, 0] },
      { owner: 'Blue', type: 'crossbow', at: [8, 0] },
    ],
  });
  b.st.armies.Red.stats.kills = 3;
  const fogged = E.viewForPlayer(b.st, 'Red');
  assert.ok(!fogged.units.some((u) => u.owner === 'Blue'), 'the Crossbow is fogged mid-match');
  const v = E.finalView(b.st);
  assert.deepEqual(v.units.map((u) => u.owner).sort(), ['Blue', 'Red']);
  assert.ok(v.units.every((u) => !('path' in u)));
  assert.equal(v.visible, '1'.repeat(10));
  assert.deepEqual(v.stats.find((s) => s.name === 'Red'), { name: 'Red', team: 'red', race: 'horde', kills: 3, lost: 0, baseDmg: 0 });
});
