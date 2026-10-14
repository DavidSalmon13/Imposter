/**
 * Postgres connection for accounts and lifetime game history (see
 * plans/accounts-plan.md). Room state does NOT live here - it stays in the
 * in-memory `rooms` Map + rooms.json snapshot.
 *
 * Optional: with DATABASE_URL unset (e.g. local dev) the pool is null, `isEnabled()`
 * is false, and every caller skips its database work so the games still run.
 * SSL is controlled through the URL itself (append `?sslmode=require` for an
 * external connection; Railway's private network URL needs none).
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, max: 5 })
  : null;

if (pool) {
  // An idle client erroring (e.g. Postgres restarted) must not crash the game server.
  pool.on('error', (err) => console.error('Postgres pool error:', err.message));
}

let ready = false;

function isEnabled() {
  return ready;
}

function query(text, params) {
  return pool.query(text, params);
}

/** Runs fn(client) inside BEGIN/COMMIT, rolling back if it throws. */
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Applies every migrations/NNN_*.sql not yet recorded in schema_migrations, in
 * filename order, each in its own transaction.
 */
async function migrate() {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const { rows } = await pool.query('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    await transaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    console.log(`Applied migration ${file}`);
  }
}

/** Connects and migrates. Never throws: a database failure disables accounts, not the app. */
async function initDb() {
  if (!pool) {
    console.log('DATABASE_URL not set - accounts and game history disabled');
    return;
  }
  try {
    await migrate();
    ready = true;
    console.log('Postgres connected');
  } catch (err) {
    console.error('Postgres unavailable - accounts and game history disabled:', err.message);
  }
}

async function closeDb() {
  if (pool) await pool.end().catch(() => {});
}

module.exports = { initDb, closeDb, isEnabled, query, transaction };
