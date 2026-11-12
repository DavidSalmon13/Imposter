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
import { HOTKEYS, CARD_NAMES, RACE_CARD_CLASS, UNIT_STATS, UNIT_MAX_HP, UNIT_INFO } from '../constants.js';
import { buildBuildCards, setTab } from './build.js';
import { renderInfo } from './selection.js';
import { batchFit, batchNotice } from '../batch.js';

const LORE_MS = 5000; // how long a long-pressed card's description stays in the info well
const PRESS_MS = 420; // a press this long shows the description instead of producing

/** A unit sprite with the `sp` class the console's sizing rules expect. */
function cardSprite(unitType) {
  const svg = UNIT_SPRITES[unitType] || '';
  return svg.includes('<svg class="') ? svg.replace('<svg class="', '<svg class="sp ') : svg.replace('<svg ', '<svg class="sp" ');
}

/** A card's compact stats: ⚔ power, ❤ HP, ◎ range (fighters only) and » per speed step. */
function cardStats(unitType) {
  const st = UNIT_STATS[unitType];
  if (!st) return `❤${UNIT_MAX_HP[unitType] || '?'}`;
  const bits = [];
  if (st.atk) bits.push(`<b class="a">⚔${st.atk}</b>`);
  bits.push(`<b class="h">❤${st.hp}</b>`);
  if (st.atk && st.range >= 2) bits.push(`<b class="r">◎${st.range}</b>`);
  if (st.move > 0) bits.push(`<b class="s">${'»'.repeat(st.move)}</b>`);
  return bits.join('');
}

/** Long-press a card: its description and full stats show in the info well for a few seconds. */
function showLore(unitType) {
  S.lore = { type: unitType, until: Date.now() + LORE_MS };
  S.inspect = null;
  haptics.tap();
  if (S.live && S.state) renderInfo();
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
    btn.appendChild(el('span', 'wf-cstat', cardStats(c.unitType)));
    btn.title = UNIT_INFO[c.unitType] || '';
    // A long press reads the unit's description; a tap produces it.
    let pressTimer = 0;
    let pressed = false;
    btn.addEventListener('pointerdown', () => {
      pressed = false;
      clearTimeout(pressTimer);
      pressTimer = setTimeout(() => {
        pressed = true;
        showLore(c.unitType);
      }, PRESS_MS);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, () => clearTimeout(pressTimer)));
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      if (pressed) {
        pressed = false;
        return;
      }
      produceUnit(c.unitType);
    });
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
  const want = S.produceBatch || 1;
  // ×5: as many as Supply, Minerals and the cap allow (at least one try, so a refusal still
  // shows the server's reason), sent one after another and stopping at the first refusal.
  const fit = want > 1 && card ? batchFit(S.live.me, { supply: card.info.supply, minerals: card.info.minerals, slots: unitType === 'summoner' ? 2 : 1 }, want) : null;
  const total = fit ? Math.max(1, fit.n) : 1;
  const at = spawnTile();
  let sent = 0;
  const next = () => {
    S.ctx.socket.emit('wfCommand', { kind: 'produce', unitType, atTileId: at }, (res) => {
      if (res && !res.ok) {
        feed(sent ? `${batchNotice(sent, want, null)} · ${res.error}` : res.error, 'amb');
        sfx.error();
        haptics.warn();
        return;
      }
      sent++;
      if (sent < total) return next();
      sfx.click();
      if (want > 1) feed(batchNotice(sent, want, sent < want ? fit.short : null), sent < want ? 'amb' : undefined);
    });
  };
  next();
}
