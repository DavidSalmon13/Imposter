'use strict';

// Warfront engine tests: combat, high ground (D13), under attack (D14).
// Exercises server/games/warfront/engine/systems/combat.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const E = require('../../../../server/games/warfront/engine');
const { makeBattle, move, fight, firstHitDamage, SEEDS, spread, build } = require('../fixtures');

test('combat: rock-paper-scissors decides duels across seeds (melee > mounted, ranged > melee)', () => {
  const duel = (redType, blueType, seed) => {
    const b = makeBattle({
      rows: ['R.........B'],
      units: [{ owner: 'Red', type: redType, at: [4, 0], hold: true }, { owner: 'Blue', type: blueType, at: [5, 0], hold: true }],
    });
    b.st.seed = seed;
    fight(b, 20000);
    return { red: b.st.armies.Red.units.length, blue: b.st.armies.Blue.units.length };
  };
  let meleeWins = 0;
  let rangedWins = 0;
  for (const seed of SEEDS) {
    const a = duel('warrior', 'outrider', seed); // horde melee vs forge mounted
    if (a.red && !a.blue) meleeWins++;
    const c = duel('militiaman', 'crossbow', seed); // melee vs ranged, same race
    if (c.blue && !c.red) rangedWins++;
  }
  assert.ok(meleeWins >= SEEDS.length * 0.95, `melee beat mounted ${meleeWins}/${SEEDS.length}`);
  assert.ok(rangedWins >= SEEDS.length * 0.95, `ranged beat melee ${rangedWins}/${SEEDS.length}`);
});

test('combat: a defender on hills survives longer than the same defender on plains', () => {
  const timeToDie = (terrain) => {
    const b = makeBattle({
      rows: [`R...${terrain}${terrain}....B`],
      units: [
        { owner: 'Red', type: 'warrior', at: [4, 0], hold: true },
        { owner: 'Blue', type: 'militiaman', at: [5, 0], hold: true },
      ],
    });
    for (let now = 200; now <= 30000; now += 200) {
      if (E.stepSim(b.st, 200, { now }).events.some((e) => e.type === 'death' && e.owner === 'Blue')) return now;
    }
    return Infinity;
  };
  assert.ok(timeToDie('h') > timeToDie('.'), `hills ${timeToDie('h')} ms vs plains ${timeToDie('.')} ms`);
});

test('combat: Horde\'s luck swing is narrower than Arcane\'s', () => {
  const shooter = (type) => () => makeBattle({
    rows: ['R...........B'],
    units: [{ owner: 'Red', type, at: [5, 0], hold: true }, { owner: 'Blue', type: 'militiaman', at: [6, 0], hold: true }],
  });
  const horde = spread(firstHitDamage(shooter('warrior'), SEEDS));
  const arcane = spread(firstHitDamage(shooter('apprentice'), SEEDS));
  assert.ok(horde < arcane * 0.75, `horde ${horde.toFixed(3)} vs arcane ${arcane.toFixed(3)}`);
});

test('combat: a team that counters the dominant class hits with no luck at all (strategyEdge = 1)', () => {
  // Red warriors (melee) against a Blue raider (mounted, the only class near them):
  // every Red RPS unit counters it, so the swing is 0 and the hit is exact.
  const dmg = firstHitDamage(() => makeBattle({
    rows: ['R.........B'],
    units: [
      { owner: 'Red', type: 'warrior', at: [4, 0], hold: true },
      { owner: 'Red', type: 'warrior', at: [3, 0], hold: true },
      { owner: 'Blue', type: 'raider', at: [5, 0], hold: true },
    ],
  }), SEEDS.slice(0, 20));
  const exact = Math.round(5 * E.TUNING.rpsCounter * E.TUNING.hordeAtkMult * 100) / 100;
  assert.deepEqual(new Set(dmg), new Set([exact]));
});

