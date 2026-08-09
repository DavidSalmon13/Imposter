'use strict';

const trackData = require('../../public/data/kart-track.json');

const KR_MIN_PLAYERS = 2;
const KR_MAX_PLAYERS = 8;
const KR_LAP_COUNT = 1;
const KR_COUNTDOWN_MS = 3000;
const KR_TICK_MS = 50; // 20Hz — physics step AND broadcast, combined
const KR_MAX_SPEED = 24; // units/s
const KR_ACCEL = 18; // units/s^2
const KR_BRAKE_DECEL = 30; // units/s^2
const KR_TURN_RATE = 2.4; // rad/s at full steer and full speed
const KR_KART_RADIUS = 1.4;
const KR_TRACK_BOUNCE_SPEED_FACTOR = 0.5; // speed retained after boundary/wall bounce
const KR_ITEM_PICKUP_RADIUS = 2.5;
const KR_ITEM_BOX_RESPAWN_MS = 8000;
const KR_BOOST_MULTIPLIER = 1.6;
const KR_BOOST_DURATION_MS = 3000;
const KR_SHIELD_DURATION_MS = 8000;
const KR_SHELL_RANGE = 14;
const KR_SHELL_HALF_ANGLE_RAD = (20 * Math.PI) / 180; // 40° cone
const KR_HAZARD_RADIUS = 1.5;
const KR_SPINOUT_DURATION_MS = 1200;

const SAVED_FIELDS = ['krPlayers', 'krKarts', 'krRaceStartAt', 'krItemBoxes', 'krResults'];

const POINTS = [3, 2, 1]; // index 0 = 1st place

/** @type {Map<string, NodeJS.Timeout>} */
const kartLoopHandles = new Map();
/** @type {Map<string, NodeJS.Timeout>} */
const countdownHandles = new Map();

// --- Track geometry (precomputed once at module load) ---

const WAYPOINTS = trackData.waypoints;
const WP_COUNT = WAYPOINTS.length;
const TRACK_HALF_WIDTH = trackData.trackHalfWidth;

/** Cumulative arc length from waypoint 0 to each waypoint i (waypoint 0 = 0). */
const waypointArc = new Array(WP_COUNT);
waypointArc[0] = 0;
for (let i = 1; i < WP_COUNT; i++) {
  const a = WAYPOINTS[i - 1];
  const b = WAYPOINTS[i];
  waypointArc[i] = waypointArc[i - 1] + Math.hypot(b.x - a.x, b.z - a.z);
}
const last = WAYPOINTS[WP_COUNT - 1];
const first = WAYPOINTS[0];
const TRACK_LENGTH =
  waypointArc[WP_COUNT - 1] + Math.hypot(first.x - last.x, first.z - last.z);

const checkpointArc = trackData.checkpoints.map((idx) => waypointArc[idx]);

/**
 * Closest point on the track centerline to (x, z).
 * @returns {{ lateralOffset: number, arcLength: number, segmentIndex: number, cx: number, cz: number }}
 */
function nearestTrackPoint(x, z) {
  let bestDistSq = Infinity;
  let best = { lateralOffset: 0, arcLength: 0, segmentIndex: 0, cx: x, cz: z };

  for (let i = 0; i < WP_COUNT; i++) {
    const a = WAYPOINTS[i];
    const b = WAYPOINTS[(i + 1) % WP_COUNT];
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const segLenSq = abx * abx + abz * abz;
    let t = 0;
    if (segLenSq > 0) {
      t = ((x - a.x) * abx + (z - a.z) * abz) / segLenSq;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
    }
    const cx = a.x + abx * t;
    const cz = a.z + abz * t;
    const dx = x - cx;
    const dz = z - cz;
    const distSq = dx * dx + dz * dz;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      const segLen = Math.sqrt(segLenSq);
      // Signed lateral: positive = to the right of travel (forward × up in Y-up XZ)
      const cross = abx * dz - abz * dx;
      const lateralOffset = segLen > 0 ? -cross / segLen : Math.sqrt(distSq);
      const arcLength = (waypointArc[i] + t * segLen) % TRACK_LENGTH;
      best = { lateralOffset, arcLength, segmentIndex: i, cx, cz };
    }
  }
  return best;
}

