/**
 * Warfront client: the game-over screen (docs/design/warfront/4-game-over.html). Victory
 * scene on the final map, base HP wells, stats table, MVP, Play Again, scoreboard.
 * Must NOT contain: live battle code. Spec: "Ending the match".
 */

import { S } from './store.js';
import { UNIT_SPRITES, RACE_PORTRAITS, RUINED_CASTLE_SPRITE, BANNER_SPRITE } from './sprites.js';
import { renderScoreboard } from '../../shared/scoreboard.js';
import {
  $,
  world,
  goRoot,
  goVp,
  goCam,
  goWorld,
  goConfetti,
  goReason,
  goTitle,
  goSub,
  goRows,
  goMvp,
  goAgain,
  goError,
  goScoreboard,
} from './dom.js';
import { el } from './util.js';
import { TILE, BASE_PAD_Z, RACE_NAMES } from './constants.js';
import { tileCentre, ent, billboard } from './world/geometry.js';
import { buildWorld } from './world/build.js';
import { renderUnits } from './units.js';
import { renderFog } from './fog.js';
import { renderPickups, renderLighthouses, renderCastles } from './map-objects.js';

const TEAM_NAME = { red: 'Red', blue: 'Blue' };
const fmtMatchTime = (ms) => {
  const secs = Math.round(ms / 1000);
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
};
// The mockup's confetti, in the winners' colours.
const CONFETTI = {
  red: ['#ff5a5f', '#ffcc33', '#ff5a5f', '#fff', '#ffcc33', '#ff5a5f', '#ffcc33', '#ff5a5f', '#fff', '#ff5a5f'],
  blue: ['#4f93ff', '#ffcc33', '#4f93ff', '#fff', '#ffcc33', '#4f93ff', '#ffcc33', '#4f93ff', '#fff', '#4f93ff'],
};
const CONFETTI_AT = [[8, 0], [18, -1.1], [29, -2.3], [41, -0.6], [52, -1.7], [63, -2.8], [74, -0.3], [85, -1.4], [93, -2.1], [35, -2.6]];
// Banners planted on the ruins' pad and scorch marks on the ground round it: the
// mockup's scene, scaled from its plateau to the castle's 98px stone pad.
const BANNERS = [[-40, -46], [44, 6], [-43, 5]];
const SCORCHES = [[-120, 20], [-200, -30], [-20, 60]];

