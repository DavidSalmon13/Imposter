'use strict';

// Warfront game module (specs/warfront-specs.md, implementation/warfront-plan.md).
// The shell around the pure engine (warfrontEngine.js): socket handlers, payloads,
// persistence hooks. Rules belong in the engine, not here.
//
const { shuffle } = require('../lib/shuffle');
const { chatCompletionJson } = require('../lib/openai');
const { rngFor, randomSeed } = require('../lib/rng');
const engine = require('./warfrontEngine');

const WF_MIN_PLAYERS = 2;
const WF_MAX_PLAYERS = 8;
const WF_MIN_TEAM_SIZE = 1;
const WF_MAX_TEAM_SIZE = 4;
const TEAMS = ['red', 'blue'];
// Give up on OpenAI after this long and use the procedural map instead.
const WF_MAP_TIMEOUT_MS = 25000;

// Keys within room.state.warfront to persist: all of them (no ephemeral fields in
// the namespace; the sim-loop interval handles live in a module-local map).
const SAVED_FIELDS = [
  'phaseConfig',
  'lobbyRaces',
  'seed',
  'tick',
  'nextUnitId',
  'winner',
  'map',
  'bases',
  'armies',
  'pickups',
  'clock',
  'event',
  'nextEventAt',
  'mapHistory',
  'eventHistory',
];

function createState() {
  return {
    phaseConfig: {
      matchCapMs: engine.MATCH_LENGTHS[engine.DEFAULT_MATCH_LENGTH].ms,
      mapSize: engine.DEFAULT_MAP_SIZE,
    },
    lobbyRaces: {}, // name -> race, picked at team select, kept for Play Again
    seed: 0,
    tick: 0,
    nextUnitId: 1,
    winner: null, // 'red' | 'blue' | 'draw' | null
    map: null,
    bases: null,
    armies: {},
    pickups: null,
    clock: null,
    event: null,
    nextEventAt: null,
    mapHistory: [],
    eventHistory: [],
  };
}

