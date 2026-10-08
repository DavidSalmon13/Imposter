const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./persistence');

const STICKERS_DIR = path.join(__dirname, '..', 'public', 'images', 'stickers');
// Player-uploaded stickers live under DATA_DIR (the persisted volume) rather than
// public/, so they survive redeploys. server.js serves this dir at the same
// /images/stickers URL as the built-ins, so clients never need to tell them apart.
const CUSTOM_STICKERS_DIR = path.join(DATA_DIR, 'stickers');
// Uploaded files get this prefix so they can never collide with a built-in filename.
const CUSTOM_PREFIX = 'custom-';
// Disk-abuse guard; the picker is unusable well before this anyway.
const MAX_CUSTOM_STICKERS = 200;

const STICKER_MIME_EXT = {
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
};

const STICKER_FILE_RE = /\.(webp|png|gif|jpe?g)$/i;

function listDir(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => STICKER_FILE_RE.test(f)).sort() : [];
}

// Built-ins are read once at boot; custom ones are read at boot and appended on upload.
// The picker is populated from this same list via GET /api/stickers, so client and
// server can never disagree on what's valid.
const BUILTIN_FILES = listDir(STICKERS_DIR);
fs.mkdirSync(CUSTOM_STICKERS_DIR, { recursive: true });
const customFiles = listDir(CUSTOM_STICKERS_DIR).filter((f) => f.startsWith(CUSTOM_PREFIX));
const STICKER_IDS = new Set([...BUILTIN_FILES, ...customFiles]);

function stickerFiles() {
  return [...BUILTIN_FILES, ...customFiles];
}

function isValidSticker(id) {
  return typeof id === 'string' && STICKER_IDS.has(id);
}

/**
 * Saves an uploaded image into the shared bank. Returns { id } or { error }.
 */
function addCustomSticker(mimeType, buffer) {
  const ext = STICKER_MIME_EXT[mimeType];
  if (!ext) return { error: 'Unsupported image type' };
  if (!buffer || !buffer.length) return { error: 'Empty upload' };
  if (customFiles.length >= MAX_CUSTOM_STICKERS) return { error: 'The sticker bank is full' };

  // Timestamp first so uploads sort oldest-first and new ones land at the end of the grid.
  const id = `${CUSTOM_PREFIX}${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(CUSTOM_STICKERS_DIR, id), buffer);
  customFiles.push(id);
  STICKER_IDS.add(id);
  return { id };
}

module.exports = { CUSTOM_STICKERS_DIR, stickerFiles, isValidSticker, addCustomSticker };
