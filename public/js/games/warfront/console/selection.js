/**
 * Warfront client: what is selected and what you can do with it. The info well (stack,
 * structure or battlefield lore), the Move/Haul/Hold buttons, sending orders.
 * Must NOT contain: map tap handling (input.js). Mockup: 2-battlefield.html console.
 */

import { S } from '../store.js';
import { sfx, haptics } from '../../../fx.js';
import { UNIT_SPRITES, CASTLE_SPRITE } from '../sprites.js';
import { el, feed } from '../util.js';
import {
  RACE_NAMES,
  FACILITY_NAMES,
  FACILITY_TYPES,
  UNIT_MAX_HP,
  UNIT_NAMES,
  WORKER_TYPES,
  UNIT_INFO,
  UNIT_STATS,
  statLine,
} from '../constants.js';
import { infoPortrait, infoTitle, infoSub, infoHp, infoOrder, cmdBtn } from '../dom.js';
import { hpFraction, hpClass } from '../stackSig.js';
import { inspectedBuilding, renderBuildingInfo, clearBuildingInfo } from './buildingInfo.js';

const plural = (name, n) => (n === 1 ? name : name.endsWith('man') ? `${name.slice(0, -3)}men` : `${name}s`);
const areaName = (map, id) => `${map.tiles[id]} ${Math.floor(id / map.width) + 1}-${(id % map.width) + 1}`;

/**
 * The console's info well: a long-pressed building (Step 24, 4 s), a long-pressed Produce card's
 * lore, your picked building, the selected stack (mockup), or the battlefield's name and lore.
 */
export function renderInfo() {
  const { map } = S.state;
  const team = S.state.myTeam || 'red';
  const sel = S.live.units.filter((u) => u.owner === S.state.you && S.selected.has(u.id));
  infoPortrait.className = `scan tm-${team}`;
  // Only rebuild the portrait and HP pips when they change: re-parsing the SVG every
  // snapshot (5×/s) cost a layout each time and restarted the portrait's animations.
  const hpSig = sel.map((u) => `${u.type}:${Math.ceil(u.hp)}`).join(',');
  const lead0 = sel.length ? sel.map((u) => u.type).sort().join(',') : 'castle';
  const changed = (key, value) => {
    if (S.infoSig[key] === value) return false;
    S.infoSig[key] = value;
    return true;
  };
  const inspected = inspectedBuilding();
  const struct = inspected || (!sel.length && S.selStructure != null ? S.live.units.find((u) => u.id === S.selStructure) : null);
  // A long-pressed Produce card: that unit's description and stats, for a few seconds.
  const lore = !inspected && S.lore && S.lore.until > Date.now() ? S.lore.type : null;
  if (!lore) S.lore = null;
  if (struct) {
    renderBuildingInfo(struct, changed);
    // Arming a build while your own building is picked: the well says where to place it.
    if (S.buildMode && !inspected) {
      infoOrder.textContent = buildOrderText();
      infoOrder.classList.remove('amb');
    }
    renderSys();
    return;
  }
  clearBuildingInfo();
  if (lore) {
    if (changed('portrait', `l:${lore}`)) infoPortrait.innerHTML = (UNIT_SPRITES[lore] || '').replace('<svg ', '<svg style="width: 40px; height: 50px; overflow: visible" ');
    if (changed('hp', `l:${lore}`)) infoHp.innerHTML = '';
    infoTitle.textContent = UNIT_NAMES[lore] || lore;
    setSub(lore, UNIT_INFO[lore] || '', statLine(lore));
    infoOrder.textContent = '▸ TAP THE CARD TO PRODUCE';
    renderSys();
    return;
  }
  const portraitChanged = changed('portrait', lead0);
  const hpChanged = changed('hp', hpSig);
  if (hpChanged) infoHp.innerHTML = '';
  if (!sel.length) {
    if (portraitChanged) infoPortrait.innerHTML = CASTLE_SPRITE.replace('<svg ', '<svg style="width: 44px; height: 44px; overflow: visible" ');
    infoTitle.textContent = map.theme;
    setSub('map', map.lore || '');
    infoOrder.textContent = S.buildMode ? buildOrderText() : S.state.myTeam ? '▸ TAP YOUR UNITS TO COMMAND THEM' : '';
    renderSys();
    return;
  }
  const counts = new Map();
  sel.forEach((u) => counts.set(u.type, (counts.get(u.type) || 0) + 1));
  const [lead] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (portraitChanged) infoPortrait.innerHTML = (UNIT_SPRITES[lead] || '').replace('<svg ', '<svg style="width: 40px; height: 50px; overflow: visible" ');
  infoTitle.textContent = counts.size === 1 ? `${plural(UNIT_NAMES[lead], sel.length)} ×${sel.length}` : `Squad ×${sel.length}`;
  setSub(`u:${lead}`, UNIT_INFO[lead] || `${RACE_NAMES[S.state.myRace]} · ${map.tiles[sel[0].tileId]}`, statLine(lead));
  if (hpChanged) renderSelHp(sel, counts.size === 1 ? lead : null);
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
  else if (sel.every((u) => u.garrison)) {
    order = sel.some((u) => UNIT_STATS[u.type] && UNIT_STATS[u.type].range >= 2)
      ? '▸ ON THE TOWER ROOF · SHOOTING · SAFE TILL IT FALLS'
      : '▸ ON THE TOWER ROOF · SAFE TILL IT FALLS';
  }
  else if (sel.every((u) => u.holding)) order = '▸ HOLDING · TAP A TILE TO MOVE';
  else order = '▸ TAP A TILE TO MOVE';
  infoOrder.textContent = order;
}

