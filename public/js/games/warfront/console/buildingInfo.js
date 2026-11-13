/**
 * Warfront client: a building in the console's info well (plan Step 24). Your picked facility or
 * Tower, or any building in sight long-pressed on the map (`S.inspect`, shown for 4 s without
 * touching the selection): portrait in its owner's colour, YOURS / ALLY / ENEMY / BUILDING tag,
 * a filled HP bar (a striped build bar while it's a construction site), its description on its
 * own line, and what to do about it. Also the long-press gesture on the map's tile layer.
 * Must NOT contain: stacks / lore in the info well (selection.js), plain map taps (input.js).
 * Spec: "Game feel" → Building info. Mockup: 2c-command-cards.html "Building info".
 */

import { S } from '../store.js';
import { haptics } from '../../../fx.js';
import { FACILITY_SPRITES, CASTLE_SPRITE } from '../sprites.js';
import { el, feed } from '../util.js';
import { RACE_NAMES, FACILITY_NAMES, FACILITY_ORDERS, FACILITY_TYPES, UNIT_MAX_HP, UNIT_INFO, UNIT_STATS } from '../constants.js';
import { infoPortrait, infoTitle, infoTag, infoSub, infoHp, infoDesc, infoOrder, world } from '../dom.js';
import { serverNow } from '../clock.js';
import { hpClass } from '../stackSig.js';

export const INSPECT_MS = 4000; // how long a long-pressed building stays in the info well
const PRESS_MS = 400; // the same hold as a Produce card's lore
const PRESS_SLOP_PX = 8; // a finger that moves further is panning the map, not pressing
const HINT_KEY = 'wf-inspect-hint';

// What to do about someone else's building (an enemy's in sight; a teammate's has no order).
const ENEMY_ORDERS = {
  refinery: '▸ DESTROY IT TO STOP THEIR BONUS',
  barracks: '▸ THEIR UNITS STEP OUT HERE · DESTROY IT',
  workshop: '▸ IT CRAFTS THEIR WEAPONS · DESTROY IT',
  tower: '▸ ITS ROOF IS SAFE TILL IT FALLS · BRING IT DOWN',
};
// The portrait well in the building owner's colour (mockup); a stack's well keeps the markup's violet.
const PORTRAIT_TEAM = {
  red: { backgroundColor: '#1a0c0e', boxShadow: 'inset 0 0 0 1px #8a2a2e, inset 0 0 16px rgba(255,90,95,.35)' },
  blue: { backgroundColor: '#0b1222', boxShadow: 'inset 0 0 0 1px #2a4f9a, inset 0 0 16px rgba(79,147,255,.35)' },
};
const TEAM_NAMES = { red: 'Red', blue: 'Blue' };
const theirs = (text) => text.replace(/\bYour\b/g, 'Their').replace(/\byour\b/g, 'their');

const BASE_INFO = "Your team's home. New units step out here unless a Forward Barracks is picked. It strikes enemies beside it. Lose it and you lose the match.";
const BASE_ORDERS = { mine: '▸ RECRUIT FROM THE CARDS BELOW · KEEP DEFENDERS ON IT', foe: '▸ DESTROY IT TO WIN THE MATCH' };

/**
 * A team's base drawn as a building for the info well (it isn't a unit: it lives in `S.live.bases`
 * and the map). Its id is `base:<team>`. Null if that base isn't known.
 */
export function baseBuilding(team) {
  const b = S.live && S.live.bases && S.live.bases[team];
  if (!b) return null;
  return { id: `base:${team}`, type: 'base', isBase: true, team, tileId: b.tileId, hp: b.hp, maxHp: b.maxHp, shieldUntil: b.shieldUntil || 0 };
}

/** The long-pressed building, if it's still fresh and still in view; clears a stale one. */
export function inspectedBuilding() {
  if (!S.inspect || !S.live) return null;
  const fresh = S.inspect.until > Date.now();
  const u = !fresh ? null
    : S.inspect.base ? baseBuilding(S.inspect.base)
      : S.live.units.find((x) => x.id === S.inspect.id);
  if (!u) S.inspect = null;
  return u || null;
}

