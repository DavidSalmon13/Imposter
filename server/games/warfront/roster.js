'use strict';

// Warfront shell: read-only room/roster helpers every other shell module uses (room code,
// team members, match length, why Start Battle is blocked, who may command the match).
// Must NOT contain: socket emits, loop control or state mutation. Spec: "Team select" (D1).

const { WF_MIN_TEAM_SIZE, WF_MAX_TEAM_SIZE, TEAMS } = require('./constants');
const engine = require('./engine');

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

module.exports = {
  roomCodeOf,
  teamMembers,
  matchLengthId,
  startBlocker,
  canCommandMatch,
};