const SEL_BARS = 10; // HP bars shown for a selection; the rest are counted (+N)

/**
 * One HP bar per selected soldier, lowest first, then their HP as numbers (plan Step 22,
 * 2-battlefield.html info well). `oneType`: the type when they're all the same, for "of N each".
 */
function renderSelHp(sel, oneType) {
  const rows = sel.map((u) => ({ u, f: hpFraction(u, UNIT_MAX_HP) })).sort((a, b) => a.f - b.f);
  rows.slice(0, SEL_BARS).forEach(({ f }) => {
    const bar = el('span', 'wf-uhp');
    const fill = bar.appendChild(el('b', hpClass(f)));
    fill.style.transform = `scaleX(${f.toFixed(3)})`;
    infoHp.appendChild(bar);
  });
  if (rows.length > SEL_BARS) infoHp.appendChild(el('span', 'wf-uhp-more')).textContent = `+${rows.length - SEL_BARS}`;
  const nums = rows.slice(0, 6).map(({ u }) => Math.ceil(u.hp)).join(' · ');
  const each = oneType && UNIT_MAX_HP[oneType] ? ` of ${UNIT_MAX_HP[oneType]} each` : '';
  infoHp.appendChild(el('span', 'wf-uhp-txt')).textContent = `HP ${nums}${rows.length > 6 ? ' …' : ''}${each}`;
}

/** The info well's sub line: a description, then (optionally) a stat line under it. */
function setSub(key, text, stats = '') {
  if (S.infoSig.sub === `${key}|${text}|${stats}`) return;
  S.infoSig.sub = `${key}|${text}|${stats}`;
  infoSub.textContent = text;
  if (stats) {
    const line = el('span', 'wf-stl');
    line.textContent = stats;
    infoSub.appendChild(line);
  }
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
  const mine = S.live.units.filter((u) => u.owner === S.state.you && !FACILITY_TYPES.has(u.type) && !u.garrison);
  const fighters = mine.filter((u) => !WORKER_TYPES.has(u.type));
  cmdBtn.all.classList.toggle('dim', !mine.length);
  cmdBtn.all.classList.toggle('on', fighters.length > 0 && fighters.every((u) => S.selected.has(u.id)));
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
