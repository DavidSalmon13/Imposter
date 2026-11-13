/**
 * Warfront client: small shared helpers. Element builder, per-tile noise, socket emit with
 * error flash, and the notice feed over the map. Must NOT contain: rendering of a screen.
 */

import { S } from './store.js';
import { sfx, haptics } from '../../fx.js';
import { errorEl, feedEl } from './dom.js';
import { SIDE } from './sides.js';

export function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html != null) node.innerHTML = html;
  return node;
}

export function flashError(msg) {
  clearTimeout(S.errorTimer);
  errorEl.classList.remove('wf-notice');
  errorEl.textContent = msg || '';
  if (msg) {
    sfx.error();
    haptics.warn();
    S.errorTimer = setTimeout(() => {
      errorEl.textContent = '';
    }, 3500);
  }
}

export function emit(event, ...args) {
  S.ctx.socket.emit(event, ...args, (res) => {
    if (res && !res.ok) flashError(res.error);
  });
}

/** Deterministic 0..1 noise per tile, so every phone decorates the map the same way. */
export function noise(tileId, k) {
  let h = Math.imul((tileId + 1) * 374761393 + k * 668265263, 1274126177) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** One line in the map's notice overlay (the mockup's "[Team] …" lines); fades by itself. */
export function feed(text, tone = 'grn') {
  const line = el('span', tone === 'grn' ? 'grn' : '');
  // 'amb' for warnings; a side ('red' … 'gold') for that side's news in its HUD colour.
  if (tone !== 'grn') line.style.color = SIDE[tone] ? SIDE[tone].label : '#ffcc33';
  line.textContent = text;
  feedEl.appendChild(line);
  while (feedEl.children.length > 3) feedEl.firstChild.remove();
  setTimeout(() => line.remove(), 3500);
}