/** Back-to-lobby reset: keep the host's options, race picks and AI avoid-lists. */
function clearState(room) {
  const { phaseConfig, lobbyRaces, mapHistory, eventHistory } = room.state.warfront;
  room.state.warfront = createState();
  Object.assign(room.state.warfront, { phaseConfig, lobbyRaces, mapHistory, eventHistory });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function roomCodeOf(ctx, room) {
  if (!ctx || !ctx.rooms) return null;
  for (const [code, r] of ctx.rooms.entries()) {
    if (r === room) return code;
  }
  return null;
}

function teamMembers(ctx, room, color) {
  return ctx.connectedNames(room).filter((n) => room.players.get(n).team === color);
}

function matchLengthId(room) {
  const ms = room.state.warfront.phaseConfig.matchCapMs;
  const hit = Object.values(engine.MATCH_LENGTHS).find((l) => l.ms === ms);
  return hit ? hit.id : engine.DEFAULT_MATCH_LENGTH;
}

/** Why Start Battle can't run yet, or null when it can. */
function startBlocker(ctx, room) {
  const races = room.state.warfront.lobbyRaces;
  for (const color of TEAMS) {
    const members = teamMembers(ctx, room, color);
    if (members.length < WF_MIN_TEAM_SIZE) {
      return `${color === 'red' ? 'Red' : 'Blue'} team needs at least ${WF_MIN_TEAM_SIZE} player`;
    }
    if (members.length > WF_MAX_TEAM_SIZE) {
      return `${color === 'red' ? 'Red' : 'Blue'} team can have at most ${WF_MAX_TEAM_SIZE} players`;
    }
  }
  const noRace = TEAMS.flatMap((c) => teamMembers(ctx, room, c)).filter((n) => !engine.RACES[races[n]]);
  if (noRace.length) return `Waiting for ${noRace.join(', ')} to pick a race`;
  return null;
}

/** Host or either captain (D1). */
function canCommandMatch(room, name) {
  if (name === room.hostName) return true;
  const p = room.players.get(name);
  return Boolean(p && p.team && p.leader);
}

function teamSelectInfo(ctx, room) {
  const races = room.state.warfront.lobbyRaces;
  const entry = (n) => ({ name: n, leader: !!room.players.get(n).leader, race: races[n] || null });
  return {
    red: teamMembers(ctx, room, 'red').map(entry),
    blue: teamMembers(ctx, room, 'blue').map(entry),
    unassigned: ctx.connectedNames(room).filter((n) => !room.players.get(n).team).map(entry),
  };
}

/** The phase-aware wfState payload for one viewer. */
function wfStatePayload(ctx, room, viewerName) {
  const base = {
    game: 'warfront',
    phase: room.phase,
    host: room.hostName,
    roomCode: roomCodeOf(ctx, room),
    you: viewerName,
  };
  if (room.phase === 'teamSelect') {
    const blocker = startBlocker(ctx, room);
    return {
      ...base,
      ...teamSelectInfo(ctx, room),
      myRace: room.state.warfront.lobbyRaces[viewerName] || null,
      options: { matchLength: matchLengthId(room), mapSize: room.state.warfront.phaseConfig.mapSize },
      canStart: !blocker,
      startBlocker: blocker,
      canCommand: canCommandMatch(room, viewerName),
      maxPlayers: WF_MAX_PLAYERS,
      maxTeamSize: WF_MAX_TEAM_SIZE,
    };
  }
  if (room.phase === 'playing') return { ...base, ...battlePayload(ctx, room, viewerName) };
  return base;
}

/**
 * The battlefield for one viewer: the static map plus their side of the live
 * state. Until fog of war (Step 5) only the viewer's own team's units are sent.
 */
function battlePayload(ctx, room, viewerName) {
  const wf = room.state.warfront;
  const army = wf.armies[viewerName] || null;
  const myTeam = army ? army.team : null;
  const roster = Object.entries(wf.armies).map(([name, a]) => {
    const p = room.players.get(name);
    return { name, team: a.team, race: a.race, connected: Boolean(p && p.connected) };
  });
  const units = [];
  for (const [name, a] of Object.entries(wf.armies)) {
    if (!myTeam || a.team !== myTeam) continue;
    for (const u of a.units) {
      units.push({ id: u.id, type: u.type, tileId: u.tileId, hp: u.hp, owner: name, team: a.team });
    }
  }
  return {
    serverNow: Date.now(),
    map: wf.map,
    bases: wf.bases,
    clock: wf.clock,
    myTeam,
    myRace: army ? army.race : null,
    me: army ? { supply: army.supply, minerals: army.minerals, arsenal: army.arsenal } : null,
    roster,
    units,
    weapons: wf.pickups ? wf.pickups.weapons : [],
  };
}

function broadcastWfState(ctx, roomCode, room) {
  for (const [name, p] of room.players.entries()) {
    if (!p.connected || !p.socketId) continue;
    ctx.io.to(p.socketId).emit('wfState', wfStatePayload(ctx, room, name));
  }
}


// ---------------------------------------------------------------------------
// Map generation (spec "Map generation")
// ---------------------------------------------------------------------------

function battlefieldPrompt(size, avoid) {
  const { width, height } = size;
  const half = Math.floor(width / 2);
  return (
    `Design a top-down grid battlefield for a two-team strategy game. The grid is ${width} tiles wide ` +
    `and ${height} tiles tall; x runs 0..${width - 1} left to right, y runs 0..${height - 1} top to bottom. ` +
    `Terrain types: "plains" (open), "forest", "hills" (both slow but defensive), "water" and "rock" ` +
    `(both impassable). Mostly plains, with forests and hills for cover, and water/rock shaping a few ` +
    `lanes and natural chokepoints - but every base, vein and weapon must stay reachable on foot. ` +
    `Put the red base near the left edge (x < ${half}) and the blue base near the right edge ` +
    `(x >= ${width - half}), roughly level with each other. Put exactly one supply source on a tile ` +
    `directly next to each base (up, down, left or right). Put 1-2 mineral veins out in the contested ` +
    `middle, equally far from both bases (richness 1-3, richest in the centre). Scatter 2-4 weapon ` +
    `tokens, placed fairly for both sides, rarer ones deeper in contested ground. Keep the layout ` +
    `roughly mirror-symmetric so neither side has an advantage. No two features (base, supply source, ` +
    `vein, weapon) on the same tile, and none on water or rock. Also give the map an evocative theme ` +
    `name (max 40 characters) and 1-2 sentences of lore.` +
    (avoid.length ? ` Recent map themes - pick something different from all of them: ${avoid.join('; ')}.` : '') +
    ` Respond with ONLY compact JSON in exactly this shape: {"theme": "...", "lore": "...", ` +
    `"width": ${width}, "height": ${height}, "tiles": [{"terrain": "plains"}, ...], ` +
    `"bases": [{"team": "red", "x": 0, "y": 0}, {"team": "blue", "x": 0, "y": 0}], ` +
    `"supplySources": [{"x": 0, "y": 0}, {"x": 0, "y": 0}], ` +
    `"veins": [{"x": 0, "y": 0, "richness": 2, "contested": true}], ` +
    `"weapons": [{"x": 0, "y": 0, "weaponId": "artillery|emp|airdrop|bombard|aegis"}], ` +
    `"chokepoints": [{"x": 0, "y": 0}]}. "tiles" must have exactly ${width * height} entries in ` +
    `row-major order (all of row y=0 left to right, then row y=1, and so on).`
  );
}

/** Asks OpenAI for a battlefield and hard-validates it. Throws on any problem. */
async function generateBattlefield(room, sizeId) {
  const size = engine.MAP_SIZES[sizeId] || engine.MAP_SIZES[engine.DEFAULT_MAP_SIZE];
  const avoid = room.state.warfront.mapHistory.slice(-engine.TUNING.mapHistoryWindow);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('OpenAI map request timed out')), WF_MAP_TIMEOUT_MS);
  });
  try {
    const raw = await Promise.race([
      chatCompletionJson(battlefieldPrompt(size, avoid), { temperature: 1.1 }),
      timeout,
    ]);
    return engine.validateMap(raw, size);
  } finally {
    clearTimeout(timer);
  }
}

