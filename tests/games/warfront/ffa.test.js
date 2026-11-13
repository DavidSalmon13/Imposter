'use strict';

// Warfront shell tests: free-for-all knock-outs, points and history (spec "Free-for-all mode",
// plan Step 27). Exercises loop.js (tickRoom, awardWfScores), handlers.js (wfCommand) and the
// per-socket wfLive fan-out. The FFA lobby (mode switch, start) arrives in Step 28, so the battle
// is put in place directly.

const test = require('node:test');
const assert = require('node:assert/strict');

const warfront = require('../../../server/games/warfront');
const engine = require('../../../server/games/warfront/engine');
const { rngFor } = require('../../../server/lib/rng');
const { call } = require('../../helpers/harness');
const { setup, wfLives } = require('./shellFixtures');

test.afterEach(() => {
  for (const code of [...warfront.wfLoops.keys()]) warfront.stopLoop(code);
});

/** Host (red), Ann (blue) and Bob (green) in a 3-side free-for-all battle that is playing. */
function ffaRoom() {
  const s = setup({ names: ['Host', 'Ann', 'Bob'] });
  const roster = [['Host', 'red', 'forge'], ['Ann', 'blue', 'horde'], ['Bob', 'green', 'arcane']]
    .map(([name, team, race]) => ({ name, team, race }));
  const map = engine.fallbackFfa('medium', rngFor(4, 0), 3);
  Object.assign(s.room.state.warfront, engine.createBattleState(map, roster, { seed: 4, now: Date.now() }));
  s.room.phase = 'playing';
  return s;
}

const lastLive = (s, name) => wfLives(s.io, s.room, name).at(-1).payload;

test('FFA: a fallen side is out, watches with the fog lifted and cannot command; the match goes on', async () => {
  const s = ffaRoom();
  const wf = s.room.state.warfront;
  const annWorker = wf.armies.Ann.units[0].id;
  wf.bases.blue.hp = 0;
  warfront.tickRoom(s.ctx, 'WFWF');

  assert.equal(s.room.phase, 'playing');
  assert.equal(wf.winner, null);
  assert.deepEqual(wf.armies.Ann.units, []);
  assert.deepEqual(wf.placings, [{ side: 'blue', place: 3 }]);

  const ann = lastLive(s, 'Ann');
  assert.equal(ann.out, true);
  assert.ok(/^1+$/.test(ann.visible), 'the whole map is visible');
  assert.ok(ann.units.some((u) => u.owner === 'Bob') && ann.units.some((u) => u.owner === 'Host'));
  assert.equal(lastLive(s, 'Host').out, undefined);
  assert.ok(!lastLive(s, 'Host').units.some((u) => u.owner === 'Bob'), "Host still can't see Bob's far corner");

  const res = await call(s.sockets.Ann, 'wfCommand', { kind: 'hold', unitIds: [annWorker] });
  assert.equal(res.ok, false);
  assert.match(res.error, /out of this battle/);
  const bob = await call(s.sockets.Bob, 'wfCommand', { kind: 'hold', unitIds: [wf.armies.Bob.units[0].id] });
  assert.equal(bob.ok, true);
});

test('FFA: the last side standing wins; points 3 / 1 / 0 and history by side', () => {
  const s = ffaRoom();
  const wf = s.room.state.warfront;
  wf.bases.blue.hp = 0;
  warfront.tickRoom(s.ctx, 'WFWF');
  wf.bases.green.hp = 0;
  warfront.tickRoom(s.ctx, 'WFWF');

  assert.equal(s.room.phase, 'gameover');
  assert.equal(wf.winner, 'red');
  assert.deepEqual(s.room.scoreboard, { Host: 3, Bob: 1 });
  assert.equal(s.recordedResults.length, 1);
  assert.deepEqual(
    [...s.recordedResults[0].participants].sort((a, b) => a.name.localeCompare(b.name)),
    [
      { name: 'Ann', team: 'blue', won: false, points: 0 },
      { name: 'Bob', team: 'green', won: false, points: 1 },
      { name: 'Host', team: 'red', won: true, points: 3 },
    ],
  );
});

test('FFA: the last bases falling together share 1st, 2 points each', () => {
  const s = ffaRoom();
  const wf = s.room.state.warfront;
  wf.bases.blue.hp = 0;
  warfront.tickRoom(s.ctx, 'WFWF');
  wf.bases.red.hp = 0;
  wf.bases.green.hp = 0;
  warfront.tickRoom(s.ctx, 'WFWF');

  assert.equal(wf.winner, 'draw');
  assert.deepEqual(s.room.scoreboard, { Host: 2, Bob: 2 });
  const won = s.recordedResults[0].participants.filter((p) => p.won).map((p) => p.name).sort();
  assert.deepEqual(won, ['Bob', 'Host']);
});

test('FFA: at the match cap survivors are placed by base HP', () => {
  const s = ffaRoom();
  const wf = s.room.state.warfront;
  wf.bases.red.hp = 40;
  wf.bases.blue.hp = 90;
  wf.bases.green.hp = 60;
  wf.clock.matchEndsAt = Date.now() - 1;
  warfront.tickRoom(s.ctx, 'WFWF');

  assert.equal(wf.winner, 'blue');
  assert.deepEqual(s.room.scoreboard, { Ann: 3, Bob: 1 });
});
