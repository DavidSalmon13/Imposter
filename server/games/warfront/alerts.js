'use strict';

// Warfront shell: private "Under attack!" alerts (wfAlert), throttled per player. Owns
// wfAlertLog. Per socket only, never roomEmit. Must NOT contain: combat rules (engine).
// Spec: "Under attack".

const { WF_ALERT_COOLDOWN_MS, WF_ALERT_AREA } = require('./constants');
const engine = require('./engine');

// roomCode -> Map(name -> { at, tileId }) of each player's last alert (ephemeral).
const wfAlertLog = new Map();

/**
 * Turns this step's hits into private "Under attack!" alerts: a unit hit alerts its
 * owner, a base hit alerts that whole team. Per-socket only (never roomEmit), and
 * throttled per player (WF_ALERT_COOLDOWN_MS, or at once in a new area).
 */
function sendAlerts(ctx, roomCode, room, events, now) {
  const wf = room.state.warfront;
  if (!wfAlertLog.has(roomCode)) wfAlertLog.set(roomCode, new Map());
  const log = wfAlertLog.get(roomCode);
  for (const e of events) {
    let names;
    if (e.type === 'underAttack') names = [e.owner];
    else if (e.type === 'baseHit') names = Object.keys(wf.armies).filter((n) => wf.armies[n].team === e.team);
    else continue;
    for (const name of names) {
      const last = log.get(name);
      const fresh = !last || now - last.at >= WF_ALERT_COOLDOWN_MS
        || engine.manhattan(last.tileId, e.tileId, wf.map.width) >= WF_ALERT_AREA;
      if (!fresh) continue;
      log.set(name, { at: now, tileId: e.tileId });
      const p = room.players.get(name);
      if (p && p.connected && p.socketId) {
        ctx.io.to(p.socketId).emit('wfAlert', { tileId: e.tileId, base: e.type === 'baseHit' });
      }
    }
  }
}

module.exports = {
  wfAlertLog,
  sendAlerts,
};
