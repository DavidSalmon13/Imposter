/**
 * Warfront client module (docs/specs/warfront-specs.md). A dumb renderer of the server's
 * wfState/wfLive payloads; it never simulates anything. `Warfront` = { init, applyState, applyJoin,
 * stop }, routed by phase to teamSelect.js / battle.js / gameOver.js. Wires DOM events in init.
 * Code map: docs/implementation/warfront-code-map.md. Nothing may import this file but main.js.
 */

import { S } from './store.js';
import { sfx } from '../../fx.js';
import { openMenu, closeMenu } from './menu.js';
import { MATCH_LENGTHS, MAP_SIZES, MODES, HOTKEYS, BUILD_HOTKEYS, syncUnitStats } from './constants.js';
import {
  joinBtn,
  captainBtn,
  lengthSeg,
  modeSeg,
  sizeSeg,
  randomizeBtn,
  startBtn,
  errorEl,
  backBtn,
  vp,
  world,
  minimap,
  cmdBtn,
  tabBtn,
  feedEl,
  menuBtn,
  alertEl,
  goWorld,
  goConfetti,
  goAgain,
  goBack,
  goError,
} from './dom.js';
import { flashError, emit } from './util.js';
import { buildVista, buildRaceCards, buildSeg, hostOption, setMode, applyTeamSelect } from './teamSelect.js';
import { syncView, lookAt, enableMousePan } from './camera.js';
import { onAlert } from './fx.js';
import { renderBattle, applyLive } from './battle.js';
import { setTab, armBuild } from './console/build.js';
import { armWeapon } from './console/weapons.js';
import { produceUnit } from './console/cards.js';
import { onSysButton, renderInfo } from './console/selection.js';
import { enableLongPress } from './console/buildingInfo.js';
import { onTileTap } from './input.js';
import { selectAll } from './console/bulk.js';
import { renderGameOver } from './gameOver.js';

function applyState(data) {
  if (!data || data.game !== 'warfront') return;
  S.state = data;
  syncUnitStats(data.unitStats);
  if (data.phase !== 'playing') {
    closeMenu();
    clearInterval(S.clockTimer);
    S.clockTimer = null;
    S.live = null;
  }
  if (data.phase === 'teamSelect') {
    applyTeamSelect(data);
    S.ctx.showScreen('warfrontTeam');
  } else if (data.phase === 'generating') {
    S.ctx.showGenerating('warfront');
  } else if (data.phase === 'playing') {
    S.goBuiltFor = null;
    renderBattle(data);
  } else if (data.phase === 'gameover' && data.map) {
    renderGameOver(data);
  }
}

