const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { rooms, createRoomState } = require('./roomStore');
const { ROOM_SAVED_FIELDS, repairRoomOnLoad } = require('./gameRegistry');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
const SAVE_INTERVAL_MS = 5000;

// Guards against two saves writing the same tmp file concurrently if a
// write ever takes longer than SAVE_INTERVAL_MS - the sync version this
// replaced couldn't overlap by construction, so this keeps that invariant.
let saveInFlight = false;

async function saveRoomsToDisk() {
  if (saveInFlight) return;
  saveInFlight = true;
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const serialized = {};
    for (const [code, room] of rooms) {
      const data = { players: Array.from(room.players.entries()) };
      for (const field of ROOM_SAVED_FIELDS) data[field] = room[field];
      serialized[code] = data;
    }
    const tmpFile = `${ROOMS_FILE}.tmp`;
    await fsp.writeFile(tmpFile, JSON.stringify(serialized));
    await fsp.rename(tmpFile, ROOMS_FILE);
  } catch (err) {
    console.error('Failed to save rooms to disk:', err);
  } finally {
    saveInFlight = false;
  }
}

/**
 * Load rooms from disk. Per-game mid-round repair delegates to each module's
 * repairOnLoad via the registry.
 */
function loadRoomsFromDisk(hooks = {}) {
  const { ctx } = hooks;

  if (!fs.existsSync(ROOMS_FILE)) return;
  try {
    const raw = fs.readFileSync(ROOMS_FILE, 'utf8');
    const serialized = JSON.parse(raw);
    for (const [code, data] of Object.entries(serialized)) {
      const room = createRoomState();
      for (const field of ROOM_SAVED_FIELDS) {
        if (data[field] !== undefined) room[field] = data[field];
      }
      room.players = new Map(
        (data.players || []).map(([name, p]) => [name, { ...p, connected: false, socketId: null }])
      );
      if (!room.scoreboard || typeof room.scoreboard !== 'object') room.scoreboard = {};
      if (!Array.isArray(room.tsEliminationWaves)) room.tsEliminationWaves = [];
      rooms.set(code, room);
      repairRoomOnLoad(ctx || { rooms }, room);
    }
    console.log(`Loaded ${rooms.size} room(s) from ${ROOMS_FILE}`);
  } catch (err) {
    console.error('Failed to load rooms from disk:', err);
  }
}

module.exports = {
  DATA_DIR,
  ROOMS_FILE,
  SAVE_INTERVAL_MS,
  ROOM_SAVED_FIELDS,
  saveRoomsToDisk,
  loadRoomsFromDisk,
};