test('combat: an Archmage near the shooter halves its luck swing (D6)', () => {
  const build = (withArchmage) => () => makeBattle({
    rows: ['R...........B'],
    units: [
      ...(withArchmage ? [{ owner: 'Red', type: 'archmage', at: [3, 0], hold: true }] : []),
      { owner: 'Red', type: 'apprentice', at: [5, 0], hold: true },
      { owner: 'Blue', type: 'militiaman', at: [7, 0], hold: true },
    ],
  });
  const plain = spread(firstHitDamage(build(false), SEEDS));
  const bent = spread(firstHitDamage(build(true), SEEDS));
  assert.ok(Math.abs(bent / plain - E.TUNING.archmageOwnLuckMult) < 0.1, `ratio ${(bent / plain).toFixed(3)}`);
});

test('combat: a Battlemage hits every enemy on its target\'s tile and none on the next', () => {
  const b = makeBattle({
    rows: ['R.........B'],
    units: [
      { owner: 'Red', type: 'battlemage', at: [4, 0], hold: true },
      { owner: 'Blue', type: 'militiaman', at: [5, 0], hold: true },
      { owner: 'Blue', type: 'militiaman', at: [5, 0], hold: true },
      { owner: 'Blue', type: 'militiaman', at: [6, 0], hold: true },
    ],
  });
  const events = E.stepSim(b.st, 200, { now: 200 }).events;
  const hitIds = events.filter((e) => e.type === 'underAttack' && e.owner === 'Blue').map((e) => e.unitId);
  const [a, c, far] = b.st.armies.Blue.units;
  assert.deepEqual(hitIds.sort(), [a.id, c.id].sort());
  assert.ok(a.hp < E.UNIT_TYPES.militiaman.hp && c.hp < E.UNIT_TYPES.militiaman.hp);
  assert.equal(far.hp, E.UNIT_TYPES.militiaman.hp);
});

test('combat: a contested base takes no damage; once the defender is gone it does', () => {
  const b = makeBattle({
    rows: ['R........B'],
    units: [
      { owner: 'Red', type: 'skirmisher', at: [7, 0], hold: true },
      { owner: 'Blue', type: 'bastion', at: [9, 0] },
    ],
  });
  fight(b, 2000);
  assert.equal(b.st.bases.blue.hp, E.TUNING.baseHp, 'the Bastion on the base tile contests it');
  assert.ok(b.unit('Blue').hp < E.UNIT_TYPES.bastion.hp, 'the Bastion is the target instead');
  b.st.armies.Blue.units = [];
  E.stepSim(b.st, 200, { now: 2200 });
  E.stepSim(b.st, 200, { now: 2400 });
  E.stepSim(b.st, 200, { now: 2600 });
  E.stepSim(b.st, 200, { now: 2800 });
  E.stepSim(b.st, 200, { now: 3000 });
  E.stepSim(b.st, 200, { now: 3200 });
  E.stepSim(b.st, 200, { now: 3400 });
  assert.ok(b.st.bases.blue.hp < E.TUNING.baseHp, 'hit on the next cooldown (attackMs 1500)');
});

test('combat: a base shoots an adjacent raider every baseAttackMs, but never across the cliff', () => {
  const b = makeBattle({ rows: ['R........B'], units: [{ owner: 'Red', type: 'raider', at: [8, 0], hold: true }] });
  const events = fight(b, 3000);
  const fromBase = events.filter((e) => e.type === 'underAttack' && e.owner === 'Red' && e.fromTileId === b.at(9, 0));
  assert.equal(fromBase.length, 2, 'at 200 ms and 1800 ms');
  assert.ok(b.unit('Red').hp < E.UNIT_TYPES.raider.hp);
  assert.ok(events.some((e) => e.type === 'baseHit' && e.team === 'blue'), 'and the raider hits back');

  const high = makeBattle({ rows: ['R.......hB'], units: [{ owner: 'Red', type: 'raider', at: [8, 0], hold: true }] });
  assert.deepEqual(fight(high, 3000), [], 'raider on a hill, base below: nobody reaches');
});

