const fs = require('fs');
const path = require('path');

const STICKERS_DIR = path.join(__dirname, '..', 'public', 'images', 'stickers');

// Read once at boot - the picker is populated from this same list via GET /api/stickers,
// so client and server can never disagree on what's valid.
const STICKER_FILES = fs.existsSync(STICKERS_DIR)
  ? fs.readdirSync(STICKERS_DIR).filter((f) => /\.(webp|png|gif|jpe?g)$/i.test(f)).sort()
  : [];
const STICKER_IDS = new Set(STICKER_FILES);

function isValidSticker(id) {
  return typeof id === 'string' && STICKER_IDS.has(id);
}

module.exports = { STICKER_FILES, isValidSticker };