/** Team members with a race, as the engine's roster. */
function battleRoster(ctx, room) {
  const races = room.state.warfront.lobbyRaces;
  return TEAMS.flatMap((team) => teamMembers(ctx, room, team).map((name) => ({ name, team, race: races[name] })));
}

/**
 * Start Battle / Play Again: generating -> (AI map or fallback) -> playing.
 * Never fails for lack of a map: any OpenAI or validation error uses the
 * procedural fallback.
 */
async function generateBattle(ctx, roomCode, room) {
  room.phase = 'generating';
  ctx.roomEmit(roomCode, 'generating', { game: 'warfront' });
  broadcastWfState(ctx, roomCode, room);

  const sizeId = room.state.warfront.phaseConfig.mapSize;
  const seed = randomSeed();
  let map;
  try {
    map = await generateBattlefield(room, sizeId);
  } catch (err) {
    console.error('Warfront map generation failed, using the fallback map:', err.message);
    map = engine.buildFallbackMap(sizeId, rngFor(seed, 0));
  }

  // The room may have been closed, or sent back to the lobby, while we waited.
  if (ctx.rooms.get(roomCode) !== room || room.game !== 'warfront' || room.phase !== 'generating') return;

  const blocker = startBlocker(ctx, room);
  if (blocker) {
    room.phase = 'teamSelect';
    broadcastWfState(ctx, roomCode, room);
    ctx.roomEmit(roomCode, 'wfNotice', { text: `Battle cancelled: ${blocker}` });
    return;
  }

  const wf = room.state.warfront;
  const battle = engine.createBattleState(map, battleRoster(ctx, room), {
    seed,
    now: Date.now(),
    matchCapMs: wf.phaseConfig.matchCapMs,
  });
  Object.assign(wf, battle);
  wf.mapHistory.push(map.theme);
  if (wf.mapHistory.length > engine.TUNING.mapHistoryWindow) {
    wf.mapHistory.splice(0, wf.mapHistory.length - engine.TUNING.mapHistoryWindow);
  }
  room.phase = 'playing';
  broadcastWfState(ctx, roomCode, room);
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

function onChoose(ctx, roomCode, room) {
  clearState(room);
  for (const p of room.players.values()) {
    p.team = null;
    p.leader = false;
  }
  room.phase = 'teamSelect';
  broadcastWfState(ctx, roomCode, room);
}

function reconnectPayload(ctx, room, existingPlayer) {
  let viewerName = null;
  for (const [n, p] of room.players.entries()) {
    if (p === existingPlayer) {
      viewerName = n;
      break;
    }
  }
  return { ok: true, ...wfStatePayload(ctx, room, viewerName) };
}

function onDisconnect(ctx, roomCode, room) {
  broadcastWfState(ctx, roomCode, room);
}

function onReconnectBroadcast(ctx, roomCode, room) {
  broadcastWfState(ctx, roomCode, room);
}

function repairOnLoad(ctx, room) {
  // An in-flight map generation can't resume.
  if (room.phase === 'generating') room.phase = 'teamSelect';
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Wraps a handler with the shared guards: in a room, Warfront chosen, the right
 * phase, and a joined player. `fn({ room, roomCode, name, p, data })` returns an
 * error string or nothing; on success the room is re-broadcast.
 */
function teamSelectHandler(ctx, socket, fn) {
  return (data, callback) => {
    if (typeof data === 'function') {
      callback = data;
      data = undefined;
    }
    callback = typeof callback === 'function' ? callback : () => {};
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'warfront' || room.phase !== 'teamSelect') {
      return callback({ ok: false, error: 'Not choosing teams right now' });
    }
    const name = socket.data.name;
    const p = room.players.get(name);
    if (!p) return callback({ ok: false, error: 'Not joined' });
    const error = fn({ room, roomCode, name, p, data });
    if (error) return callback({ ok: false, error });
    callback({ ok: true });
    broadcastWfState(ctx, roomCode, room);
  };
}

function registerHandlers(ctx, io, socket) {
  socket.on('joinWfTeam', teamSelectHandler(ctx, socket, ({ room, p, data }) => {
    if (!TEAMS.includes(data)) return 'Invalid team';
    if (p.team === data) return null;
    if (teamMembers(ctx, room, data).length >= WF_MAX_TEAM_SIZE) return 'That team is full';
    p.team = data;
    p.leader = false;
    return null;
  }));

  socket.on('claimWfCaptain', teamSelectHandler(ctx, socket, ({ room, name, p }) => {
    if (!p.team) return 'Join a team first';
    const current = teamMembers(ctx, room, p.team).find((n) => room.players.get(n).leader);
    if (current && current !== name) return 'This team already has a captain';
    p.leader = true;
    return null;
  }));

  socket.on('setWfRace', teamSelectHandler(ctx, socket, ({ room, name, data }) => {
    if (!engine.RACES[data]) return 'Invalid race';
    room.state.warfront.lobbyRaces[name] = data;
    return null;
  }));

  socket.on('setWfOptions', teamSelectHandler(ctx, socket, ({ room, name, data }) => {
    if (name !== room.hostName) return 'Only the host can change the settings';
    if (!data || typeof data !== 'object') return 'Invalid options';
    const { matchLength, mapSize } = data;
    if (matchLength !== undefined && !engine.MATCH_LENGTHS[matchLength]) return 'Invalid match length';
    if (mapSize !== undefined && !engine.MAP_SIZES[mapSize]) return 'Invalid map size';
    const cfg = room.state.warfront.phaseConfig;
    if (matchLength !== undefined) cfg.matchCapMs = engine.MATCH_LENGTHS[matchLength].ms;
    if (mapSize !== undefined) cfg.mapSize = mapSize;
    return null;
  }));

  socket.on('randomizeWfTeams', teamSelectHandler(ctx, socket, ({ room, name }) => {
    if (name !== room.hostName) return 'Only the host can randomize teams';
    // Alternate over a shuffled roster so sizes differ by at most one; captains are
    // cleared since their teams no longer exist. Races are untouched.
    const first = Math.random() < 0.5 ? 'red' : 'blue';
    const second = first === 'red' ? 'blue' : 'red';
    shuffle(ctx.connectedNames(room)).forEach((n, i) => {
      const pl = room.players.get(n);
      pl.team = i % 2 === 0 ? first : second;
      pl.leader = false;
    });
    return null;
  }));

  socket.on('startWarfront', (callback) => {
    callback = typeof callback === 'function' ? callback : () => {};
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'warfront' || room.phase !== 'teamSelect') {
      return callback({ ok: false, error: 'Not choosing teams right now' });
    }
    if (!canCommandMatch(room, socket.data.name)) {
      return callback({ ok: false, error: 'Only the host or a captain can start the battle' });
    }
    const blocker = startBlocker(ctx, room);
    if (blocker) return callback({ ok: false, error: blocker });

    callback({ ok: true });
    generateBattle(ctx, roomCode, room);
  });
}

module.exports = {
  id: 'warfront',
  minPlayers: WF_MIN_PLAYERS,
  maxPlayers: WF_MAX_PLAYERS,
  onChoose,
  registerHandlers,
  reconnectPayload,
  onDisconnect,
  onReconnectBroadcast,
  namespaces: [{ id: 'warfront', createState, savedFields: SAVED_FIELDS }],
  repairOnLoad,
  clearState,
  // exported for tests
  WF_MAP_TIMEOUT_MS,
  generateBattle,
  WF_MIN_TEAM_SIZE,
  WF_MAX_TEAM_SIZE,
  wfStatePayload,
};