/** How long a facility takes to build (the Build catalog), for a site's progress. */
function buildMsFor(type) {
  const c = ((S.state && S.state.buildCatalog) || []).find((f) => f.facility === type);
  return c ? c.buildMs : 0;
}

/**
 * Draw `b` in the info well. `changed(key, value)` is renderInfo's "did this part change" check, so
 * the portrait and the bar's nodes are built once per building and only repainted after that.
 */
export function renderBuildingInfo(b, changed) {
  // A base belongs to the whole team: it's "yours" for everyone on it.
  const mine = b.isBase ? b.team === S.state.myTeam : b.owner === S.state.you;
  const ally = !mine && !b.isBase && b.team === S.state.myTeam;
  const wip = Boolean(b.buildDoneAt);
  const max = b.maxHp || UNIT_MAX_HP[b.type] || b.hp || 1;
  if (changed('portrait', `b:${b.id}:${wip ? 1 : 0}`)) {
    const svg = b.isBase ? CASTLE_SPRITE : FACILITY_SPRITES[b.type].svg;
    infoPortrait.innerHTML = svg
      .replace('<svg ', `<svg style="width: 44px; height: ${b.isBase ? 44 : 58}px; overflow: visible; opacity: ${wip ? 0.45 : 1}" `);
    Object.assign(infoPortrait.style, PORTRAIT_TEAM[b.team] || PORTRAIT_TEAM.red);
  }
  infoPortrait.className = `scan tm-${b.team}`;
  infoTitle.textContent = b.isBase ? `${TEAM_NAMES[b.team] || ''} Base` : FACILITY_NAMES[b.type] || b.type;
  const [tag, tagCls] = mine && wip ? ['BUILDING', 'wip'] : mine ? ['YOURS', 'mine'] : ally ? ['ALLY', 'mine'] : ['ENEMY', `foe foe-${b.team}`];
  infoTag.textContent = tag;
  infoTag.className = `btag ${tagCls}`;

  let sub;
  const shieldS = b.isBase ? Math.ceil((b.shieldUntil - serverNow()) / 1000) : 0;
  if (b.isBase) sub = `${mine ? RACE_NAMES[S.state.myRace] || '' : `${TEAM_NAMES[b.team] || ''} · enemy`}${shieldS > 0 ? ` · 🛡 shielded ${shieldS}s` : ''}`;
  else if (wip) sub = `Under construction · ${Math.max(0, Math.ceil((b.buildDoneAt - serverNow()) / 1000))}s`;
  else if (!mine) sub = ally ? `${b.owner} · ${TEAM_NAMES[b.team]}` : `${TEAM_NAMES[b.team] || ''} · in sight`;
  else {
    const roof = b.type === 'tower'
      ? ` · roof ${S.live.units.filter((u) => u.garrison === b.id).length}/${(UNIT_STATS.tower && UNIT_STATS.tower.garrison) || 3}`
      : '';
    const arsenal = b.type === 'workshop' && S.live.me ? ` · arsenal ${(S.live.me.arsenal || []).length}` : '';
    sub = `${RACE_NAMES[S.state.myRace] || ''}${roof}${arsenal}`;
  }
  if (infoSub.textContent !== sub) infoSub.textContent = sub;
  S.infoSig.sub = null; // selection.js's setSub must write its line again after this

  // HP: a filled bar like the stack bar; a construction site's is striped and fills as it's built.
  if (changed('hp', `b:${b.id}:${wip ? 1 : 0}`)) {
    infoHp.innerHTML = '';
    const bar = infoHp.appendChild(el('span', `bhp${wip ? ' build' : ''}`));
    bar.appendChild(el('b'));
    infoHp.appendChild(el('span', 'bhp-txt'));
  }
  const fill = infoHp.querySelector('.bhp b');
  const txt = infoHp.querySelector('.bhp-txt');
  const hpText = `HP ${Math.ceil(b.hp)}/${max}`;
  let f;
  if (wip) {
    const total = buildMsFor(b.type);
    f = total ? Math.max(0, Math.min(1, 1 - (b.buildDoneAt - serverNow()) / total)) : 0;
    txt.textContent = `${Math.round(f * 100)}% BUILT · ${hpText}`;
  } else {
    f = Math.max(0, Math.min(1, b.hp / max));
    fill.className = hpClass(f);
    txt.textContent = hpText;
  }
  fill.style.transform = `scaleX(${f.toFixed(3)})`;

  const desc = b.isBase ? BASE_INFO : UNIT_INFO[b.type] || '';
  infoDesc.textContent = mine ? desc : theirs(desc);
  const order = b.isBase ? BASE_ORDERS[mine ? 'mine' : 'foe']
    : wip && mine ? '▸ BEING BUILT · IT WORKS ONCE IT STANDS'
    : mine ? FACILITY_ORDERS[b.type] || ''
      : ally ? '' : ENEMY_ORDERS[b.type] || '';
  infoOrder.textContent = order;
  infoOrder.classList.toggle('amb', !mine && !ally);
}