/** The final map with the fog lifted, framed on the fallen (or weaker) base. */
function buildGameOverScene(data) {
  // The battlefield's world is done with; its registries now point at this scene.
  world.innerHTML = '';
  S.builtFor = null;
  S.selected.clear();
  buildWorld(data, { cam: goCam, world: goWorld, minimap: false });
  S.live = { units: data.units, bases: data.bases, visible: data.visible, pickups: data.pickups, lighthouses: data.lighthouses, events: [] };
  renderFog();
  renderPickups();
  renderLighthouses();
  renderUnits();
  renderCastles(data.bases);

  // The loser's castle lies in ruins and burns; the winners plant their banners round it.
  const { winner } = data;
  const loser = winner === 'red' ? 'blue' : winner === 'blue' ? 'red' : null;
  if (loser && data.bases[loser].hp <= 0 && S.castleBoards[loser]) {
    const bb = S.castleBoards[loser];
    const node = bb.parentNode;
    node.insertBefore(el('span', 'dec fireglow'), bb);
    bb.classList.add('wf-ruin');
    bb.style.width = '170px';
    bb.style.height = '150px';
    bb.style.transform = 'translateX(-50%) rotateX(-40deg) scale(.9)';
    bb.innerHTML = `${RUINED_CASTLE_SPRITE}<span class="flame" style="left: 64px; top: 30px"></span><span class="flame" style="left: 80px; top: 24px; animation-delay: -.15s; transform: scale(1.2)"></span><span class="flame" style="left: 22px; top: 62px; animation-delay: -.25s"></span><span class="flame" style="left: 140px; top: 66px; animation-delay: -.1s; transform: scale(.85)"></span><span class="flame" style="left: 112px; top: 74px; animation-delay: -.3s; transform: scale(.7)"></span><span class="smoke" style="left: 48%; bottom: 120px"><span></span><span></span><span></span></span><span class="smoke" style="left: 20%; bottom: 80px"><span></span><span></span><span></span></span><span class="smoke" style="left: 84%; bottom: 84px"><span></span><span></span><span></span></span>`;
    // Banners stand on the castle's stone pad (the mockup's plateau), scorch marks round it.
    const c = tileCentre(data.map, data.bases[loser].tileId);
    BANNERS.forEach(([dx, dy]) => {
      const b = ent(c.x + dx, c.y + 18 + dy, BASE_PAD_Z, `tm-${winner}`);
      const sh = el('span', 'dec tshadow');
      Object.assign(sh.style, { width: '30px', height: '14px' });
      b.appendChild(sh);
      b.appendChild(billboard(BANNER_SPRITE, 34, 64));
      S.unitLayer.appendChild(b);
    });
    const ground = goWorld.querySelector('.terrain');
    SCORCHES.forEach(([dx, dy]) => {
      const sc = el('span', 'scorch');
      Object.assign(sc.style, { left: `${c.x + dx}px`, top: `${c.y + dy}px` });
      ground.appendChild(sc);
    });
  }

  goConfetti.innerHTML = '';
  if (CONFETTI[winner]) {
    CONFETTI_AT.forEach(([left, delay], i) => {
      const bit = el('i');
      Object.assign(bit.style, { left: `${left}%`, background: CONFETTI[winner][i], animationDelay: `${delay}s` });
      goConfetti.appendChild(bit);
    });
  }

  // Frame the fallen base (the weaker one at the time cap, the map's centre on a draw).
  const focus = loser ? data.bases[loser].tileId
    : Math.floor(data.map.height / 2) * data.map.width + Math.floor(data.map.width / 2);
  requestAnimationFrame(() => {
    // Like the mockup: the fallen castle stands a little below the middle, off-centre
    // toward its own map edge so the winners' side of the field fills the rest. A
    // transform rather than scrolling, so a base in the top rows can still come down
    // out from under the title (the dark camera background shows above the map).
    const c = tileCentre(data.map, focus);
    const side = loser === 'blue' ? 0.68 : loser === 'red' ? 0.32 : 0.5;
    const vw = goVp.clientWidth;
    const vh = goVp.clientHeight;
    const x = Math.max(0, Math.min(goCam.offsetWidth - vw, c.x - vw * side));
    const y = Math.max(-vh * 0.4, Math.min(goCam.offsetHeight - vh, (c.y / (data.map.height * TILE)) * goCam.offsetHeight - vh * 0.62));
    goCam.style.transform = `translate(${-Math.round(x)}px, ${-Math.round(y)}px)`;
  });
}

function renderBaseWell(team, base, winner) {
  const well = $(`wf-go-${team}`);
  const hp = Math.max(0, Math.round(base.hp));
  const hpEl2 = $(`wf-go-${team}-hp`);
  hpEl2.textContent = `${hp}/${base.maxHp}`;
  hpEl2.className = hp > 0 ? 'grn' : '';
  hpEl2.style.color = hp > 0 ? '' : '#ff5a5f';
  $(`wf-go-${team}-bar`).style.width = `${Math.max(0, Math.min(100, Math.round((base.hp / base.maxHp) * 100)))}%`;
  // The winner's well glows in its team colour; the other keeps a dim team edge.
  const glow = { red: 'inset 0 0 0 1px #000, inset 0 0 0 2px #ff5a5f, inset 0 0 20px rgba(229,72,77,.3)', blue: 'inset 0 0 0 1px #000, inset 0 0 0 2px #4f93ff, inset 0 0 20px rgba(59,130,246,.3)' };
  const dim = { red: 'inset 0 0 0 1px #000, inset 0 0 0 2px #7a2a2e', blue: 'inset 0 0 0 1px #000, inset 0 0 0 2px #23477e' };
  well.style.boxShadow = winner === team ? glow[team] : dim[team];
}

