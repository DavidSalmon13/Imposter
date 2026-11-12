'use strict';

// Warfront engine tests: move orders, pickups on arrival, hold.
// Exercises server/games/warfront/engine/systems/movement.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const E = require('../../../../server/games/warfront/engine');
const { makeBattle, run, move, fight } = require('../fixtures');

test('move: walks around water, one tile at a time, and stops on the target', () => {
  const b = makeBattle({
    rows: [
      'R.~..',
      '..~..',
      '....B',
    ],
    units: [{ owner: 'Red', type: 'warrior', at: [0, 0] }],
  });
  const w = b.unit('Red');
  assert.deepEqual(move(b.st, 'Red', [w.id], b.at(3, 0), 0), { ok: true, moved: 1 });
  // Shortest way round the water: down to row 2, across, back up. 7 steps.
  assert.equal(w.path.length, 7);
  const visited = [];
  for (let now = 200; now <= 7 * E.WF_STEP_MS_BASE + 200; now += 200) {
    E.stepSim(b.st, 200, { now });
    if (visited[visited.length - 1] !== w.tileId) visited.push(w.tileId);
  }
  assert.equal(w.tileId, b.at(3, 0));
  assert.deepEqual(w.path, []);
  assert.equal(w.stepEndsAt, 0);
  for (const t of visited) assert.ok(E.isPassable(b.st.map, t));
  assert.ok(visited.includes(b.at(2, 2)), 'crossed below the water');
});

test('move: a forest step takes twice as long as a plains step', () => {
  const b = makeBattle({
    rows: ['R.f..B'],
    units: [{ owner: 'Red', type: 'warrior', at: [1, 0] }, { owner: 'Red', type: 'warrior', at: [3, 0] }],
  });
  const [onPlains, beforeForest] = b.st.armies.Red.units;
  assert.equal(E.stepMs(b.st.map, 'warrior', b.at(4, 0)), E.WF_STEP_MS_BASE);
  assert.equal(E.stepMs(b.st.map, 'warrior', b.at(2, 0)), 2 * E.WF_STEP_MS_BASE);
  move(b.st, 'Red', [onPlains.id], b.at(2, 0), 0); // into the forest
  move(b.st, 'Red', [beforeForest.id], b.at(4, 0), 0); // onto plains
  const P = E.WF_STEP_MS_BASE;
  E.stepSim(b.st, 200, { now: P });
  assert.equal(beforeForest.tileId, b.at(4, 0));
  assert.equal(onPlains.tileId, b.at(1, 0), 'still on its way into the forest');
  E.stepSim(b.st, 200, { now: 2 * P - 1 });
  assert.equal(onPlains.tileId, b.at(1, 0));
  E.stepSim(b.st, 1, { now: 2 * P });
  assert.equal(onPlains.tileId, b.at(2, 0));
});

test('move: a Raider (Move 3) walks twice as fast as a Warrior; an Outrider (Move 2) 1.5x (D16)', () => {
  const b = makeBattle({
    rows: ['R........B'],
    units: [{ owner: 'Red', type: 'warrior', at: [0, 0] }, { owner: 'Red', type: 'raider', at: [0, 0] }],
  });
  const [warrior, raider] = b.st.armies.Red.units;
  move(b.st, 'Red', [warrior.id, raider.id], b.at(8, 0), 0);
  assert.equal(E.stepMs(b.st.map, 'raider', b.at(1, 0)), Math.round(E.WF_STEP_MS_BASE / 2));
  assert.equal(E.stepMs(b.st.map, 'outrider', b.at(1, 0)), Math.round(E.WF_STEP_MS_BASE / 1.5));
  run(b.st, 0, 8 * Math.round(E.WF_STEP_MS_BASE / 2) + 200);
  assert.equal(E.tileXY(raider.tileId, 10).x, 8, 'raider: half a Warrior step a tile');
  assert.equal(E.tileXY(warrior.tileId, 10).x, 4, 'warrior: one full step a tile');
  // A Warrior crosses a medium map (14 tiles of plains) in about 40 s (×1.5 speed-up, 2026-11-11).
  assert.ok(Math.abs(14 * E.WF_STEP_MS_BASE - 40000) < 1000);
});

test('move: re-issuing an order repaths; the step in progress finishes first', () => {
  const b = makeBattle({
    rows: [
      '.....',
      'R...B',
      '.....',
    ],
    units: [{ owner: 'Red', type: 'warrior', at: [1, 1] }],
  });
  const w = b.unit('Red');
  move(b.st, 'Red', [w.id], b.at(4, 0), 0);
  run(b.st, 0, 400);
  const next = w.path[0];
  assert.equal(w.tileId, b.at(1, 1));
  assert.deepEqual(move(b.st, 'Red', [w.id], b.at(0, 2), 400), { ok: true, moved: 1 });
  assert.equal(w.path[0], next, 'keeps the tile it is stepping onto');
  assert.equal(w.path[w.path.length - 1], b.at(0, 2));
  run(b.st, 400, 6 * E.WF_STEP_MS_BASE);
  assert.equal(w.tileId, b.at(0, 2));
});