/** Back to the stack / lore layout: no tag, no description line, the markup's violet portrait well. */
export function clearBuildingInfo() {
  if (!infoTag.textContent && !infoDesc.textContent) return;
  infoTag.textContent = '';
  infoTag.className = 'btag hidden';
  infoDesc.textContent = '';
  infoOrder.classList.remove('amb');
  infoPortrait.style.backgroundColor = '#120a20';
  infoPortrait.style.boxShadow = 'inset 0 0 0 1px #6b3fbf, inset 0 0 16px rgba(181,124,255,.45)';
}

/** After your first build: tell you once (per browser) that a long-press shows a building's info. */
export function hintInspectOnce() {
  try {
    if (localStorage.getItem(HINT_KEY)) return;
    localStorage.setItem(HINT_KEY, '1');
  } catch {
    if (S.inspectHinted) return;
  }
  S.inspectHinted = true;
  feed('Long-press a building for its info');
}

/**
 * Long-press (~400 ms) on any building in sight: its info shows for 4 s, the selection stays, and
 * the release isn't also a tap (`S.suppressClickUntil`). A moving finger (a pan) cancels it.
 * `onShow` re-renders the info well (selection.js's renderInfo, passed in to avoid an import cycle).
 */
export function enableLongPress(onShow) {
  let timer = 0;
  let start = null;
  const cancel = () => {
    clearTimeout(timer);
    start = null;
  };
  world.addEventListener('pointerdown', (e) => {
    cancel();
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!S.state || S.state.phase !== 'playing' || !S.live || !S.state.myTeam) return;
    const tile = e.target.closest && e.target.closest('.tile');
    if (!tile) return;
    const tileId = Number(tile.dataset.tile);
    start = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => {
      start = null;
      const b = S.live && S.live.units.find((u) => u.tileId === tileId && FACILITY_TYPES.has(u.type));
      const base = !b && S.state && S.state.map.bases.find((x) => x.tileId === tileId);
      if (!b && !base) return;
      S.lore = null;
      S.inspect = b ? { id: b.id, until: Date.now() + INSPECT_MS } : { id: `base:${base.team}`, base: base.team, until: Date.now() + INSPECT_MS };
      S.suppressClickUntil = Date.now() + 700;
      haptics.tap();
      onShow();
    }, PRESS_MS);
  });
  world.addEventListener('pointermove', (e) => {
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > PRESS_SLOP_PX) cancel();
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => world.addEventListener(ev, cancel));
  world.addEventListener('contextmenu', (e) => {
    if (S.state && S.state.phase === 'playing') e.preventDefault();
  });
}
