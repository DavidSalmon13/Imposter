/**
 * Shared reaction row: a small, always-visible (once joined) row of curated stickers that
 * broadcast a brief floating reaction to everyone in the room, independent of whichever
 * game is active. Visibility is driven by shared/dom.js's showScreen (hidden on join/
 * restoring). Keep this list in sync with server/lobby.js's REACTION_STICKERS.
 */

import { haptics } from '../fx.js';

const REACTION_STICKERS = [
  '7818f961-efbf-41e6-94ee-99d8934cf823.webp',
  'ff6eca8a-9135-4b94-85e9-04ab02f464e6.webp',
  '1fc18b9d-116d-4b73-840e-ccc8ddb1a45c.webp',
  'bf45b8f8-461a-4b2a-a697-377c8d7ad371.webp',
  '65e3b128-db99-4452-bc02-45d7d1602674.webp',
  '34252cf1-c888-481a-a846-359f70cc47aa.webp',
];

// Mirrors the client-side cooldown the row itself enforces via disabled buttons - this is
// just a floor so a flood of 'reaction' events from one sender (e.g. a buggy/hostile client
// ignoring its own disabled state) can't spawn unbounded floating nodes. Keyed per sender
// name so one player reacting never suppresses another player's reaction landing right
// after it.
const FLOAT_COOLDOWN_MS = 500;
const COOLDOWN_MS = 600;

const row = document.getElementById('reaction-row');
const floatLayer = document.getElementById('reaction-float-layer');

let socket = null;
let cooling = false;
const lastFloatAtByName = new Map();

function spawnFloat(name, sticker) {
  if (!floatLayer) return;
  const now = Date.now();
  const lastFloatAt = lastFloatAtByName.get(name) || 0;
  if (now - lastFloatAt < FLOAT_COOLDOWN_MS) return;
  lastFloatAtByName.set(name, now);

  const el = document.createElement('div');
  el.className = 'reaction-float';
  // Spread floats horizontally so a burst of reactions doesn't stack directly on top of
  // each other; stays clear of the row (left) and corner pick panels (right).
  el.style.left = `${18 + Math.random() * 54}%`;

  const img = document.createElement('img');
  img.src = `images/stickers/${sticker}`;
  img.alt = '';
  el.appendChild(img);

  if (name) {
    const label = document.createElement('span');
    label.textContent = name;
    el.appendChild(label);
  }

  floatLayer.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

export function initReactions(nextSocket) {
  socket = nextSocket;
  if (!row) return;

  REACTION_STICKERS.forEach((sticker) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'reaction-btn';
    const img = document.createElement('img');
    img.src = `images/stickers/${sticker}`;
    img.alt = 'React';
    btn.appendChild(img);
    btn.addEventListener('click', () => {
      if (cooling) return;
      cooling = true;
      row.querySelectorAll('.reaction-btn').forEach((b) => (b.disabled = true));
      setTimeout(() => {
        cooling = false;
        row.querySelectorAll('.reaction-btn').forEach((b) => (b.disabled = false));
      }, COOLDOWN_MS);

      haptics.tap();
      socket.emit('sendReaction', sticker, () => {});
    });
    row.appendChild(btn);
  });

  socket.on('reaction', ({ name, sticker }) => spawnFloat(name, sticker));
}
