'use strict';

// Warfront engine tests: Tower garrisons (spec "Towers"). Units that end a walk on a friendly
// Tower climb its roof (up to TUNING.towerGarrison), can't be targeted, ranged ones shoot with
// +towerRangeBonus range, and a fallen Tower drops them hurt. Exercises movement/combat/vision.

const test = require('node:test');
const assert = require('node:assert/strict');

const E = require('../../../../server/games/warfront/engine');
const { TUNING } = require('../../../../server/games/warfront/engine/constants');
const { makeBattle, run, fight, plantBuilt } = require('../fixtures');

const unitsOn = (b, owner, x) => b.st.armies[owner].units.filter((u) => u.tileId === b.at(x, 0) && u.type !== 'tower');

function towerBattle(redUnits, blueUnits = []) {
  const b = makeBattle({
    rows: ['R..........B'],
    units: [
      ...redUnits.map((type, i) => ({ owner: 'Red', type, at: [2, 0], hold: true, i })),
      ...blueUnits.map(([type, x]) => ({ owner: 'Blue', type, at: [x, 0], hold: true })),
    ],
  });
  const tower = plantBuilt(b, 'Red', 'tower', 3, 0);
  return { b, tower };
}

const walkOn = (b, units, x, now = 0) => E.applyCommand(b.st, 'Red', { kind: 'move', unitIds: units.map((u) => u.id), toTileId: b.at(x, 0) }, now);

test('towers: up to towerGarrison units climb a friendly Tower; the rest stand at its foot', () => {
  const { b, tower } = towerBattle(['crossbow', 'crossbow', 'crossbow', 'crossbow']);
  assert.ok(walkOn(b, unitsOn(b, 'Red', 2), 3).ok);
  run(b.st, 0, 4000);
  const on = unitsOn(b, 'Red', 3);
  assert.equal(on.length, 4);
  assert.equal(on.filter((u) => u.garrison === tower.id).length, TUNING.towerGarrison);
  // Moving off climbs down.
  const up = on.find((u) => u.garrison);
  E.applyCommand(b.st, 'Red', { kind: 'move', unitIds: [up.id], toTileId: b.at(2, 0) }, 4000);
  assert.equal(up.garrison, null);
});

test('towers: ranged units shoot from the roof with +1 range', () => {
  // A crossbow (range 2) on the roof, a Blue skirmisher 3 tiles out.
  const { b, tower } = towerBattle(['crossbow'], [['skirmisher', 6]]);
  const xbow = unitsOn(b, 'Red', 2)[0];
  walkOn(b, [xbow], 3);
  run(b.st, 0, 3000);
  assert.equal(xbow.garrison, tower.id);
  const events = fight(b, 12000, 3000);
  assert.ok(events.some((e) => e.type === 'underAttack' && e.team === 'blue' && e.by === 'crossbow'), 'shoots 3 tiles from the roof');
});

test('towers: nobody can hit the garrison; enemies have to knock the Tower down', () => {
  const { b, tower } = towerBattle(['crossbow'], [['warrior', 4]]);
  const xbow = unitsOn(b, 'Red', 2)[0];
  walkOn(b, [xbow], 3);
  run(b.st, 0, 3000);
  assert.equal(xbow.garrison, tower.id);
  const events = fight(b, 9000, 3000);
  assert.equal(events.filter((e) => e.type === 'underAttack' && e.unitId === xbow.id).length, 0);
  assert.ok(events.some((e) => e.type === 'underAttack' && e.unitId === tower.id), 'the warrior hits the tower instead');
});

test('towers: melee in a garrison hides instead of fighting', () => {
  const { b, tower } = towerBattle(['militiaman'], [['warrior', 4]]);
  const m = unitsOn(b, 'Red', 2)[0];
  walkOn(b, [m], 3);
  run(b.st, 0, 3000);
  assert.equal(m.garrison, tower.id);
  const events = fight(b, 8000, 3000);
  assert.ok(!events.some((e) => e.by === 'militiaman'));
  assert.ok(!events.some((e) => e.unitId === m.id && e.type === 'underAttack'));
});

test('towers: when the Tower falls, its garrison drops to the ground hurt but alive', () => {
  const { b, tower } = towerBattle(['militiaman']);
  const m = unitsOn(b, 'Red', 2)[0];
  walkOn(b, [m], 3);
  run(b.st, 0, 3000);
  const full = m.hp;
  tower.hp = 0.01;
  b.st.armies.Blue.units.push(E.makeUnit(b.st.nextUnitId++, 'warrior', 'Blue', b.at(4, 0)));
  b.st.armies.Blue.units.at(-1).holding = true;
  const events = fight(b, 5000, 3000);
  assert.ok(events.some((e) => e.type === 'towerFall' && e.unitId === m.id));
  assert.equal(m.garrison, null);
  assert.ok(m.hp < full && m.hp > 0);
});

test('towers: a finished Tower sees one tile further than a unit', () => {
  const { b } = towerBattle([]);
  const far = b.at(3 + 2 + TUNING.towerVisionBonus, 0);
  assert.ok(E.visionFor(b.st, 'red').has(far));
});
