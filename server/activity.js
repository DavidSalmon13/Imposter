/**
 * In-memory feed of what's happening on the server (joins, leaves, games started and
 * finished, sign-ins, admin actions) for the admin page at /admin. Deliberately not
 * persisted - it's a live view, not an audit log - so a restart starts it empty.
 */
const MAX_ENTRIES = 500;

/** @type {{ id: number, at: number, type: string, message: string }[]} oldest first */
const entries = [];
let nextId = 1;

function logActivity(type, message) {
  entries.push({ id: nextId++, at: Date.now(), type, message: String(message).slice(0, 300) });
  if (entries.length > MAX_ENTRIES) entries.shift();
}

/** Newest first. */
function recentActivity(limit = 200) {
  return entries.slice(-limit).reverse();
}

module.exports = { logActivity, recentActivity };
