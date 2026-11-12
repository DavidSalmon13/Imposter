'use strict';

// Warfront shell: every payload the server sends (wfState per phase, battle, game over,
// catalogs) and the per-socket fan-out (wfState, wfLive, wfAlert). Hidden info goes per
// socket, never roomEmit. Must NOT contain: rules (engine), the loop timer (loop.js) or alerts (alerts.js).
// Plan: "Event & function naming reference", "Static vs live payloads".

const { WF_MAX_PLAYERS, WF_MAX_TEAM_SIZE } = require('./constants');
const { roomCodeOf, teamMembers, matchLengthId, startBlocker, canCommandMatch } = require('./roster');
const engine = require('./engine');

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
  if (room.phase === 'gameover' && room.state.warfront.map) return { ...base, ...gameOverPayload(ctx, room, viewerName) };
  return base;
}

/**
 * The game-over screen for one viewer: winner, how it ended, the match time, the
 * final map with the fog lifted, each player's battle stats with the MVP (most
 * base damage), and the shared scoreboard. Nothing here is hidden any more.
 */
function gameOverPayload(ctx, room, viewerName) {
  const wf = room.state.warfront;
  const army = wf.armies[viewerName] || null;
  const view = engine.finalView(wf);
  const stats = view.stats.map((s) => {
    const p = room.players.get(s.name);
    return { ...s, connected: Boolean(p && p.connected) };
  });
  let mvp = null;
  for (const s of stats) {
    if (s.baseDmg <= 0) continue;
    if (!mvp || s.baseDmg > mvp.baseDmg || (s.baseDmg === mvp.baseDmg && s.kills > mvp.kills)) mvp = s;
  }
  const destroyed = ['red', 'blue'].filter((t) => wf.bases[t].hp <= 0);
  return {
    serverNow: Date.now(),
    map: wf.map,
    myTeam: army ? army.team : null,
    myRace: army ? army.race : null,
    winner: wf.winner,
    endReason: destroyed.length ? 'base' : 'time',
    matchMs: Math.max(0, (wf.clock.endedAt || wf.clock.lastTickAt) - wf.clock.startedAt),
    bases: view.bases,
    clock: view.clock,
    units: view.units,
    visible: view.visible,
    pickups: view.pickups,
    stats,
    mvp: mvp ? mvp.name : null,
    scoreboard: ctx.scoreboardEntries(room),
    canCommand: canCommandMatch(room, viewerName),
  };
}

/**
 * The battlefield for one viewer: the static map and roster (sent once, with
 * wfState) plus their fogged live view (the same shape wfLive repeats).
 */
function battlePayload(ctx, room, viewerName) {
  const wf = room.state.warfront;
  const army = wf.armies[viewerName] || null;
  const roster = Object.entries(wf.armies).map(([name, a]) => {
    const p = room.players.get(name);
    return { name, team: a.team, race: a.race, connected: Boolean(p && p.connected) };
  });
  return {
    serverNow: Date.now(),
    map: wf.map,
    myTeam: army ? army.team : null,
    myRace: army ? army.race : null,
    catalog: army ? produceCatalog(army.race) : [],
    buildCatalog: army ? buildCatalog(army.race) : [],
    weaponCost: engine.TUNING.workshopWeaponCost,
    weaponMs: engine.TUNING.workshopWeaponMs,
    carryCap: engine.TUNING.carryCap,
    roster,
    canCommand: canCommandMatch(room, viewerName),
    ...engine.viewForPlayer(wf, viewerName),
  };
}

/** The unit cards a race's console shows: price, build time, structure or not. */
function produceCatalog(race) {
  return engine.producibleTypes(race).map((id) => {
    const t = engine.UNIT_TYPES[id];
    return {
      unitType: id, name: t.name, supply: t.supply, minerals: t.minerals,
      structure: t.class === 'structure', worker: t.class === 'worker', buildMs: engine.buildMs(id),
    };
  });
}

/** The Build tab's cards: each facility and the Tower at this race's 💎 price. */
function buildCatalog(race) {
  return Object.values(engine.FACILITIES).map((f) => ({
    facility: f.id, name: f.name, minerals: engine.facilityCost(race, f.id), hp: f.hp, buildMs: f.buildMs,
    needsVein: Boolean(f.needsVein),
  }));
}

function broadcastWfState(ctx, roomCode, room) {
  for (const [name, p] of room.players.entries()) {
    if (!p.connected || !p.socketId) continue;
    ctx.io.to(p.socketId).emit('wfState', wfStatePayload(ctx, room, name));
  }
}

/** Per-socket fogged snapshot (never roomEmit: each view hides different things). */
function broadcastLive(ctx, roomCode, room, events) {
  const wf = room.state.warfront;
  const serverNow = Date.now();
  for (const [name, p] of room.players.entries()) {
    if (!p.connected || !p.socketId) continue;
    ctx.io.to(p.socketId).emit('wfLive', {
      serverNow,
      ...engine.viewForPlayer(wf, name),
      events: engine.eventsForPlayer(wf, name, events),
    });
  }
}

module.exports = {
  wfStatePayload,
  broadcastWfState,
  broadcastLive,
};
