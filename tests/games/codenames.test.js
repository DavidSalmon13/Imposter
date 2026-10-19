'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const codenames = require('../../server/games/codenames');
const {
  createTestCtx,
  createRoom,
  makeHandlerSocket,
  registerGame,
  call,
  mockOpenAi,
  flush,
} = require('../helpers/harness');

function setupTeamSelectRoom() {
  const { ctx, io } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Red1', 'Red2', 'Blue1', 'Blue2'], {
    game: 'codenames',
    phase: 'teamSelect',
  });
  room.players.get('Red1').team = 'red';
  room.players.get('Red1').leader = true;
  room.players.get('Red2').team = 'red';
  room.players.get('Blue1').team = 'blue';
  room.players.get('Blue1').leader = true;
  room.players.get('Blue2').team = 'blue';
  return { ctx, io, room };
}

test('contract shape', () => {
  assert.equal(codenames.id, 'codenames');
  assert.equal(codenames.minPlayers, 4);
  assert.ok(codenames.savedFields.includes('cnBankPickCount'));
});

test('claimLeader: second claim on an already-led team is rejected', async () => {
  const { ctx, room } = setupTeamSelectRoom();
  const socket = registerGame(codenames, ctx, makeHandlerSocket('AAAA', 'Red2'));
  const res = await call(socket, 'claimLeader');
  assert.equal(res.ok, false);
  assert.equal(room.players.get('Red2').leader, false);
});

test('setCnBankPickCount: host-only, clamped to [0, CN_BANK_PICK_MAX]', async () => {
  const { ctx, room } = setupTeamSelectRoom();
  const hostSocket = registerGame(codenames, ctx, makeHandlerSocket('AAAA', room.hostName));
  const otherSocket = registerGame(codenames, ctx, makeHandlerSocket('AAAA', 'Blue2'));

  const rejected = await call(otherSocket, 'setCnBankPickCount', 3);
  assert.equal(rejected.ok, false);

  const tooHigh = await call(hostSocket, 'setCnBankPickCount', 999);
  assert.equal(tooHigh.ok, true);
  assert.equal(room.cnBankPickCount, 10);

  const negative = await call(hostSocket, 'setCnBankPickCount', -5);
  assert.equal(negative.ok, true);
  assert.equal(room.cnBankPickCount, 0);
});

test('addCnNameBankWord: trims, dedupes case-insensitively, enforces length', async () => {
  const { ctx, room } = setupTeamSelectRoom();
  const socket = registerGame(codenames, ctx, makeHandlerSocket('AAAA', 'Blue2'));

  const first = await call(socket, 'addCnNameBankWord', '  Dragon  ');
  assert.equal(first.ok, true);
  assert.deepEqual(room.cnNameBank, ['Dragon']);

  const dup = await call(socket, 'addCnNameBankWord', 'dragon');
  assert.equal(dup.ok, false);

  const empty = await call(socket, 'addCnNameBankWord', '   ');
  assert.equal(empty.ok, false);
});

test('startCodenames: rejects non-host and invalid teams', async () => {
  const { ctx, room } = setupTeamSelectRoom();
  const nonHost = registerGame(codenames, ctx, makeHandlerSocket('AAAA', 'Red2'));
  const rejected = await call(nonHost, 'startCodenames');
  assert.equal(rejected.ok, false);

  room.players.get('Blue1').leader = false; // blue now has no leader
  const hostSocket = registerGame(codenames, ctx, makeHandlerSocket('AAAA', room.hostName));
  const invalidTeam = await call(hostSocket, 'startCodenames');
  assert.equal(invalidTeam.ok, false);
});

test('startCodenames: builds a 25-word board mixing in the requested bank-pick count', async () => {
  const { ctx, room } = setupTeamSelectRoom();
  room.cnNameBank = ['Bank1', 'Bank2', 'Bank3', 'Bank4', 'Bank5'];
  room.cnBankPickCount = 3;

  const hostSocket = registerGame(codenames, ctx, makeHandlerSocket('AAAA', room.hostName));
  const aiWords = Array.from({ length: 22 }, (_, i) => `Ai${i}`);
  const restore = mockOpenAi({ words: aiWords });
  try {
    const res = await call(hostSocket, 'startCodenames');
    assert.equal(res.ok, true);
    await flush();
  } finally {
    restore();
  }

  assert.equal(room.phase, 'playing');
  assert.equal(room.cnBoard.length, 25);
  const boardWords = room.cnBoard.map((c) => c.word);
  const bankWordsOnBoard = boardWords.filter((w) => room.cnNameBank.includes(w));
  assert.equal(bankWordsOnBoard.length, 3, 'exactly 3 bank words should be mixed in');

  const counts = { red: 0, blue: 0, assassin: 0, neutral: 0 };
  for (const cell of room.cnBoard) counts[cell.color] += 1;
  const otherTeam = room.cnStartingTeam === 'red' ? 'blue' : 'red';
  assert.equal(counts[room.cnStartingTeam], 8, 'starting team gets 8 cards');
  assert.equal(counts[otherTeam], 7, 'other team gets 7 cards');
  assert.equal(counts.assassin, 1);
  assert.equal(counts.neutral, 9);
});

test('guessWord: assassin tile ends the game for the other team', async () => {
  const { ctx, room } = setupTeamSelectRoom();
  room.phase = 'playing';
  room.cnActiveTeam = 'red';
  room.cnStartingTeam = 'red';
  room.cnScores = { red: 0, blue: 0 };
  room.cnBoard = [
    { word: 'Boom', color: 'assassin', revealed: false },
    { word: 'Other', color: 'red', revealed: false },
  ];

  const socket = registerGame(codenames, ctx, makeHandlerSocket('AAAA', 'Red2'));
  const res = await call(socket, 'guessWord', 0);
  assert.equal(res.ok, true);
  assert.equal(room.cnWinner, 'blue');
  assert.equal(room.phase, 'gameover');
});

test('guessWord: leaders cannot guess, and guessing the wrong team color passes the turn', async () => {
  const { ctx, room } = setupTeamSelectRoom();
  room.phase = 'playing';
  room.cnActiveTeam = 'red';
  room.cnBoard = [
    { word: 'Theirs', color: 'blue', revealed: false },
    { word: 'Ours', color: 'red', revealed: false },
  ];

  const leaderSocket = registerGame(codenames, ctx, makeHandlerSocket('AAAA', 'Red1'));
  const leaderRes = await call(leaderSocket, 'guessWord', 1);
  assert.equal(leaderRes.ok, false);

  const guesserSocket = registerGame(codenames, ctx, makeHandlerSocket('AAAA', 'Red2'));
  const res = await call(guesserSocket, 'guessWord', 0);
  assert.equal(res.ok, true);
  assert.equal(room.cnBoard[0].revealed, true);
  assert.equal(room.cnActiveTeam, 'blue', 'wrong-color guess passes the turn');
});

test('onChoose starts teamSelect and broadcasts it', () => {
  const { ctx, io } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob', 'Cid', 'Dee'], { game: null, phase: 'lobby' });
  codenames.onChoose(ctx, 'AAAA', room);
  assert.equal(room.phase, 'teamSelect');
  const broadcasts = io.emissions.filter((e) => e.target === 'AAAA' && e.event === 'teamSelectUpdate');
  assert.equal(broadcasts.length, 1);
});
