/**
 * Warfront client: the console's Produce/Build tabs, Build cards (arming a facility for
 * placement) and the Workshop's weapon cards (crafting). Must NOT contain: placement hints
 * (structures.js). Plan Step 9; mockup 2c-command-cards.html.
 */

import { S } from '../store.js';
import { sfx, haptics } from '../../../fx.js';
import { weaponSprite, FACILITY_SPRITES } from '../sprites.js';
import { el, feed } from '../util.js';
import { cardsEl, tabBtn, buildCardsEl, craftCardsEl, weaponCardsEl } from '../dom.js';
import { serverNow } from '../clock.js';
import { renderUnits } from '../units.js';
import {
  FACILITY_TYPES,
  WEAPON_NAMES,
  WEAPON_IDS,
  RACE_CARD_CLASS,
  BUILD_HOTKEYS,
  BUILD_CARD_NAMES,
} from '../constants.js';
import { renderBuildHints } from '../structures.js';
import { renderInfo } from './selection.js';

/** The Build tab's facility cards (2c's square structure frames) and the Workshop's weapon cards. */
export function buildBuildCards(data) {
  S.buildCardNodes.clear();
  S.craftCardNodes.clear();
  buildCardsEl.innerHTML = '';
  craftCardsEl.innerHTML = '';
  buildCardsEl.className = `well tm-${data.myTeam || 'red'} ${RACE_CARD_CLASS[data.myRace] || ''}`;
  craftCardsEl.className = `well tm-${data.myTeam || 'red'} ${RACE_CARD_CLASS[data.myRace] || ''}`;
  (data.buildCatalog || []).forEach((c) => {
    const btn = el('button', 'cmd struct wf-bcard');
    btn.type = 'button';
    btn.setAttribute('aria-label', `Build a ${c.name}, costs ${c.minerals} Minerals`);
    btn.appendChild(el('span', 'hk')).textContent = BUILD_HOTKEYS[c.facility] || '';
    btn.appendChild(el('span', 'cc')).textContent = `💎${c.minerals}`;
    const q = btn.appendChild(el('span', 'wf-q'));
    btn.appendChild(el('span', 'cs', FACILITY_SPRITES[c.facility].svg));
    btn.appendChild(el('span', 'cn')).textContent = BUILD_CARD_NAMES[c.facility] || c.name;
    const bar = el('span', 'wf-qbar hidden', '<span style="width: 0%"></span>');
    btn.appendChild(bar);
    btn.addEventListener('click', () => armBuild(c.facility));
    buildCardsEl.appendChild(btn);
    S.buildCardNodes.set(c.facility, { btn, q, bar, info: c, sig: '' });
  });
  WEAPON_IDS.forEach((weaponId) => {
    const btn = el('button', 'cmd wf-wcard');
    btn.type = 'button';
    btn.setAttribute('aria-label', `Craft ${WEAPON_NAMES[weaponId]}, costs ${data.weaponCost} Minerals`);
    btn.appendChild(el('span', 'cc')).textContent = `💎${data.weaponCost}`;
    const q = btn.appendChild(el('span', 'wf-q'));
    btn.appendChild(el('span', 'cs', weaponSprite(weaponId)));
    btn.appendChild(el('span', 'cn')).textContent = WEAPON_NAMES[weaponId];
    const bar = el('span', 'wf-qbar hidden', '<span style="width: 0%"></span>');
    btn.appendChild(bar);
    btn.addEventListener('click', () => craftWeapon(weaponId));
    craftCardsEl.appendChild(btn);
    S.craftCardNodes.set(weaponId, { btn, q, bar, sig: '' });
  });
}

/** Your picked, finished Workshop (its weapon cards replace the tab's cards), or null. */
function pickedWorkshop() {
  const u = S.selStructure != null && S.live ? S.live.units.find((x) => x.id === S.selStructure) : null;
  return u && u.type === 'workshop' && !u.buildDoneAt && u.owner === S.state.you ? u : null;
}

/** Shows one card well under the resources row: a picked Workshop's weapons, else the tab's cards. */
function syncWells() {
  const hasArmy = Boolean(S.state && S.state.catalog && S.state.catalog.length);
  const shop = hasArmy && Boolean(pickedWorkshop());
  tabBtn.produce.classList.toggle('on', !shop && S.tab === 'produce');
  tabBtn.build.classList.toggle('on', !shop && S.tab === 'build');
  tabBtn.weapons.classList.toggle('on', !shop && S.tab === 'weapons');
  cardsEl.classList.toggle('hidden', !hasArmy || shop || S.tab !== 'produce');
  buildCardsEl.classList.toggle('hidden', !hasArmy || shop || S.tab !== 'build');
  weaponCardsEl.classList.toggle('hidden', !hasArmy || shop || S.tab !== 'weapons');
  craftCardsEl.classList.toggle('hidden', !shop);
}

