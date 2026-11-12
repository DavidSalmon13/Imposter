/**
 * Warfront client: the camera. Syncing the minimap view box, centring on a tile, and mouse
 * drag panning on desktop. Must NOT contain: world building. Mockup: 2-battlefield.html.
 */

import { S } from './store.js';
import { TILE } from './constants.js';
import { vp, cam, world, edgeL, edgeR } from './dom.js';
import { tileCentre } from './world/geometry.js';

/** Viewport box on the minimap + the ◀ ▶ edge hints. */
export function syncView() {
  if (!S.miniView || !cam.offsetWidth) return;
  const k = 0.1;
  const camH = cam.offsetHeight;
  const worldH = parseFloat(world.style.height) || camH;
  const yScale = worldH / camH; // screen px -> world px (approximate under the tilt)
  Object.assign(S.miniView.style, {
    left: `${vp.scrollLeft * k}px`,
    top: `${vp.scrollTop * yScale * k}px`,
    width: `${Math.min(vp.clientWidth, cam.offsetWidth) * k}px`,
    height: `${Math.min(vp.clientHeight * yScale, worldH) * k}px`,
  });
  edgeL.classList.toggle('hidden', vp.scrollLeft <= 4);
  edgeR.classList.toggle('hidden', vp.scrollLeft + vp.clientWidth >= vp.scrollWidth - 4);
}

/** Centre the camera on a tile (scrolls the viewport). */
export function lookAt(map, tileId) {
  const c = tileCentre(map, tileId);
  const camH = cam.offsetHeight;
  const worldH = map.height * TILE;
  vp.scrollLeft = c.x - vp.clientWidth / 2;
  vp.scrollTop = (c.y / worldH) * camH - vp.clientHeight / 2;
  syncView();
}

/** Mouse drag-to-pan (touch already pans the scrolling viewport natively). */
export function enableMousePan() {
  let drag = null;
  vp.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, left: vp.scrollLeft, top: vp.scrollTop, moved: false };
  });
  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    vp.scrollLeft = drag.left - dx;
    vp.scrollTop = drag.top - dy;
  });
  window.addEventListener('pointerup', () => {
    if (drag && drag.moved) S.suppressClickUntil = Date.now() + 50;
    drag = null;
  });
}
