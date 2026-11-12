/**
 * Warfront client: what is selected and what you can do with it. The info well (stack,
 * structure or battlefield lore), the Move/Haul/Hold buttons, sending orders.
 * Must NOT contain: map tap handling (input.js). Mockup: 2-battlefield.html console.
 */

import { S } from '../store.js';
import { sfx, haptics } from '../../../fx.js';
import { UNIT_SPRITES, CASTLE_SPRITE, FACILITY_SPRITES } from '../sprites.js';
import { el, feed } from '../util.js';
import {
  RACE_NAMES,
  FACILITY_NAMES,
  FACILITY_ORDERS,
  UNIT_MAX_HP,
  UNIT_NAMES,
  WORKER_TYPES,
} from '../constants.js';
import { infoPortrait, infoTitle, infoSub, infoHp, infoOrder, cmdBtn } from '../dom.js';
import { serverNow } from '../clock.js';

const plural = (name, n) => (n === 1 ? name : name.endsWith('man') ? `${name.slice(0, -3)}men` : `${name}s`);
const areaName = (map, id) => `${map.tiles[id]} ${Math.floor(id / map.width) + 1}-${(id % map.width) + 1}`;

/** The console's info well: the selected stack (mockup), or the battlefield's name and lore. */
export function renderInfo() {
  const { map } = S.state;
  const team = S.state.myTeam || 'red';
  const sel = S.live.units.filter((u) => u.owner === S.state.you && S.selected.has(u.id));
  infoPortrait.className = `scan tm-${team}`;
  // Only rebuild the portrait and HP pips when they change: re-parsing the SVG every
  // snapshot (5×/s) cost a layout each time and restarted the portrait's animations.
  const hpSig = sel.slice(0, 10).map((u) => `${u.type}:${u.hp}`).join(',');
  const lead0 = sel.length ? sel.map((u) => u.type).sort().join(',') : 'castle';
  const changed = (key, value) => {
    if (S.infoSig[key] === value) return false;
    S.infoSig[key] = value;
    return true;
  };
  const struct = !sel.length && S.selStructure != null ? S.live.units.find((u) => u.id === S.selStructure) : null;
  const portraitChanged = changed('portrait', struct ? `s:${struct.type}` : lead0);
  const hpChanged = changed('hp', struct ? `s:${struct.hp}` : hpSig);
  if (hpChanged) infoHp.innerHTML = '';
  if (struct) {
    const art = FACILITY_SPRITES[struct.type];
    if (portraitChanged) infoPortrait.innerHTML = art.svg.replace('<svg ', '<svg style="width: 46px; height: 46px; overflow: visible" ');
    infoTitle.textContent = FACILITY_NAMES[struct.type];
    const max = UNIT_MAX_HP[struct.type];
    infoSub.textContent = struct.buildDoneAt
      ? `Under construction · ${Math.max(0, Math.ceil((struct.buildDoneAt - serverNow()) / 1000))}s`
      : `${RACE_NAMES[S.state.myRace]} · HP ${Math.ceil(struct.hp)}/${max}${struct.type === 'workshop' && S.live.me ? ` · arsenal ${(S.live.me.arsenal || []).length}` : ''}`;
    if (hpChanged) {
      const c = struct.hp / max >= 0.75 ? '#4dff7a' : '#ffcc33';
      const pip = el('span');
      Object.assign(pip.style, { width: `${Math.max(4, Math.round((struct.hp / max) * 60))}px`, height: '5px', background: c, boxShadow: `0 0 4px ${c}` });
      infoHp.appendChild(pip);
    }
    infoOrder.textContent = S.buildMode ? buildOrderText() : struct.buildDoneAt ? '▸ BEING BUILT · IT WORKS ONCE IT STANDS' : FACILITY_ORDERS[struct.type];
    renderSys();
    return;
  }
  if (!sel.length) {
    if (portraitChanged) infoPortrait.innerHTML = CASTLE_SPRITE.replace('<svg ', '<svg style="width: 44px; height: 44px; overflow: visible" ');
    infoTitle.textContent = map.theme;
    infoSub.textContent = map.lore || '';
    infoOrder.textContent = S.buildMode ? buildOrderText() : S.state.myTeam ? '▸ TAP YOUR UNITS TO COMMAND THEM' : '';
    renderSys();
    return;
  }
  const counts = new Map();
  sel.forEach((u) => counts.set(u.type, (counts.get(u.type) || 0) + 1));
  const [lead] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (portraitChanged) infoPortrait.innerHTML = (UNIT_SPRITES[lead] || '').replace('<svg ', '<svg style="width: 40px; height: 50px; overflow: visible" ');
  infoTitle.textContent = counts.size === 1 ? `${plural(UNIT_NAMES[lead], sel.length)} ×${sel.length}` : `Squad ×${sel.length}`;
  const here = sel[0].tileId;
  infoSub.textContent = `${RACE_NAMES[S.state.myRace]} · ${map.tiles[here]}`;
  if (hpChanged) sel.slice(0, 10).forEach((u) => {
    const max = UNIT_MAX_HP[u.type] || u.hp;
    const c = u.hp / max >= 0.75 ? '#4dff7a' : '#ffcc33';
    const pip = el('span');
    Object.assign(pip.style, { width: '20px', height: '5px', background: c, boxShadow: `0 0 4px ${c}` });
    infoHp.appendChild(pip);
  });
  const dest = sel.find((u) => u.path && u.path.length);
  const hauler = sel.find((u) => u.haul);
  const cap = S.state.carryCap || 4;
  let order;
  if (S.buildMode) order = buildOrderText();
  else if (S.mode === 'haul') order = '▸ TAP A MINERAL VEIN TO HAUL';
  else if (hauler && hauler.haul.stage === 'loading') order = `▸ HAULING · LOADING 💎 ${Math.floor(hauler.carrying * 10) / 10}/${cap}`;
  else if (hauler && hauler.haul.stage === 'toDeposit') order = `▸ HAULING · 💎 ${Math.round(hauler.carrying)} → ${S.structureTiles.has(hauler.path && hauler.path.length ? hauler.path[hauler.path.length - 1] : -1) ? 'REFINERY' : 'BASE'}`;
  else if (hauler) order = '▸ HAULING · TO THE VEIN';
  else if (dest) order = `▸ MOVE → ${areaName(map, dest.path[dest.path.length - 1]).toUpperCase()}`;
  else if (sel.every((u) => u.holding)) order = '▸ HOLDING · TAP A TILE TO MOVE';
  else order = '▸ TAP A TILE TO MOVE';
  infoOrder.textContent = order;
}