test('combat: siege deals ×3 to a base (a Ballista out-cracks a Crossbow despite less attack)', () => {
  const mean = (type) => {
    const xs = SEEDS.map((seed) => {
      const b = makeBattle({ rows: ['R........B'], units: [{ owner: 'Red', type, at: [7, 0], hold: true }] });
      b.st.seed = seed;
      return E.stepSim(b.st, 200, { now: 200 }).events.find((e) => e.type === 'baseHit').dmg;
    });
    return xs.reduce((a, x) => a + x, 0) / xs.length;
  };
  const ballista = mean('ballista');
  const crossbow = mean('crossbow');
  // 4 atk ×3 vs 5 atk, both ÷ structureDefense: ≈ 8 vs ≈ 3.33.
  assert.ok(Math.abs(ballista - (4 * 3) / E.TUNING.structureDefense) < 0.5, `ballista ${ballista}`);
  assert.ok(Math.abs(crossbow - 5 / E.TUNING.structureDefense) < 0.3, `crossbow ${crossbow}`);
});

test('combat: identical seed and orders give an identical fight; another seed differs', () => {
  const brawl = (seed) => {
    const b = makeBattle({
      rows: ['R..h.....B', '...f..f...', '.....h....'],
      units: [
        { owner: 'Red', type: 'warrior', at: [2, 1] }, { owner: 'Red', type: 'skirmisher', at: [3, 0] },
        { owner: 'Red', type: 'battlemage', at: [2, 2] }, { owner: 'Red', type: 'archmage', at: [1, 1] },
        { owner: 'Blue', type: 'militiaman', at: [7, 1] }, { owner: 'Blue', type: 'crossbow', at: [8, 0] },
        { owner: 'Blue', type: 'outrider', at: [7, 2] }, { owner: 'Blue', type: 'ballista', at: [8, 1] },
      ],
    });
    b.st.seed = seed;
    for (const u of b.st.armies.Red.units) move(b.st, 'Red', [u.id], b.at(6, 1), 0);
    fight(b, 20000);
    return JSON.stringify(b.st);
  };
  assert.equal(brawl(42), brawl(42));
  assert.notEqual(brawl(42), brawl(43));
});

test('combat: a unit at 0 HP dies at once and a loaded Worker drops its cargo', () => {
  const b = makeBattle({
    rows: ['R.........B'],
    units: [{ owner: 'Red', type: 'warchief', at: [4, 0], hold: true }, { owner: 'Blue', type: 'laborer', at: [5, 0], hold: true }],
  });
  b.unit('Blue').hp = 1;
  b.unit('Blue').carrying = 3;
  const events = E.stepSim(b.st, 200, { now: 200 }).events;
  assert.deepEqual(b.st.armies.Blue.units, []);
  assert.deepEqual(b.st.pickups.mineralDrops, { [b.at(5, 0)]: 3 });
  assert.ok(events.some((e) => e.type === 'death' && e.owner === 'Blue' && e.unitType === 'laborer' && e.tileId === b.at(5, 0)));
});

test('combat: a marching unit fires on the way and keeps marching; arrived, it stays put', () => {
  const b = makeBattle({
    rows: ['R.........B', '...........'],
    units: [{ owner: 'Red', type: 'skirmisher', at: [2, 0] }, { owner: 'Blue', type: 'bastion', at: [5, 1] }],
  });
  const s = b.unit('Red');
  move(b.st, 'Red', [s.id], b.at(7, 0), 0);
  const arrive = 5 * E.WF_STEP_MS_BASE + 200;
  const events = fight(b, arrive);
  const shots = events.filter((e) => e.type === 'underAttack' && e.owner === 'Blue');
  assert.ok(shots.length >= 2, 'fired while walking past');
  assert.equal(s.tileId, b.at(7, 0), 'and still arrived');
  assert.deepEqual(s.path, []);
  fight(b, arrive + 3000, arrive);
  assert.equal(s.tileId, b.at(7, 0), 'an idle unit never chases');
});