test('move: guards ownership, passability and non-moving units; bad orders change nothing', () => {
  const b = makeBattle({
    rows: ['R.~.B'],
    units: [{ owner: 'Red', type: 'warrior', at: [0, 0] }, { owner: 'Blue', type: 'militiaman', at: [4, 0] }, { owner: 'Blue', type: 'bastion', at: [3, 0] }],
  });
  const w = b.unit('Red');
  const enemy = b.unit('Blue');
  assert.equal(move(b.st, 'Red', [enemy.id], b.at(1, 0), 0).ok, false);
  assert.equal(move(b.st, 'Red', [w.id], b.at(2, 0), 0).ok, false, 'water');
  assert.equal(move(b.st, 'Red', [w.id], 999, 0).ok, false, 'off the map');
  assert.equal(move(b.st, 'Red', [w.id], b.at(4, 0), 0).ok, false, 'unreachable across the water');
  assert.equal(move(b.st, 'Red', [w.id], b.at(0, 0), 0).ok, false, 'already there');
  assert.equal(move(b.st, 'Blue', [b.unit('Blue', 1).id], b.at(4, 0), 0).ok, false, 'a Bastion cannot move');
  assert.equal(move(b.st, 'Red', [], b.at(1, 0), 0).ok, false);
  assert.equal(E.applyCommand(b.st, 'Nobody', { kind: 'move', unitIds: [w.id], toTileId: 1 }, 0).ok, false);
  assert.equal(E.applyCommand(b.st, 'Red', { kind: 'dance' }, 0).ok, false);
  assert.equal(E.applyCommand(b.st, 'Red', null, 0).ok, false);
  assert.deepEqual(w.path, []);
  assert.deepEqual(enemy.path, []);
});

test('move: a stalled loop does not fast-forward units through a backlog of steps', () => {
  const b = makeBattle({ rows: ['R........B'], units: [{ owner: 'Red', type: 'warrior', at: [0, 0] }] });
  const w = b.unit('Red');
  move(b.st, 'Red', [w.id], b.at(8, 0), 0);
  // 30 s pass in one call, clamped to WF_MAX_DT_MS: the unit finishes the step it was
  // on, then only walks what fits in that last second, not 30 s worth of tiles.
  E.stepSim(b.st, 30000, { now: 30000 });
  assert.equal(E.tileXY(w.tileId, 10).x, 1);
  assert.equal(w.stepEndsAt, 30000 - E.WF_MAX_DT_MS + E.WF_STEP_MS_BASE);
});

test('arriving on a weapon token or a mineral drop collects it', () => {
  const b = makeBattle({
    rows: ['R....B'],
    units: [{ owner: 'Red', type: 'warrior', at: [0, 0] }],
    weapons: [[2, 0, 'artillery']],
  });
  b.st.pickups.mineralDrops[b.at(3, 0)] = 3;
  const w = b.unit('Red');
  move(b.st, 'Red', [w.id], b.at(3, 0), 0);
  const events = [];
  for (let now = 200; now <= 3 * E.WF_STEP_MS_BASE + 200; now += 200) events.push(...E.stepSim(b.st, 200, { now }).events);
  assert.deepEqual(b.st.armies.Red.arsenal, ['artillery']);
  assert.deepEqual(b.st.pickups.weapons, []);
  assert.equal(b.st.armies.Red.minerals, 3);
  assert.deepEqual(b.st.pickups.mineralDrops, {});
  assert.deepEqual(events.map((e) => [e.type, e.weaponId || e.minerals]), [['pickup', 'artillery'], ['pickup', 3]]);
});

test('stepSim advances tick and the clock', () => {
  const b = makeBattle({ rows: ['R..B'] });
  E.stepSim(b.st, 200, { now: 200 });
  E.stepSim(b.st, 200, { now: 400 });
  assert.equal(b.st.tick, 2);
  assert.equal(b.st.clock.lastTickAt, 400);
});

test('hold: stops at the end of the current step, clears any march, and a move clears it', () => {
  const b = makeBattle({ rows: ['R........B'], units: [{ owner: 'Red', type: 'warrior', at: [1, 0] }] });
  const w = b.unit('Red');
  move(b.st, 'Red', [w.id], b.at(6, 0), 0);
  assert.deepEqual(E.applyCommand(b.st, 'Red', { kind: 'hold', unitIds: [w.id] }, 100), { ok: true, held: 1 });
  assert.equal(w.holding, true);
  assert.deepEqual(w.path, [b.at(2, 0)]);
  const t = E.WF_STEP_MS_BASE + 2000;
  fight(b, t, 100);
  assert.equal(w.tileId, b.at(2, 0));
  assert.equal(E.viewForPlayer(b.st, 'Red').units[0].holding, true);
  move(b.st, 'Red', [w.id], b.at(4, 0), t);
  assert.equal(w.holding, false);
  assert.equal(E.applyCommand(b.st, 'Red', { kind: 'hold', unitIds: [] }, 0).ok, false);
  assert.equal(E.applyCommand(b.st, 'Blue', { kind: 'hold', unitIds: [w.id] }, 0).ok, false);
});