function buildOrderText() {
  return S.buildMode === 'refinery'
    ? '▸ TAP A GREEN TILE BY A VEIN FOR THE REFINERY'
    : `▸ TAP A GREEN TILE TO BUILD THE ${(FACILITY_NAMES[S.buildMode] || '').toUpperCase()}`;
}

export function selectedUnits() {
  if (!S.live || !S.state) return [];
  return S.live.units.filter((u) => u.owner === S.state.you && S.selected.has(u.id));
}

/** Move / Haul / Hold: lit for what the selection can do, green for the tap mode in use. */
export function renderSys() {
  const sel = selectedUnits();
  const workers = sel.some((u) => WORKER_TYPES.has(u.type));
  if (S.mode === 'haul' && !workers) S.mode = 'move';
  cmdBtn.move.classList.toggle('dim', !sel.length);
  cmdBtn.move.classList.toggle('on', Boolean(sel.length) && S.mode === 'move');
  cmdBtn.haul.classList.toggle('dim', !workers);
  cmdBtn.haul.classList.toggle('on', workers && S.mode === 'haul');
  cmdBtn.hold.classList.toggle('dim', !sel.length);
  cmdBtn.hold.classList.toggle('on', Boolean(sel.length) && sel.every((u) => u.holding));
}

export function sendOrder(cmd) {
  S.ctx.socket.emit('wfCommand', cmd, (res) => {
    if (res && !res.ok) {
      feed(res.error, 'amb');
      sfx.error();
      haptics.warn();
    }
  });
  haptics.tap();
}

export function onSysButton(kind) {
  const sel = selectedUnits();
  if (!sel.length) {
    feed('Tap your units first', 'amb');
    return;
  }
  if (kind === 'move') S.mode = 'move';
  else if (kind === 'haul') {
    if (!sel.some((u) => WORKER_TYPES.has(u.type))) {
      feed('Only Workers can haul', 'amb');
      return;
    }
    S.mode = S.mode === 'haul' ? 'move' : 'haul';
  } else if (kind === 'hold') {
    S.mode = 'move';
    sendOrder({ kind: 'hold', unitIds: sel.map((u) => u.id) });
  }
  sfx.click();
  renderSys();
  renderInfo();
}
