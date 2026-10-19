/**
 * Fallback avatar for players without a sticker: a stable animal emoji hashed from
 * their name. Shared by the lobby roster (main.js) and the Bluff table seats.
 */
const PLAYER_EMOJIS = ['🦊', '🐼', '🐸', '🐵', '🐯', '🐨', '🐷', '🐙', '🦁', '🐮', '🐰', '🐻', '🐔', '🦄', '🐢', '🦉', '🐝', '🐳', '🦋', '🐺'];

export function emojiForName(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return PLAYER_EMOJIS[hash % PLAYER_EMOJIS.length];
}