/** Produce, Build or Weapons. Picking a tab also lets go of a picked Workshop; leaving one stands its mode down. */
export function setTab(next) {
  S.tab = next;
  if (S.tab !== 'build') S.buildMode = null;
  if (S.tab !== 'weapons') S.fireMode = null;
  if (pickedWorkshop()) S.selStructure = null;
  syncWells();
  renderBuildCards();
  renderBuildHints();
  if (S.live) {
    renderUnits();
    renderInfo();
  }
}

/** A Build card arms placement (the next map tap builds it); tapping it again disarms. */
export function armBuild(facility) {
  if (!S.state || S.state.phase !== 'playing' || !S.state.myTeam) return;
  if (S.tab !== 'build') setTab('build');
  S.buildMode = S.buildMode === facility ? null : facility;
  S.fireMode = null;
  S.mode = 'move';
  sfx.click();
  haptics.tap();
  renderBuildCards();
  renderBuildHints();
  renderInfo();
}

function craftWeapon(weaponId) {
  if (!S.state || S.state.phase !== 'playing' || !S.state.myTeam) return;
  const card = S.craftCardNodes.get(weaponId);
  if (card) {
    card.btn.classList.add('on');
    setTimeout(() => card.btn.classList.remove('on'), 220);
  }
  haptics.tap();
  S.ctx.socket.emit('wfCommand', { kind: 'craft', weaponId }, (res) => {
    if (res && !res.ok) {
      feed(res.error, 'amb');
      sfx.error();
      haptics.warn();
    } else {
      sfx.click();
    }
  });
}

/** Build cards: greyed when short of 💎 or at the cap, lit while armed, a bar for sites going up; a picked Workshop's weapons. */
export function renderBuildCards() {
  if (!S.live || !S.state) return;
  syncWells();
  const me = S.live.me;
  const now = serverNow();
  const mine = S.live.units.filter((u) => u.owner === S.state.you && FACILITY_TYPES.has(u.type));
  S.buildCardNodes.forEach((card, facility) => {
    const afford = Boolean(me) && me.minerals >= card.info.minerals && me.units < me.unitCap;
    const sites = mine.filter((u) => u.type === facility && u.buildDoneAt);
    const sig = `${afford ? 1 : 0}|${sites.length}|${S.buildMode === facility ? 1 : 0}`;
    if (sig !== card.sig) {
      card.sig = sig;
      card.btn.classList.toggle('dim', !afford);
      card.btn.classList.toggle('on', S.buildMode === facility);
      card.btn.classList.toggle('wf-busy', sites.length > 0);
      card.q.textContent = sites.length ? `×${sites.length}` : '';
      card.bar.classList.toggle('hidden', !sites.length);
    }
    if (sites.length) {
      const total = card.info.buildMs || 1;
      const p = Math.max(...sites.map((u) => 1 - (u.buildDoneAt - now) / total));
      card.bar.firstChild.style.width = `${Math.round(Math.max(0, Math.min(1, p)) * 100)}%`;
    }
  });
  if (!pickedWorkshop() || !me) return;
  const queue = me.workshop || [];
  S.craftCardNodes.forEach((card, weaponId) => {
    const afford = me.minerals >= (S.state.weaponCost || 6);
    const n = queue.filter((w) => w.weaponId === weaponId).length;
    const front = queue[0] && queue[0].weaponId === weaponId ? queue[0] : null;
    const sig = `${afford ? 1 : 0}|${n}|${front ? 1 : 0}`;
    if (sig !== card.sig) {
      card.sig = sig;
      card.btn.classList.toggle('dim', !afford);
      card.btn.classList.toggle('wf-busy', n > 0);
      card.q.textContent = n ? `×${n}` : '';
      card.bar.classList.toggle('hidden', !front);
    }
    if (front) {
      const p = Math.max(0, Math.min(1, (now - front.startedAt) / Math.max(1, front.doneAt - front.startedAt)));
      card.bar.firstChild.style.width = `${Math.round(p * 100)}%`;
    }
  });
}
