/**
 * Warfront client: the console's Produce cards. Per-race unit cards, prices, queue bars,
 * producing a unit. Must NOT contain: Build/Workshop cards (console/build.js).
 * Mockup: 2c-command-cards.html. Spec: "Production".
 */

import { S } from '../store.js';
import { sfx, haptics } from '../../../fx.js';
import { UNIT_SPRITES } from '../sprites.js';
import { el, feed } from '../util.js';
import { armyLabel, cardsEl, tabsEl } from '../dom.js';
import { serverNow } from '../clock.js';
import { HOTKEYS, CARD_NAMES, RACE_CARD_CLASS } from '../constants.js';
import { buildBuildCards, setTab } from './build.js';

/** A unit sprite with the `sp` class the console's sizing rules expect. */
function cardSprite(unitType) {
  const svg = UNIT_SPRITES[unitType] || '';
  return svg.includes('<svg class="') ? svg.replace('<svg class="', '<svg class="sp ') : svg.replace('<svg ', '<svg class="sp" ');
}

function myBaseTile() {
  const base = S.state && S.state.map && S.state.map.bases.find((b) => b.team === S.state.myTeam);
  return base ? base.tileId : null;
}

/** The race's unit cards, built once per battle (race and team never change mid-match). */
export function buildCards(data) {
  const key = `${data.myRace}|${data.myTeam}|${data.clock.startedAt}`;
  if (S.cardsFor === key) return;
  S.cardsFor = key;
  S.cardNodes.clear();
  cardsEl.innerHTML = '';
  cardsEl.className = `well tm-${data.myTeam || 'red'} ${RACE_CARD_CLASS[data.myRace] || ''}`;
  armyLabel.textContent = 'Watching · no army this match';
  const hasArmy = Boolean(data.catalog && data.catalog.length);
  armyLabel.classList.toggle('hidden', hasArmy);
  tabsEl.classList.toggle('hidden', !hasArmy);
  buildBuildCards(data);
  setTab(S.tab);
  (data.catalog || []).forEach((c) => {
    const btn = el('button', `cmd${c.structure ? ' struct' : ''}`);
    btn.type = 'button';
    const price = c.minerals ? `${c.supply} Supply and ${c.minerals} Minerals` : `${c.supply} Supply`;
    btn.setAttribute('aria-label', `Produce ${c.name}, costs ${price}`);
    btn.appendChild(el('span', 'hk')).textContent = HOTKEYS[c.unitType] || '';
    btn.appendChild(el('span', 'cc')).textContent = c.supply;
    if (c.minerals) btn.appendChild(el('span', 'wf-cm')).textContent = `💎${c.minerals}`;
    if (c.structure) btn.appendChild(el('span', 'tag')).textContent = 'STRUCTURE';
    const q = btn.appendChild(el('span', 'wf-q'));
    btn.appendChild(el('span', 'cs', cardSprite(c.unitType)));
    btn.appendChild(el('span', 'cn')).textContent = CARD_NAMES[c.unitType] || c.name;
    const bar = el('span', 'wf-qbar hidden', '<span style="width: 0%"></span>');
    btn.appendChild(bar);
    btn.addEventListener('click', () => produceUnit(c.unitType));
    cardsEl.appendChild(btn);
    S.cardNodes.set(c.unitType, { btn, q, bar, info: c, sig: '' });
  });
}

/** Where a new unit appears: your picked, finished Forward Barracks, else your base. */
function spawnTile() {
  const s2 = S.selStructure != null && S.live ? S.live.units.find((u) => u.id === S.selStructure) : null;
  if (s2 && s2.type === 'barracks' && !s2.buildDoneAt && s2.owner === S.state.you) return s2.tileId;
  return myBaseTile();
}

/** Greys out what you can't afford (or have no room for) and shows each type's queue. */
export function renderCards() {
  if (!S.live || !S.state) return;
  const me = S.live.me;
  const now = serverNow();
  const queued = new Map(); // unitType -> count
  const building = new Map(); // unitType -> progress 0..1 of the one at the front of a queue
  ((me && me.queues) || []).forEach(({ items }) => {
    items.forEach((it, i) => {
      queued.set(it.unitType, (queued.get(it.unitType) || 0) + 1);
      if (i === 0) {
        const p = Math.max(0, Math.min(1, (now - it.startedAt) / Math.max(1, it.doneAt - it.startedAt)));
        building.set(it.unitType, Math.max(building.get(it.unitType) || 0, p));
      }
    });
  });
  S.cardNodes.forEach((card, unitType) => {
    const c = card.info;
    const roomFor = me ? me.unitCap - me.units >= (unitType === 'summoner' ? 2 : 1) : false;
    const afford = Boolean(me) && me.supply >= c.supply && me.minerals >= c.minerals && roomFor;
    const n = queued.get(unitType) || 0;
    const sig = `${afford ? 1 : 0}|${n}`;
    if (sig !== card.sig) {
      card.sig = sig;
      card.btn.classList.toggle('dim', !afford);
      card.btn.classList.toggle('wf-busy', n > 0);
      card.q.textContent = n ? `×${n}` : '';
      card.bar.classList.toggle('hidden', !building.has(unitType));
    }
    if (building.has(unitType)) card.bar.firstChild.style.width = `${Math.round(building.get(unitType) * 100)}%`;
  });
}

export function produceUnit(unitType) {
  if (!S.state || S.state.phase !== 'playing' || !S.state.myTeam || !S.live || !S.live.me) return;
  const card = S.cardNodes.get(unitType);
  if (card) {
    card.btn.classList.add('on');
    setTimeout(() => card.btn.classList.remove('on'), 220);
  }
  haptics.tap();
  S.ctx.socket.emit('wfCommand', { kind: 'produce', unitType, atTileId: spawnTile() }, (res) => {
    if (res && !res.ok) {
      feed(res.error, 'amb');
      sfx.error();
      haptics.warn();
    } else {
      sfx.click();
    }
  });
}