export const Warfront = {
  init(nextCtx) {
    S.ctx = nextCtx;
    const { socket } = S.ctx;

    buildVista();
    buildRaceCards();
    buildSeg(lengthSeg, MATCH_LENGTHS, S.lengthButtons, (id) => hostOption('matchLength', id));
    buildSeg(sizeSeg, MAP_SIZES, S.sizeButtons, (id) => hostOption('mapSize', id));
    buildSeg(modeSeg, MODES, S.modeButtons, (id) => setMode(id));

    ['red', 'blue'].forEach((team) => {
      joinBtn[team].addEventListener('click', () => {
        if (joinBtn[team].classList.contains('wf-on')) return;
        emit('joinWfTeam', team);
      });
    });
    captainBtn.addEventListener('click', () => emit('claimWfCaptain'));
    randomizeBtn.addEventListener('click', () => {
      if (!S.ctx.getIsHost()) {
        flashError('Only the host can randomize teams');
        return;
      }
      emit('randomizeWfTeams');
    });
    startBtn.addEventListener('click', () => emit('startWarfront'));
    backBtn.addEventListener('click', () => socket.emit('backToLobby', () => {}));

    enableMousePan();
    vp.addEventListener('scroll', syncView, { passive: true });
    minimap.addEventListener('click', (e) => {
      if (!S.state || !S.state.map) return;
      const r = minimap.getBoundingClientRect();
      const tx = Math.floor(((e.clientX - r.left) / r.width) * S.state.map.width);
      const ty = Math.floor(((e.clientY - r.top) / r.height) * S.state.map.height);
      lookAt(S.state.map, Math.max(0, Math.min(S.state.map.height - 1, ty)) * S.state.map.width + Math.max(0, Math.min(S.state.map.width - 1, tx)));
    });
    menuBtn.addEventListener('click', () => openMenu(socket));

    goAgain.addEventListener('click', () => {
      socket.emit('playAgainWarfront', (res) => {
        if (res && res.ok) return;
        goError.classList.remove('wf-notice');
        goError.textContent = (res && res.error) || 'Could not start the next battle';
      });
    });
    goBack.addEventListener('click', () => socket.emit('backToLobby', () => {}));

    socket.on('wfState', applyState);
    socket.on('wfLive', applyLive);
    socket.on('wfAlert', onAlert);
    alertEl.addEventListener('click', () => {
      if (S.state && S.state.map && S.alertTile != null) lookAt(S.state.map, S.alertTile);
      alertEl.classList.add('hidden');
    });
    ['move', 'haul', 'hold'].forEach((kind) => cmdBtn[kind].addEventListener('click', () => onSysButton(kind)));
    cmdBtn.all.addEventListener('click', selectAll);
    ['produce', 'build', 'weapons'].forEach((t) => tabBtn[t].addEventListener('click', () => {
      sfx.click();
      setTab(t);
    }));
    document.addEventListener('keydown', (e) => {
      if (!S.state || S.state.phase !== 'playing' || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (e.target && e.target.closest && e.target.closest('input, textarea, select')) return;
      const key = e.key.toUpperCase();
      if (e.key === 'Escape' && S.buildMode) {
        armBuild(S.buildMode);
        return;
      }
      if (e.key === 'Escape' && S.fireMode) {
        armWeapon(S.fireMode);
        return;
      }
      if (S.tab === 'build') {
        const f = Object.keys(BUILD_HOTKEYS).find((k) => BUILD_HOTKEYS[k] === key);
        if (f && (S.state.buildCatalog || []).length) {
          e.preventDefault();
          armBuild(f);
        }
        return;
      }
      const hit = (S.state.catalog || []).find((c) => HOTKEYS[c.unitType] === key);
      if (hit) {
        e.preventDefault();
        produceUnit(hit.unitType);
      }
    });
    enableLongPress(() => {
      if (S.live && S.state) renderInfo();
    });
    world.addEventListener('click', (e) => {
      if (Date.now() < S.suppressClickUntil) return;
      const tile = e.target.closest('.tile');
      if (tile) onTileTap(Number(tile.dataset.tile));
    });
    socket.on('wfNotice', ({ text }) => {
      clearTimeout(S.errorTimer);
      errorEl.classList.add('wf-notice');
      errorEl.textContent = text || '';
      S.errorTimer = setTimeout(() => {
        errorEl.textContent = '';
      }, 4000);
    });
  },

  applyState,

  applyJoin(res) {
    applyState(res);
  },

  stop() {
    closeMenu();
    S.state = null;
    S.live = null;
    S.builtFor = null;
    S.selected.clear();
    S.inspect = null;
    if (S.rafId) cancelAnimationFrame(S.rafId);
    S.rafId = null;
    clearInterval(S.clockTimer);
    S.clockTimer = null;
    clearTimeout(S.errorTimer);
    errorEl.textContent = '';
    clearTimeout(S.alertTimer);
    alertEl.classList.add('hidden');
    if (S.fxLayer) S.fxLayer.innerHTML = '';
    S.mode = 'move';
    S.cardsFor = '';
    feedEl.innerHTML = '';
    S.goBuiltFor = null;
    if (goWorld) goWorld.innerHTML = '';
    if (goConfetti) goConfetti.innerHTML = '';
    if (goError) goError.textContent = '';
  },
};
