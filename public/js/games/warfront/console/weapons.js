/**
 * Warfront client: the console's Weapons tab (plan Step 10). One card per weapon in your arsenal,
 * then firing mode: tap a card to arm it (lit green), tap a target tile on the map to fire; tap the
 * card again (or Escape) to stand down. Must NOT contain: target hints on the map (structures.js),
 * the map tap itself (input.js), weapon FX (fx.js). Spec: "Special weapons"; 2c-command-cards.html.
 */

import { S } from '../store.js';
import { sfx, haptics } from '../../../fx.js';
import { weaponSprite } from '../sprites.js';
import { el, feed } from '../util.js';
import { weaponCardsEl, weaponTabCountEl } from '../dom.js';
import { WEAPON_NAMES, WEAPON_IDS, WEAPON_INFO, RACE_CARD_CLASS } from '../constants.js';
import { renderBuildHints } from '../structures.js';
import { renderInfo } from './selection.js';
import { setTab } from './build.js';

/** The five weapon cards (the Workshop card's look), each with how many you hold. */
export function buildWeaponCards(data) {
  S.weaponCardNodes.clear();
  weaponCardsEl.innerHTML = '';
  weaponCardsEl.className = `well tm-${data.myTeam || 'red'} ${RACE_CARD_CLASS[data.myRace] || ''}${S.tab === 'weapons' ? '' : ' hidden'}`;
  WEAPON_IDS.forEach((weaponId) => {
    const btn = el('button', 'cmd wf-wcard wf-fcard');
    btn.type = 'button';
    btn.title = WEAPON_INFO[weaponId] || '';
    const q = btn.appendChild(el('span', 'cc wf-held'));
    btn.appendChild(el('span', 'cs', weaponSprite(weaponId)));
    btn.appendChild(el('span', 'cn')).textContent = WEAPON_NAMES[weaponId];
    btn.addEventListener('click', () => armWeapon(weaponId));
    weaponCardsEl.appendChild(btn);
    S.weaponCardNodes.set(weaponId, { btn, q, sig: '' });
  });
}

/** How many of `weaponId` your arsenal holds right now. */
function held(weaponId) {
  const me = S.live && S.live.me;
  return me ? (me.arsenal || []).filter((w) => w === weaponId).length : 0;
}

/** Cards: dim when you hold none, ×N in the corner, lit while armed. Stands down a weapon you no longer hold. */
export function renderWeaponCards() {
  if (!S.live || !S.state) return;
  if (S.fireMode && !held(S.fireMode)) S.fireMode = null;
  const total = S.live.me ? (S.live.me.arsenal || []).length : 0;
  weaponTabCountEl.textContent = total ? ` ${total}` : '';
  S.weaponCardNodes.forEach((card, weaponId) => {
    const n = held(weaponId);
    const sig = `${n}|${S.fireMode === weaponId ? 1 : 0}`;
    if (sig === card.sig) return;
    card.sig = sig;
    card.btn.classList.toggle('dim', !n);
    card.btn.classList.toggle('on', S.fireMode === weaponId);
    card.q.textContent = n ? `×${n}` : '0';
    card.btn.setAttribute('aria-label', `${WEAPON_NAMES[weaponId]}: ${n} in your arsenal${n ? ', tap to aim' : ''}`);
  });
}

/** A card with weapons left arms firing mode (build mode stands down); tapping the armed card disarms it. */
export function armWeapon(weaponId) {
  if (!S.state || S.state.phase !== 'playing' || !S.state.myTeam) return;
  if (S.tab !== 'weapons') setTab('weapons');
  if (!held(weaponId)) {
    feed(`No ${WEAPON_NAMES[weaponId]} in your arsenal · pick one up or craft it at a Workshop`, 'amb');
    sfx.error();
    return;
  }
  S.fireMode = S.fireMode === weaponId ? null : weaponId;
  S.buildMode = null;
  S.mode = 'move';
  sfx.click();
  haptics.tap();
  renderWeaponCards();
  renderBuildHints();
  renderInfo();
}

/** Fires the armed weapon at `tileId`. The server has the last word on the aim. */
export function fireAt(tileId) {
  const weaponId = S.fireMode;
  if (!weaponId) return;
  haptics.tap();
  S.ctx.socket.emit('wfCommand', { kind: 'weapon', weaponId, targetTileId: tileId }, (res) => {
    if (res && !res.ok) {
      feed(res.error, 'amb');
      sfx.error();
      haptics.warn();
      return;
    }
    sfx.click();
    if (S.fireMode === weaponId) S.fireMode = null;
    renderWeaponCards();
    renderBuildHints();
    if (S.live) renderInfo();
  });
}