function clamp(v, lo, hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

function isConnected(room, name) {
  const p = room.players.get(name);
  return !!(p && p.connected);
}

function clearCountdownHandle(roomCode) {
  const handle = countdownHandles.get(roomCode);
  if (handle) clearTimeout(handle);
  countdownHandles.delete(roomCode);
}

function stopKartLoop(roomCode) {
  const handle = kartLoopHandles.get(roomCode);
  if (handle) clearInterval(handle);
  kartLoopHandles.delete(roomCode);
}

function clearState(room, roomCode) {
  if (roomCode) {
    stopKartLoop(roomCode);
    clearCountdownHandle(roomCode);
  }
  room.krPlayers = [];
  room.krKarts = {};
  room.krRaceStartAt = null;
  room.krItemBoxes = [];
  room.krResults = null;
}

function createKart(index) {
  // Spread along start line (waypoint 0), laterally offset so karts don't stack.
  const start = WAYPOINTS[0];
  const next = WAYPOINTS[1];
  const fdx = next.x - start.x;
  const fdz = next.z - start.z;
  const fLen = Math.hypot(fdx, fdz) || 1;
  const fx = fdx / fLen;
  const fz = fdz / fLen;
  // Right-hand perpendicular in XZ (travel × up): (fx,0,fz) × (0,1,0) = (fz, 0, -fx)
  const rx = fz;
  const rz = -fx;
  const spacing = 2 * KR_KART_RADIUS + 0.5;
  const offset = index * spacing;

  return {
    x: start.x + rx * offset,
    z: start.z + rz * offset,
    headingRad: Math.atan2(fx, fz), // atan2(sin, cos) matching x+=sin*s, z+=cos*s
    speed: 0,
    pendingInput: { steer: 0, braking: false },
    progress: 0,
    // Start needing checkpoint 1 (first gate after the start/finish). Crossing
    // checkpoint 0 (finish) after 1..5 completes the lap — see stepKartRace.
    nextCheckpointIndex: 1,
    lap: 0,
    heldItem: null,
    boostUntil: 0,
    shieldUntil: 0,
    spinningUntil: 0,
    finished: false,
    finishTime: null,
    finishRank: null,
    prevArcLength: 0,
  };
}

function initItemBoxes() {
  return trackData.itemBoxes.map(() => ({ takenUntil: 0 }));
}

function worldPosForWaypoint(wpIndex, lateralOffset) {
  const a = WAYPOINTS[wpIndex];
  const b = WAYPOINTS[(wpIndex + 1) % WP_COUNT];
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const segLen = Math.hypot(abx, abz) || 1;
  const fx = abx / segLen;
  const fz = abz / segLen;
  const rx = fz;
  const rz = -fx;
  const lat = lateralOffset || 0;
  return { x: a.x + rx * lat, z: a.z + rz * lat };
}

function applyBounce(kart) {
  const near = nearestTrackPoint(kart.x, kart.z);
  const absLat = Math.abs(near.lateralOffset);
  if (absLat > 1e-6) {
    const excess = absLat - TRACK_HALF_WIDTH;
    if (excess > 0) {
      const pull = excess / absLat;
      kart.x = kart.x + (near.cx - kart.x) * pull;
      kart.z = kart.z + (near.cz - kart.z) * pull;
    }
  }
  kart.speed *= KR_TRACK_BOUNCE_SPEED_FACTOR;
}

function crossedArc(prevArc, currArc, targetArc) {
  if (prevArc === currArc) return false;
  // Only treat as a loop wrap when arc length jumps backward by a large amount
  // (near end → near start). Small backward nudges from bounces must not count.
  const wrapped = prevArc > currArc && prevArc - currArc > TRACK_LENGTH * 0.5;
  if (!wrapped) {
    if (prevArc < currArc) {
      return prevArc < targetArc && currArc >= targetArc;
    }
    return false;
  }
  return prevArc < targetArc || currArc >= targetArc;
}

function resolveKartKartCollisions(room) {
  const names = room.krPlayers;
  for (let i = 0; i < names.length; i++) {
    const aName = names[i];
    const a = room.krKarts[aName];
    if (!a || a.finished || !isConnected(room, aName)) continue;
    for (let j = i + 1; j < names.length; j++) {
      const bName = names[j];
      const b = room.krKarts[bName];
      if (!b || b.finished || !isConnected(room, bName)) continue;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const dist = Math.hypot(dx, dz);
      const minDist = KR_KART_RADIUS * 2;
      if (dist < minDist && dist > 0) {
        const overlap = minDist - dist;
        const pushEach = overlap / 2;
        const nx = dx / dist;
        const nz = dz / dist;
        a.x -= nx * pushEach;
        a.z -= nz * pushEach;
        b.x += nx * pushEach;
        b.z += nz * pushEach;
      }
    }
  }
}

function tryAbsorbOrSpin(kart, now) {
  if (kart.shieldUntil > now) {
    kart.shieldUntil = 0;
    return;
  }
  kart.spinningUntil = now + KR_SPINOUT_DURATION_MS;
}

function stepKartRace(ctx, roomCode, room) {
  if (!room || room.game !== 'kartrace' || room.phase !== 'racing') {
    stopKartLoop(roomCode);
    return;
  }

  const now = Date.now();
  const dt = KR_TICK_MS / 1000;

  for (const name of room.krPlayers) {
    const kart = room.krKarts[name];
    if (!kart || kart.finished) continue;

    // Ghosted (disconnected) karts freeze fully — no accel, no pickup, no hazard self-trigger.
    if (!isConnected(room, name)) {
      continue;
    }

    if (kart.spinningUntil > now) {
      kart.speed = Math.max(0, kart.speed - KR_BRAKE_DECEL * dt);
    } else {
      const boosted = kart.boostUntil > now;
      const effectiveMax = KR_MAX_SPEED * (boosted ? KR_BOOST_MULTIPLIER : 1);
      const accel = kart.pendingInput.braking ? -KR_BRAKE_DECEL : KR_ACCEL;
      kart.speed = clamp(kart.speed + accel * dt, 0, effectiveMax);
      const turnScale = clamp(kart.speed / KR_MAX_SPEED, 0.2, 1);
      kart.headingRad += kart.pendingInput.steer * KR_TURN_RATE * turnScale * dt;
    }

    kart.x += Math.sin(kart.headingRad) * kart.speed * dt;
    kart.z += Math.cos(kart.headingRad) * kart.speed * dt;

    // Track boundary
    let near = nearestTrackPoint(kart.x, kart.z);
    if (Math.abs(near.lateralOffset) > TRACK_HALF_WIDTH) {
      applyBounce(kart);
      near = nearestTrackPoint(kart.x, kart.z);
    }

    // Hazards (skip oil re-trigger while already spinning so a shield isn't
    // consumed on tick N and a spin applied on tick N+1 while overlapping)
    if (kart.spinningUntil <= now) {
      for (const oil of trackData.oilSlicks) {
        const pos = worldPosForWaypoint(oil.waypointIndex, 0);
        if (Math.hypot(kart.x - pos.x, kart.z - pos.z) <= KR_HAZARD_RADIUS + KR_KART_RADIUS) {
          tryAbsorbOrSpin(kart, now);
          break;
        }
      }
    }
    for (const wall of trackData.wallHazards) {
      const pos = worldPosForWaypoint(wall.waypointIndex, wall.lateralOffset);
      const dist = Math.hypot(kart.x - pos.x, kart.z - pos.z);
      const minDist = KR_HAZARD_RADIUS + KR_KART_RADIUS;
      if (dist <= minDist) {
        // Bounce back along travel far enough to exit the hazard radius, then cut speed.
        // (Reusing speed-cut from applyBounce without the track-boundary position clamp,
        // which would leave a centerline kart permanently overlapping an off-center wall.)
        const push = dist > 1e-6 ? minDist - dist + 0.15 : minDist;
        kart.x -= Math.sin(kart.headingRad) * push;
        kart.z -= Math.cos(kart.headingRad) * push;
        kart.speed *= KR_TRACK_BOUNCE_SPEED_FACTOR;
      }
    }

    // Item boxes (connected only — already gated above)
    if (kart.heldItem === null && Array.isArray(room.krItemBoxes)) {
      for (let i = 0; i < trackData.itemBoxes.length; i++) {
        const box = room.krItemBoxes[i];
        if (!box || box.takenUntil > now) continue;
        const pos = worldPosForWaypoint(trackData.itemBoxes[i].waypointIndex, 0);
        if (Math.hypot(kart.x - pos.x, kart.z - pos.z) <= KR_ITEM_PICKUP_RADIUS) {
          const items = ['boost', 'shield', 'shell'];
          kart.heldItem = items[Math.floor(Math.random() * 3)];
          box.takenUntil = now + KR_ITEM_BOX_RESPAWN_MS;
          break;
        }
      }
    }

    // Progress / checkpoints / laps
    near = nearestTrackPoint(kart.x, kart.z);
    const prevArc = kart.prevArcLength;
    const currArc = near.arcLength;
    kart.progress = currArc;

    const cpIdx = kart.nextCheckpointIndex;
    const targetArc = checkpointArc[cpIdx];
    if (crossedArc(prevArc, currArc, targetArc)) {
      const wrappedToFinish = cpIdx === 0;
      kart.nextCheckpointIndex = (cpIdx + 1) % trackData.checkpoints.length;
      if (wrappedToFinish) {
        kart.lap += 1;
        if (kart.lap >= KR_LAP_COUNT && !kart.finished) {
          kart.finished = true;
          kart.finishTime = now - (room.krRaceStartAt || now);
          let finishedCount = 0;
          for (const n of room.krPlayers) {
            const k = room.krKarts[n];
            if (k && k.finished && n !== name) finishedCount += 1;
          }
          kart.finishRank = 1 + finishedCount;
        }
      }
    }
    kart.prevArcLength = currArc;
  }

  resolveKartKartCollisions(room);
  broadcastKartRace(ctx, roomCode, room);
}

function startKartLoop(ctx, roomCode) {
  stopKartLoop(roomCode);
  kartLoopHandles.set(
    roomCode,
    setInterval(() => {
      const room = ctx.rooms.get(roomCode);
      stepKartRace(ctx, roomCode, room);
    }, KR_TICK_MS)
  );
}

function raceSortKey(kart) {
  if (!kart) return -Infinity;
  if (kart.finished) return Infinity - (kart.finishRank || 99);
  return kart.lap * TRACK_LENGTH + (kart.progress || 0);
}

function awardKartRaceScores(ctx, room) {
  if (!Array.isArray(room.krResults)) return;
  room.krResults.forEach((entry, i) => {
    ctx.addScore(room, entry.name, POINTS[i] || 0);
  });
}

function buildKrResults(room) {
  const finished = [];
  const unfinished = [];
  for (const name of room.krPlayers) {
    const kart = room.krKarts[name];
    if (!kart) continue;
    const entry = {
      name,
      finished: !!kart.finished,
      finishRank: kart.finishRank,
      finishTime: kart.finishTime,
      lap: kart.lap,
      progress: kart.progress,
    };
    if (kart.finished) finished.push(entry);
    else unfinished.push(entry);
  }
  finished.sort((a, b) => (a.finishRank || 99) - (b.finishRank || 99));
  unfinished.sort((a, b) => {
    const ka = room.krKarts[a.name];
    const kb = room.krKarts[b.name];
    return raceSortKey(kb) - raceSortKey(ka);
  });
  return finished.concat(unfinished);
}

function kartRaceStatePayload(ctx, room, viewerName) {
  const karts = room.krPlayers.map((name) => {
    const kart = room.krKarts[name] || {};
    return {
      name,
      x: kart.x,
      z: kart.z,
      headingRad: kart.headingRad,
      speed: kart.speed,
      lap: kart.lap,
      nextCheckpointIndex: kart.nextCheckpointIndex,
      progress: kart.progress,
      heldItem: kart.heldItem,
      spinningUntil: kart.spinningUntil,
      boostUntil: kart.boostUntil,
      shieldUntil: kart.shieldUntil,
      finished: !!kart.finished,
      finishRank: kart.finishRank,
      connected: isConnected(room, name),
    };
  });

  const someoneFinished = karts.some((k) => k.finished);
  const connectedCount = ctx.connectedNames(room).length;

  // Ready (before Start): show everyone currently connected. After Start / Play Again:
  // krPlayers is the frozen race roster.
  const players =
    room.phase === 'ready' && room.krPlayers.length === 0
      ? ctx.connectedNames(room)
      : room.krPlayers.slice();

  return {
    game: 'kartrace',
    phase: room.phase,
    host: room.hostName,
    viewerName,
    players,
    karts,
    raceStartAt: room.krRaceStartAt,
    itemBoxes: (room.krItemBoxes || []).map((b, i) => ({
      waypointIndex: trackData.itemBoxes[i].waypointIndex,
      takenUntil: b.takenUntil,
    })),
    results: room.krResults,
    canStart:
      room.phase === 'ready' &&
      connectedCount >= KR_MIN_PLAYERS &&
      connectedCount <= KR_MAX_PLAYERS,
    canEndRace: room.phase === 'racing' && someoneFinished,
    scoreboard: room.phase === 'results' ? ctx.scoreboardEntries(room) : undefined,
  };
}

function broadcastKartRace(ctx, roomCode, room) {
  for (const [name, p] of room.players.entries()) {
    if (!p.connected || !p.socketId) continue;
    ctx.io.to(p.socketId).emit('krState', kartRaceStatePayload(ctx, room, name));
  }
}

function findRoomCode(ctx, room) {
  if (!ctx || !ctx.rooms) return null;
  for (const [code, r] of ctx.rooms.entries()) {
    if (r === room) return code;
  }
  return null;
}

function freezeRosterAndResetKarts(ctx, room) {
  room.krPlayers = ctx.connectedNames(room).slice();
  room.krKarts = {};
  room.krPlayers.forEach((name, i) => {
    room.krKarts[name] = createKart(i);
  });
  room.krItemBoxes = initItemBoxes();
  room.krResults = null;
  room.krRaceStartAt = null;
}

function initKartRaceGame(ctx, roomCode, room) {
  clearState(room, roomCode);
  room.phase = 'ready';
  broadcastKartRace(ctx, roomCode, room);
}

function beginCountdown(ctx, roomCode, room) {
  freezeRosterAndResetKarts(ctx, room);
  if (room.krPlayers.length < KR_MIN_PLAYERS) return false;
  if (room.krPlayers.length > KR_MAX_PLAYERS) return false;

  room.krRaceStartAt = Date.now() + KR_COUNTDOWN_MS;
  room.phase = 'countdown';
  broadcastKartRace(ctx, roomCode, room);

  clearCountdownHandle(roomCode);
  countdownHandles.set(
    roomCode,
    setTimeout(() => {
      countdownHandles.delete(roomCode);
      const r = ctx.rooms.get(roomCode);
      if (!r || r.game !== 'kartrace' || r.phase !== 'countdown') return;
      r.phase = 'racing';
      startKartLoop(ctx, roomCode);
      broadcastKartRace(ctx, roomCode, r);
    }, KR_COUNTDOWN_MS)
  );
  return true;
}

function endKartRace(ctx, roomCode, room) {
  stopKartLoop(roomCode);
  clearCountdownHandle(roomCode);
  room.krResults = buildKrResults(room);
  awardKartRaceScores(ctx, room);
  room.phase = 'results';
  room.krRaceStartAt = null;
  broadcastKartRace(ctx, roomCode, room);
}

function fireShell(room, firerName, firerKart, now) {
  const forwardX = Math.sin(firerKart.headingRad);
  const forwardZ = Math.cos(firerKart.headingRad);
  let best = null;
  let bestDist = Infinity;

  for (const name of room.krPlayers) {
    if (name === firerName) continue;
    const other = room.krKarts[name];
    if (!other || other.finished || !isConnected(room, name)) continue;
    const dx = other.x - firerKart.x;
    const dz = other.z - firerKart.z;
    const dist = Math.hypot(dx, dz);
    if (dist > KR_SHELL_RANGE || dist <= 0) continue;
    const nx = dx / dist;
    const nz = dz / dist;
    const dot = forwardX * nx + forwardZ * nz;
    if (dot < Math.cos(KR_SHELL_HALF_ANGLE_RAD)) continue;
    if (dist < bestDist) {
      bestDist = dist;
      best = other;
    }
  }

  if (best) tryAbsorbOrSpin(best, now);
}

function onChoose(ctx, roomCode, room) {
  initKartRaceGame(ctx, roomCode, room);
}

function reconnectPayload(ctx, room, existingPlayer) {
  let viewerName = null;
  for (const [n, p] of room.players.entries()) {
    if (p === existingPlayer) {
      viewerName = n;
      break;
    }
  }
  return { ok: true, ...kartRaceStatePayload(ctx, room, viewerName) };
}

function onDisconnect(ctx, roomCode, room, name) {
  const kart = room.krKarts && room.krKarts[name];
  if (kart) {
    kart.speed = 0;
    kart.pendingInput = { steer: 0, braking: false };
  }
  broadcastKartRace(ctx, roomCode, room);
}

function onReconnectBroadcast(ctx, roomCode, room) {
  broadcastKartRace(ctx, roomCode, room);
}

function repairOnLoad(ctx, room) {
  if (!Array.isArray(room.krPlayers)) room.krPlayers = [];
  if (!room.krKarts || typeof room.krKarts !== 'object') room.krKarts = {};
  if (!Array.isArray(room.krItemBoxes)) room.krItemBoxes = initItemBoxes();
  if (!ctx || !ctx.rooms) return;

  const roomCode = findRoomCode(ctx, room);
  if (!roomCode) return;

  if (room.phase === 'racing') {
    startKartLoop(ctx, roomCode);
  } else if (room.phase === 'countdown') {
    // Lost in-memory countdown timeout — fast-forward into racing.
    room.phase = 'racing';
    room.krRaceStartAt = Date.now();
    startKartLoop(ctx, roomCode);
  }
}

function registerHandlers(ctx, io, socket) {
  socket.on('startKartRace', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'kartrace' || room.phase !== 'ready') {
      return callback({ ok: false, error: 'Not ready to start' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can start the race' });
    }
    const connected = ctx.connectedNames(room);
    if (connected.length < KR_MIN_PLAYERS) {
      return callback({ ok: false, error: `Need at least ${KR_MIN_PLAYERS} players` });
    }
    if (connected.length > KR_MAX_PLAYERS) {
      return callback({ ok: false, error: `Kart Race supports at most ${KR_MAX_PLAYERS} players` });
    }

    callback({ ok: true });
    beginCountdown(ctx, roomCode, room);
  });

  socket.on('krInput', (data, callback) => {
    callback = callback || (() => {});
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'kartrace') return callback({ ok: false, error: 'Wrong game' });
    if (room.phase !== 'racing' && room.phase !== 'countdown') {
      return callback({ ok: false, error: 'Race is not active' });
    }

    const name = socket.data.name;
    const kart = room.krKarts[name];
    if (!kart || kart.finished) return callback({ ok: false, error: 'Not racing' });

    let steer = Number(data && data.steer);
    if (steer !== -1 && steer !== 0 && steer !== 1) steer = 0;
    const braking = !!(data && data.braking);
    kart.pendingInput = { steer, braking };
    callback({ ok: true });
  });

  socket.on('krUseItem', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'kartrace' || room.phase !== 'racing') {
      return callback({ ok: false, error: 'Race is not running' });
    }

    const name = socket.data.name;
    const kart = room.krKarts[name];
    if (!kart || !kart.heldItem || kart.finished) {
      return callback({ ok: false, error: 'No item to use' });
    }

    const now = Date.now();
    const item = kart.heldItem;
    kart.heldItem = null;
    if (item === 'boost') {
      kart.boostUntil = now + KR_BOOST_DURATION_MS;
    } else if (item === 'shield') {
      kart.shieldUntil = now + KR_SHIELD_DURATION_MS;
    } else if (item === 'shell') {
      fireShell(room, name, kart, now);
    }

    callback({ ok: true });
    broadcastKartRace(ctx, roomCode, room);
  });

  socket.on('krEndRace', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'kartrace' || room.phase !== 'racing') {
      return callback({ ok: false, error: 'Race is not running' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can end the race' });
    }
    const someoneFinished = room.krPlayers.some((n) => room.krKarts[n] && room.krKarts[n].finished);
    if (!someoneFinished) {
      return callback({ ok: false, error: 'Wait for at least one kart to finish' });
    }

    callback({ ok: true });
    endKartRace(ctx, roomCode, room);
  });

  socket.on('playAgainKartRace', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'kartrace' || room.phase !== 'results') {
      return callback({ ok: false, error: 'No results to play again from' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can play again' });
    }
    if (ctx.connectedNames(room).length < KR_MIN_PLAYERS) {
      return callback({ ok: false, error: `Need at least ${KR_MIN_PLAYERS} players` });
    }

    callback({ ok: true });
    stopKartLoop(roomCode);
    clearCountdownHandle(roomCode);
    // Re-freeze roster from currently connected players, land in ready (not countdown).
    freezeRosterAndResetKarts(ctx, room);
    room.phase = 'ready';
    broadcastKartRace(ctx, roomCode, room);
  });
}

module.exports = {
  id: 'kartrace',
  minPlayers: KR_MIN_PLAYERS,
  maxPlayers: KR_MAX_PLAYERS,
  onChoose,
  registerHandlers,
  reconnectPayload,
  onDisconnect,
  onReconnectBroadcast,
  savedFields: SAVED_FIELDS,
  repairOnLoad,
  clearState,
  // Session-1 verification helpers (not part of the game contract)
  _test: {
    nearestTrackPoint,
    stepKartRace,
    startKartLoop,
    stopKartLoop,
    beginCountdown,
    endKartRace,
    createKart,
    TRACK_LENGTH,
    checkpointArc,
    trackData,
    KR_TICK_MS,
    KR_MAX_SPEED,
    KR_ITEM_PICKUP_RADIUS,
    KR_HAZARD_RADIUS,
    KR_KART_RADIUS,
    worldPosForWaypoint,
  },
};
