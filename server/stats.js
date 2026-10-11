/**
 * Owner-only daily usage stats: unique visitors, unique players, games started per
 * game, and peak simultaneous players. Kept deliberately small and anonymous - the
 * only identifier is the random per-browser clientId the app already uses for
 * reconnects, and only today's ids are kept (to dedupe); past days keep just counts.
 *
 * Persisted to DATA_DIR/stats.json, separate from rooms.json, and viewed at /stats
 * behind the STATS_PASSWORD env var (the page and API are disabled when it's unset).
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { DATA_DIR } = require('./persistence');

const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const TIME_ZONE = 'Asia/Jerusalem';
const SAVE_DELAY_MS = 5000;
const MAX_FAILED_LOGINS = 10;
const LOCKOUT_MS = 15 * 60 * 1000;

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function today() {
  return dayFormatter.format(new Date()); // YYYY-MM-DD
}

// { days: { 'YYYY-MM-DD': { visitors, players, games: { [gameId]: n }, peakPlayers } },
//   idsDay, visitorIds: [...], playerIds: [...] }
let data = { days: {}, idsDay: null, visitorIds: [], playerIds: [] };
let visitorIds = new Set();
let playerIds = new Set();

function load() {
  try {
    if (!fs.existsSync(STATS_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    data = { ...data, ...parsed, days: parsed.days || {} };
    if (data.idsDay === today()) {
      visitorIds = new Set(data.visitorIds || []);
      playerIds = new Set(data.playerIds || []);
    }
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveStatsToDisk();
  }, SAVE_DELAY_MS);
}

async function saveStatsToDisk() {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const tmpFile = `${STATS_FILE}.tmp`;
    await fsp.writeFile(tmpFile, JSON.stringify({
      days: data.days,
      idsDay: data.idsDay,
      visitorIds: Array.from(visitorIds),
      playerIds: Array.from(playerIds),
    }));
    await fsp.rename(tmpFile, STATS_FILE);
  } catch (err) {
    console.error('Failed to save stats:', err);
  }
}

// Today's entry, rolling the dedupe sets over when the date changes.
function currentDay() {
  const day = today();
  if (data.idsDay !== day) {
    data.idsDay = day;
    visitorIds = new Set();
    playerIds = new Set();
  }
  if (!data.days[day]) data.days[day] = { visitors: 0, players: 0, games: {}, peakPlayers: 0 };
  return data.days[day];
}

function validId(clientId) {
  return typeof clientId === 'string' && clientId.length > 0 && clientId.length <= 64;
}

function recordVisit(clientId) {
  if (!validId(clientId)) return;
  const day = currentDay();
  if (visitorIds.has(clientId)) return;
  visitorIds.add(clientId);
  day.visitors += 1;
  scheduleSave();
}

function recordPlayer(clientId, playersInRoom) {
  const day = currentDay();
  if (playersInRoom > day.peakPlayers) day.peakPlayers = playersInRoom;
  if (validId(clientId) && !playerIds.has(clientId)) {
    playerIds.add(clientId);
    day.players += 1;
  }
  scheduleSave();
}

function recordGame(gameId) {
  const day = currentDay();
  day.games[gameId] = (day.games[gameId] || 0) + 1;
  scheduleSave();
}

function passwordMatches(given) {
  const expected = process.env.STATS_PASSWORD;
  if (!expected || typeof given !== 'string') return false;
  // Hash both so timingSafeEqual gets equal-length buffers regardless of input length.
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// Per-IP lockout after repeated wrong passwords, so the password can't be brute-forced.
const failedLogins = new Map(); // ip -> { count, since }

function registerStatsRoutes(app) {
  app.get('/stats', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'stats.html'));
  });

  app.post('/api/stats', express.json({ limit: '1kb' }), (req, res) => {
    if (!process.env.STATS_PASSWORD) return res.status(404).json({ ok: false, error: 'Stats are disabled' });

    const ip = req.ip;
    const now = Date.now();
    const fails = failedLogins.get(ip);
    if (fails && now - fails.since > LOCKOUT_MS) failedLogins.delete(ip);
    const current = failedLogins.get(ip);
    if (current && current.count >= MAX_FAILED_LOGINS) {
      return res.status(429).json({ ok: false, error: 'Too many attempts - try again later' });
    }

    if (!passwordMatches(req.body && req.body.password)) {
      if (current) current.count += 1;
      else failedLogins.set(ip, { count: 1, since: now });
      return res.status(401).json({ ok: false, error: 'Wrong password' });
    }

    failedLogins.delete(ip);
    currentDay();
    res.json({ ok: true, timeZone: TIME_ZONE, today: data.idsDay, days: data.days });
  });
}

load();

module.exports = {
  recordVisit,
  recordPlayer,
  recordGame,
  registerStatsRoutes,
  saveStatsToDisk,
};