test('high ground: a Crossbow on a hill hits a target 3 tiles away; on plains it does not', () => {
  const shot = (row) => {
    const b = makeBattle({
      rows: [row],
      units: [{ owner: 'Red', type: 'crossbow', at: [4, 0], hold: true }, { owner: 'Blue', type: 'laborer', at: [7, 0], hold: true }],
    });
    return E.stepSim(b.st, 200, { now: 200 }).events.some((e) => e.type === 'underAttack');
  };
  assert.equal(shot('R...h.......B'), true);
  assert.equal(shot('R...........B'), false);
  const map = { width: 5, height: 1, tiles: ['hills', 'plains', 'plains', 'plains', 'hills'] };
  assert.equal(E.effectiveRange(map, { tileId: 0, range: 2 }, 3), 3, 'down from the hill');
  assert.equal(E.effectiveRange(map, { tileId: 2, range: 2 }, 4), 1, 'up at the hill');
  assert.equal(E.effectiveRange(map, { tileId: 0, range: 2 }, 4), 2, 'hill to hill');
  assert.equal(E.effectiveRange(map, { tileId: 1, range: 1 }, 0), 1, 'melee never changes');
});

test('high ground: a ground Crossbow cannot hit a hill target 2 tiles away, but can at 1', () => {
  const shot = (row, at) => {
    const b = makeBattle({
      rows: [row],
      units: [{ owner: 'Red', type: 'crossbow', at: [4, 0], hold: true }, { owner: 'Blue', type: 'laborer', at: [at, 0], hold: true }],
    });
    return E.stepSim(b.st, 200, { now: 200 }).events.some((e) => e.type === 'underAttack' && e.owner === 'Blue');
  };
  assert.equal(shot('R.....h.....B', 6), false);
  assert.equal(shot('R....h......B', 5), true);
});

test('high ground: melee only fights on its own level (Warrior, Battlemage)', () => {
  const clash = (row, redType = 'warrior') => {
    const b = makeBattle({
      rows: [row],
      units: [{ owner: 'Red', type: redType, at: [4, 0], hold: true }, { owner: 'Blue', type: 'militiaman', at: [5, 0], hold: true }],
    });
    const hits = fight(b, 1000).filter((e) => e.type === 'underAttack');
    return { red: hits.some((e) => e.owner === 'Blue'), blue: hits.some((e) => e.owner === 'Red') };
  };
  assert.deepEqual(clash('R....h.....B'), { red: false, blue: false }, 'warrior below, militiaman on the hill');
  assert.deepEqual(clash('R...hh.....B'), { red: true, blue: true }, 'both up on the hill');
  assert.deepEqual(clash('R...h......B'), { red: false, blue: false }, 'warrior on the hill, militiaman below');
  assert.deepEqual(clash('R....h.....B', 'battlemage'), { red: false, blue: false }, 'range 1 = melee rule');
  assert.equal(clash('R...hh.....B', 'battlemage').red, true);
});

test('under attack: an idle Warrior shot by a Crossbow it cannot reach walks out of range; a holding one stays', () => {
  const setup = (hold) => makeBattle({
    rows: ['R.........B'],
    units: [{ owner: 'Red', type: 'warrior', at: [3, 0], hold }, { owner: 'Blue', type: 'crossbow', at: [5, 0], hold: true }],
  });
  const b = setup(false);
  const w = b.unit('Red');
  w.hp = 100; // tough enough to survive the bolts during its 4.3 s step away
  E.stepSim(b.st, 200, { now: 200 });
  assert.ok(w.hp < 100);
  assert.deepEqual(w.path, [b.at(2, 0)], 'one step west is out of reach');
  const away = E.WF_STEP_MS_BASE + 400;
  fight(b, away, 200);
  const later = fight(b, away + 5000, away).filter((e) => e.type === 'underAttack' && e.owner === 'Red');
  assert.equal(w.tileId, b.at(2, 0));
  assert.equal(w.path.length, 0, 'idle again');
  assert.equal(E.manhattan(w.tileId, b.unit('Blue').tileId, 11), 3);
  assert.deepEqual(later, [], 'no more hits once it left');

  const held = setup(true);
  fight(held, 1000); // one bolt: a second would kill it
  assert.equal(held.unit('Red').tileId, held.at(3, 0));
  assert.deepEqual(held.unit('Red').path, []);
});

