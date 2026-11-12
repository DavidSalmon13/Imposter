/**
 * Warfront client: a tap on a map tile. Select / deselect stacks, pick a facility, move or
 * haul the selection, place an armed build. Must NOT contain: rendering beyond re-render calls.
 * Spec: "Commands".
 */

import { S } from './store.js';
import { sfx, haptics } from '../../fx.js';
import { renderUnits } from './units.js';
import { FACILITY_TYPES, WORKER_TYPES } from './constants.js';
import { renderBuildHints } from './structures.js';
import { renderInfo, selectedUnits, renderSys, sendOrder } from './console/selection.js';
import { feed } from './util.js';
import { renderBuildCards } from './console/build.js';
import { renderCards } from './console/cards.js';

/** Tap on the battlefield: pick up your stack on that tile, or send the selection there. */
export function onTileTap(tileId) {
  if (!S.state || S.state.phase !== 'playing' || !S.live || !S.state.myTeam) return;
  if (S.buildMode) {
    const facility = S.buildMode;
    S.ctx.socket.emit('wfCommand', { kind: 'build', facility, tileId }, (res) => {
      if (res && !res.ok) {
        feed(res.error, 'amb');
        sfx.error();
        haptics.warn();
        return;
      }
      sfx.click();
      if (S.buildMode === facility) S.buildMode = null;
      renderBuildCards();
      renderBuildHints();
      if (S.live) renderInfo();
    });
    haptics.tap();
    return;
  }
  const vein = S.state.map.veins.some((v) => v.tileId === tileId);
  const workerIds = selectedUnits().filter((u) => WORKER_TYPES.has(u.type)).map((u) => u.id);
  if (S.mode === 'haul') {
    S.mode = 'move';
    if (!vein) feed('Tap a mineral vein to haul from it', 'amb');
    else if (workerIds.length) sendOrder({ kind: 'haul', workerIds, veinTileId: tileId });
    renderSys();
    renderInfo();
    return;
  }
  const mineHere = S.live.units.filter((u) => u.owner === S.state.you && u.tileId === tileId && !FACILITY_TYPES.has(u.type)).map((u) => u.id);
  const selHere = mineHere.filter((id) => S.selected.has(id));
  const myStruct = S.live.units.find((u) => u.owner === S.state.you && u.tileId === tileId && FACILITY_TYPES.has(u.type));
  // Units picked elsewhere and sent to your Tower climb onto it, even with a garrison already up there.
  const toTower = Boolean(myStruct && myStruct.type === 'tower' && !myStruct.buildDoneAt && S.selected.size
    && [...S.selected].some((id) => !mineHere.includes(id)));
  if (!toTower && mineHere.length && (!S.selected.size || selHere.length < mineHere.length)) {
    // Select (or switch to) the stack on this tile.
    S.selStructure = null;
    S.selected.clear();
    mineHere.forEach((id) => S.selected.add(id));
    sfx.click();
    haptics.tap();
  } else if (mineHere.length && selHere.length === mineHere.length && S.selected.size === selHere.length) {
    S.selected.clear(); // tapping your selected stack again lets go of it
  } else if (!S.selected.size && myStruct) {
    // Pick your facility or tower (a picked Forward Barracks is where new units appear); again lets go.
    S.selStructure = S.selStructure === myStruct.id ? null : myStruct.id;
    sfx.click();
    haptics.tap();
  } else if (!S.selected.size && S.selStructure != null) {
    S.selStructure = null;
  } else if (S.selected.size && vein && workerIds.length === S.selected.size) {
    // Workers sent onto a vein start hauling from it.
    sendOrder({ kind: 'haul', workerIds, veinTileId: tileId });
  } else if (S.selected.size) {
    const unitIds = [...S.selected];
    S.ctx.socket.emit('wfCommand', { kind: 'move', unitIds, toTileId: tileId }, (res) => {
      if (res && !res.ok) {
        sfx.error();
        haptics.warn();
      }
    });
    haptics.tap();
  } else {
    return;
  }
  renderUnits();
  renderSys();
  renderInfo();
  renderCards();
  renderBuildCards();
}