function renderStatRows(data) {
  goRows.innerHTML = '';
  const order = (t) => (t === data.winner ? 0 : t === 'red' ? 1 : 2);
  const rows = [...data.stats].sort((a, b) => order(a.team) - order(b.team) || b.baseDmg - a.baseDmg || b.kills - a.kills || a.name.localeCompare(b.name));
  rows.forEach((s) => {
    const won = s.team === data.winner;
    const row = el('div', 'row well');
    row.style.boxShadow = `inset 0 0 0 1px #000, inset 0 0 0 2px ${s.team === 'red' ? '#7a2a2e' : '#23477e'}`;
    row.appendChild(el('span', `por tm-${s.team}`, UNIT_SPRITES[RACE_PORTRAITS[s.race]] || ''));
    const who = el('span');
    who.style.minWidth = '0';
    if (s.name === data.mvp) who.appendChild(el('span', 'amb')).textContent = '★ ';
    const nm = el('span');
    Object.assign(nm.style, { fontWeight: '700', color: s.team === 'red' ? '#ff7a7e' : '#7fb0ff' });
    nm.textContent = s.name === data.you ? 'YOU' : s.name.toUpperCase();
    who.appendChild(nm);
    const race = el('span');
    Object.assign(race.style, { display: 'block', fontSize: '9.5px', color: '#8fa3b5', letterSpacing: '.12em' });
    race.textContent = `${(RACE_NAMES[s.race] || '').toUpperCase()}${s.connected ? '' : ' · OFFLINE'}`;
    who.appendChild(race);
    row.appendChild(who);
    row.appendChild(el('span', won ? 'grn' : '')).textContent = s.kills;
    row.appendChild(el('span')).textContent = s.lost;
    row.appendChild(el('span', won ? 'amb' : '')).textContent = Math.round(s.baseDmg);
    goRows.appendChild(row);
  });
  goMvp.classList.toggle('hidden', !data.mvp);
}

export function renderGameOver(data) {
  const { winner } = data;
  goRoot.classList.toggle('wf-go-red-won', winner === 'red');
  goRoot.classList.toggle('wf-go-blue-won', winner === 'blue');
  goRoot.classList.toggle('wf-go-draw', winner === 'draw');
  if (S.goBuiltFor !== data.clock.startedAt) {
    buildGameOverScene(data);
    S.goBuiltFor = data.clock.startedAt;
  }

  // "Blue base destroyed · round 11" -> how it ended, with the match time.
  const time = fmtMatchTime(data.matchMs);
  const loser = winner === 'red' ? 'blue' : 'red';
  if (winner === 'draw') {
    goReason.textContent = data.endReason === 'base' ? `Both bases destroyed · ${time}` : `Time up · bases level · ${time}`;
  } else {
    goReason.textContent = data.endReason === 'base' ? `${TEAM_NAME[loser]} base destroyed · ${time}` : `Time up · ${TEAM_NAME[winner]} base stood stronger · ${time}`;
  }
  goReason.style.color = winner === 'blue' ? '#9ac0ff' : winner === 'red' ? '#ff9a9d' : '#8fa3b5';
  goTitle.textContent = winner === 'draw' ? 'DRAW' : `${winner.toUpperCase()} WINS!`;
  // The mockup's 50px fits "RED WINS!" on a 390px phone; "BLUE WINS!" needs a little less.
  goTitle.style.fontSize = goTitle.textContent.length > 9 ? '44px' : '50px';
  // The mockup shows a winner's phone (◆ VICTORY ◆); the other side reads its defeat.
  const lost = data.myTeam && winner !== 'draw' && data.myTeam !== winner;
  goSub.textContent = winner === 'draw' ? '◆ STALEMATE ◆' : lost ? '◆ DEFEAT ◆' : '◆ VICTORY ◆';
  goSub.className = lost ? '' : 'amb';
  goSub.style.color = lost ? '#ff5a5f' : '';
  goSub.style.textShadow = lost ? '0 0 6px rgba(255,90,95,.5)' : '';

  renderBaseWell('red', data.bases.red, winner);
  renderBaseWell('blue', data.bases.blue, winner);
  renderStatRows(data);

  goAgain.disabled = !data.canCommand;
  goAgain.classList.toggle('wf-go-red', winner !== 'blue');
  goAgain.classList.toggle('wf-go-blue', winner === 'blue');
  if (!goError.textContent || goError.classList.contains('wf-notice')) {
    goError.classList.toggle('wf-notice', !data.canCommand);
    goError.textContent = data.canCommand ? '' : 'The host or a captain starts the next battle';
  }
  renderScoreboard(goScoreboard, data.scoreboard || []);
  S.ctx.showScreen('warfrontOver');
}