test('under attack: a unit that can hit back stays and fights', () => {
  const b = makeBattle({
    rows: ['R.........B'],
    units: [{ owner: 'Red', type: 'warrior', at: [4, 0] }, { owner: 'Blue', type: 'crossbow', at: [5, 0], hold: true }],
  });
  const events = fight(b, 1000);
  assert.deepEqual(b.unit('Red').path, []);
  assert.equal(b.unit('Red').tileId, b.at(4, 0));
  assert.ok(events.some((e) => e.type === 'underAttack' && e.owner === 'Blue'));
});

test('under attack: nowhere to go within fallBackMaxTiles means it stays put', () => {
  const b = makeBattle({
    rows: ['R~~~~~~~~~B', '#~.....~~~#', '#~~~~~~~~~#'],
    units: [{ owner: 'Red', type: 'warrior', at: [4, 1] }, { owner: 'Blue', type: 'skirmisher', at: [6, 1], hold: true }],
  });
  b.st.map.tiles[E.tileId(5, 1, 11)] = 'hills'; // the skirmisher shoots past it; still 2 tiles
  const w = b.unit('Red');
  w.tileId = b.at(4, 1);
  E.stepSim(b.st, 200, { now: 200 });
  // Out of a range-2 shooter's reach within 3 steps along this strip = x <= 3, which is (3,1) or (2,1).
  assert.deepEqual(w.path, [b.at(3, 1)]);
  const boxed = makeBattle({
    rows: ['R~~~~~~~~~B', '#~~~..~~~~#', '#~~~~~~~~~#'],
    units: [{ owner: 'Red', type: 'warrior', at: [4, 1] }, { owner: 'Blue', type: 'skirmisher', at: [5, 1], hold: true }],
  });
  boxed.st.map.tiles[E.tileId(5, 1, 11)] = 'hills';
  E.stepSim(boxed.st, 200, { now: 200 });
  assert.deepEqual(boxed.unit('Red').path, []);
});

test('under attack: a fogged shooter shows in the victim team\'s view for WF_REVEAL_MS, then hides', () => {
  const b = makeBattle({
    rows: ['R....h....B'],
    units: [{ owner: 'Red', type: 'warrior', at: [2, 0] }, { owner: 'Blue', type: 'crossbow', at: [5, 0], hold: true }],
  });
  const xbow = b.unit('Blue');
  b.unit('Red').hp = 100; // survives the bolts while it steps away
  const seen = () => E.viewForPlayer(b.st, 'Red').units.find((u) => u.id === xbow.id);
  assert.equal(seen(), undefined, 'three tiles off: beyond vision');
  E.stepSim(b.st, 200, { now: 200 });
  assert.equal(b.unit('Red').hp < 100, true, 'shot from the hill');
  assert.equal(seen().revealed, true);
  assert.equal(E.viewForPlayer(b.st, 'Red').visible[xbow.tileId], '0', 'the tile itself stays fogged');
  // The warrior falls back out of reach (one 4.3 s step), taking a bolt each second until it's
  // there; the shooter stays revealed until WF_REVEAL_MS after the last one.
  let lastHit = 200;
  const leaves = E.WF_STEP_MS_BASE + 200;
  for (let now = 400; now <= leaves + 200; now += 200) {
    if (E.stepSim(b.st, 200, { now }).events.some((e) => e.type === 'underAttack')) lastHit = now;
  }
  assert.equal(b.unit('Red').tileId, b.at(1, 0));
  const closes = lastHit + E.WF_REVEAL_MS;
  for (let now = leaves + 400; now < closes; now += 200) E.stepSim(b.st, 200, { now });
  assert.ok(seen(), 'still revealed just before the window closes');
  E.stepSim(b.st, 200, { now: closes });
  assert.equal(seen(), undefined);
});

test('combat: hit events name the attacker\'s side (byTeam), so a 3-side client knows who struck', () => {
  const b = makeBattle({
    rows: ['R....G....B'],
    units: [{ owner: 'Green', type: 'warrior', at: [5, 0], hold: true }, { owner: 'Blue', type: 'warrior', at: [6, 0], hold: true }],
  });
  const hits = fight(b, 3000).filter((e) => e.type === 'underAttack');
  assert.ok(hits.some((e) => e.team === 'blue' && e.byTeam === 'green'));
  assert.ok(hits.some((e) => e.team === 'green' && e.byTeam === 'blue'));
});
