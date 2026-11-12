/**
 * Warfront client: the console's Select all (every fighter you have; tap again to add your
 * Workers). Must NOT contain: producing a unit (console/cards.js), map taps (input.js).
 * Mockup: 2-battlefield.html command row. Spec: "Game feel" (bulk actions). Plan Step 23.
 */

import { S } from '../store.js';
import { sfx, haptics } from '../../../fx.js';
import { feed } from '../util.js';
import { FACILITY_TYPES, WORKER_TYPES } from '../constants.js';
import { renderUnits } from '../units.js';
import { renderInfo, renderSys } from './selection.js';
import { renderCards } from './cards.js';
import { renderBuildCards } from './build.js';

/** Your units Select all can pick: not buildings, not a Tower's garrison (it stays on the roof). */
function selectable() {
  if (!S.live || !S.state) return [];
  return S.live.units.filter((u) => u.owner === S.state.you && !FACILITY_TYPES.has(u.type) && !u.garrison);
}

/** Select all: every fighter; if they're already all selected (or you have none), Workers too. */
export function selectAll() {
  if (!S.state || S.state.phase !== 'playing' || !S.state.myTeam) return;
  const mine = selectable();
  if (!mine.length) {
    feed('You have no units yet', 'amb');
    return;
  }
  const fighters = mine.filter((u) => !WORKER_TYPES.has(u.type));
  const allFighters = fighters.length > 0 && S.selected.size === fighters.length && fighters.every((u) => S.selected.has(u.id));
  const pick = !fighters.length || allFighters ? mine : fighters;
  S.selected.clear();
  pick.forEach((u) => S.selected.add(u.id));
  S.selStructure = null;
  S.mode = 'move';
  const workers = pick.length - pick.filter((u) => !WORKER_TYPES.has(u.type)).length;
  feed(pick === fighters
    ? `All ${pick.length} fighters selected · tap ⊕ again to add Workers`
    : `All ${pick.length} units selected${workers ? ` (${workers} Workers)` : ''}`);
  sfx.click();
  haptics.tap();
  renderUnits();
  renderSys();
  renderInfo();
  renderCards();
  renderBuildCards();
}
