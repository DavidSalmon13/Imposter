'use strict';

/**
 * Shared test harness for server/games/*.js modules. Builds a ctx matching the real one
 * server.js passes into every game module (server.js:112), but backed by an in-memory fake
 * `io` instead of a real socket.io Server, so handlers can be driven directly and their
 * broadcasts inspected without spinning up a socket/network stack.
 */

const roomStore = require('../../server/roomStore');
const { connectedNames, scoreboardEntries, addScore } = require('../../server/lobby');

function makeFakeIo() {
  const emissions = []; // { target, event, payload }
  function to(target) {
    return {
      emit(event, payload) {
        emissions.push({ target, event, payload });
      },
    };
  }
  return { to, emissions };
}

/**
 * Fresh ctx + fake io for one test. Rebinds roomStore's module-level io/rooms singleton
 * (roomStore.initRoomStore / roomStore.rooms) so ctx.getRoom/ctx.roomEmit behave exactly like
 * production. Call this once per test (or per `t.beforeEach`) - it clears roomStore.rooms.
 */
function createTestCtx() {
  const io = makeFakeIo();
  roomStore.initRoomStore(io);
  roomStore.rooms.clear();

  const recordedResults = [];

  const ctx = {
    rooms: roomStore.rooms,
    roomEmit: roomStore.roomEmit,
    io,
    getRoom: roomStore.getRoom,
    connectedNames,
    scoreboardEntries,
    addScore,
    recordGameResult(room, gameType, participants) {
      recordedResults.push({ room, gameType, participants });
    },
  };

  return { ctx, io, recordedResults };
}

function addPlayer(room, name, overrides = {}) {
  room.players.set(name, {
    socketId: `sock-${name}`,
    connected: true,
    role: null,
    word: null,
    hint: null,
    vote: null,
    team: null,
    leader: false,
    eliminatedReport: null,
    ...overrides,
  });
}

/** Creates a room in ctx.rooms with `names` joined and connected; hostName defaults to names[0]. */
function createRoom(ctx, code, names, { game = null, phase = 'lobby', hostName } = {}) {
  const room = roomStore.createRoomState();
  room.hostName = hostName !== undefined ? hostName : names[0] || null;
  room.game = game;
  room.phase = phase;
  names.forEach((n) => addPlayer(room, n));
  ctx.rooms.set(code, room);
  return room;
}

/** A socket stand-in that records registered handlers, for registerHandlers(ctx, io, socket). */
function makeHandlerSocket(roomCode, name) {
  const handlers = {};
  return {
    data: { roomCode, name },
    on(event, handler) {
      handlers[event] = handler;
    },
    _handlers: handlers,
  };
}

/** Invokes a registered socket.on(event) handler, resolving with whatever it passes its callback. */
function call(socket, event, ...args) {
  const handler = socket._handlers[event];
  if (!handler) throw new Error(`No handler registered for "${event}"`);
  return new Promise((resolve) => {
    handler(...args, (res) => resolve(res));
  });
}

/** Registers every socket.on handler a game module defines, for one fake socket. */
function registerGame(game, ctx, socket) {
  game.registerHandlers(ctx, ctx.io, socket);
  return socket;
}

/** Every io.to(...).emit(...) call so far whose target is this player's socketId. */
function emissionsFor(io, room, name) {
  const p = room.players.get(name);
  if (!p) return [];
  return io.emissions.filter((e) => e.target === p.socketId);
}

/** Every roomEmit() broadcast so far (targeted at the room code as a whole). */
function emissionsForRoom(io, roomCode) {
  return io.emissions.filter((e) => e.target === roomCode);
}

/**
 * Mocks global.fetch so server/lib/openai.js's chatCompletionJson resolves with `responses`
 * (one object, or an array consumed in order, repeating the last entry once exhausted) as the
 * parsed JSON body. Also sets OPENAI_API_KEY so chatCompletionJson doesn't short-circuit.
 * Returns a restore() to undo both.
 */
function mockOpenAi(responses) {
  const queue = Array.isArray(responses) ? responses.slice() : [responses];
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  global.fetch = async () => {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(next) } }] }),
    };
  };
  return function restore() {
    global.fetch = originalFetch;
    process.env.OPENAI_API_KEY = originalKey;
  };
}

/** Mocks global.fetch to simulate an OpenAI/network failure. Returns a restore(). */
function mockOpenAiFailure() {
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  global.fetch = async () => {
    throw new Error('simulated network failure');
  };
  return function restore() {
    global.fetch = originalFetch;
    process.env.OPENAI_API_KEY = originalKey;
  };
}

/**
 * Several handlers kick off an async, not-awaited chain (e.g. imposter's vote handler calls
 * maybeFinishVoting -> finishVoting without awaiting it, so its callback resolves before the
 * OpenAI call and everything after it has settled). Call this after such a trigger to let that
 * microtask/macrotask chain flush before asserting on the resulting state.
 */
function flush(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  flush,
  createTestCtx,
  createRoom,
  addPlayer,
  makeHandlerSocket,
  registerGame,
  call,
  emissionsFor,
  emissionsForRoom,
  mockOpenAi,
  mockOpenAiFailure,
};
