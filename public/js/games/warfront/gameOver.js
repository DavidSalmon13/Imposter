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
  goBases,
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
import { SIDE, sideOf, ordinal } from './sides.js';

const TEAM_NAME = Object.fromEntries(Object.entries(SIDE).map(([t, x]) => [t, x.name]));
const fmtMatchTime = (ms) => {
  const secs = Math.round(ms / 1000);
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
};
// The mockup's confetti, in the winners' colours (its pattern: side, gold, side, white…).
const CONFETTI = Object.fromEntries(Object.entries(SIDE).map(([t, x]) => {
  const c = x.bright;
  return [t, [c, '#ffcc33', c, '#fff', '#ffcc33', c, '#ffcc33', c, '#fff', c]];
}));
/** The side that fell last: the other team in a team battle, 2nd place in free for all. */
function fallenSide(data) {
  const { winner } = data;
  if (data.mode === 'ffa') {
    const second = (data.placings || []).find((p) => p.place === 2);
    return winner !== 'draw' && second ? second.side : null;
  }
  return winner === 'red' ? 'blue' : winner === 'blue' ? 'red' : null;
}
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
  const loser = fallenSide(data);
  if (loser && data.bases[loser] && data.bases[loser].hp <= 0 && S.castleBoards[loser]) {
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
  const focus = loser && data.bases[loser] ? data.bases[loser].tileId
    : Math.floor(data.map.height / 2) * data.map.width + Math.floor(data.map.width / 2);
  requestAnimationFrame(() => {
    // Like the mockup: the fallen castle stands a little below the middle, off-centre
    // toward its own map edge so the winners' side of the field fills the rest. A
    // transform rather than scrolling, so a base in the top rows can still come down
    // out from under the title (the dark camera background shows above the map).
    const c = tileCentre(data.map, focus);
    const half = data.map.width * TILE / 2;
    const side = !loser ? 0.5 : c.x > half ? 0.68 : 0.32;
    const vw = goVp.clientWidth;
    const vh = goVp.clientHeight;
    const x = Math.max(0, Math.min(goCam.offsetWidth - vw, c.x - vw * side));
    const y = Math.max(-vh * 0.4, Math.min(goCam.offsetHeight - vh, (c.y / (data.map.height * TILE)) * goCam.offsetHeight - vh * 0.62));
    goCam.style.transform = `translate(${-Math.round(x)}px, ${-Math.round(y)}px)`;
  });
}

/** Every side's final base HP: red and blue as in the mockup; free for all by place with its tag. */
function renderBaseWells(data) {
  const ffa = data.mode === 'ffa';
  const placeOf = (t) => ((data.placings || []).find((p) => p.side === t) || {}).place || 9;
  const sides = Object.keys(data.bases).sort((a, b) => (ffa ? placeOf(a) - placeOf(b) : 0) || (a === 'red' ? -1 : 1));
  goBases.innerHTML = '';
  sides.forEach((team) => {
    const base = data.bases[team];
    const x = sideOf(team);
    const hp = Math.max(0, Math.round(base.hp));
    const won = data.winner === team || (data.winner === 'draw' && ffa && placeOf(team) === 1);
    const well = el('div', 'well');
    Object.assign(well.style, { padding: ffa ? '9px 10px' : '10px', display: 'flex', flexDirection: 'column', gap: '6px' });
    // The winner's well glows in its side's colour; the others keep a dim edge.
    well.style.boxShadow = won ? `inset 0 0 0 1px #000, inset 0 0 0 2px ${x.bright}, inset 0 0 20px ${x.glow}` : `inset 0 0 0 1px #000, inset 0 0 0 2px ${x.ring}`;
    const hd = el('div');
    hd.style.cssText = `display: flex; justify-content: space-between; font-size: 10px; font-weight: 700; letter-spacing: ${ffa ? '.14em' : '.16em'}`;
    const left = el('span');
    if (ffa && placeOf(team) < 9) left.appendChild(el('span', `wf-place p${placeOf(team)}`)).textContent = ordinal(placeOf(team));
    const nm = left.appendChild(el('span'));
    nm.style.color = x.label;
    nm.textContent = ffa ? x.name.toUpperCase() : `${x.name.toUpperCase()} BASE`;
    hd.appendChild(left);
    const hpText = hd.appendChild(el('span', hp > 0 ? 'grn' : ''));
    hpText.textContent = `${hp}/${base.maxHp}`;
    if (hp <= 0) hpText.style.color = '#ff5a5f';
    well.appendChild(hd);
    const track = el('div');
    track.style.cssText = 'height: 8px; background: #000; box-shadow: 0 0 0 1px #2c3640';
    const bar = track.appendChild(el('div', 'wf-go-bar'));
    bar.style.width = `${Math.max(0, Math.min(100, Math.round((base.hp / base.maxHp) * 100)))}%`;
    if (hp <= 0) bar.style.display = 'none';
    well.appendChild(track);
    goBases.appendChild(well);
  });
}

function renderStatRows(data) {
  goRows.innerHTML = '';
  const ffa = data.mode === 'ffa';
  const order = (t) => (ffa ? 0 : t === data.winner ? 0 : t === 'red' ? 1 : 2);
  const rows = [...data.stats].sort((a, b) => order(a.team) - order(b.team) || (ffa ? (a.place || 9) - (b.place || 9) : 0) || b.baseDmg - a.baseDmg || b.kills - a.kills || a.name.localeCompare(b.name));
  rows.forEach((s) => {
    const won = ffa ? s.place === 1 : s.team === data.winner;
    const row = el('div', `row well${ffa ? ' ffa' : ''}`);
    row.style.boxShadow = `inset 0 0 0 1px #000, inset 0 0 0 2px ${sideOf(s.team).ring}`;
    row.appendChild(el('span', `por tm-${s.team}`, UNIT_SPRITES[RACE_PORTRAITS[s.race]] || ''));
    const who = el('span');
    who.style.minWidth = '0';
    if (ffa && s.place) who.appendChild(el('span', `wf-place p${s.place}`)).textContent = ordinal(s.place);
    if (s.name === data.mvp) who.appendChild(el('span', 'amb')).textContent = '★ ';
    const nm = el('span');
    Object.assign(nm.style, { fontWeight: '700', color: sideOf(s.team).label });
    nm.textContent = s.name === data.you ? 'YOU' : s.name.toUpperCase();
    who.appendChild(nm);
    const race = el('span');
    Object.assign(race.style, { display: 'block', fontSize: '9.5px', color: '#8fa3b5', letterSpacing: '.12em' });
    race.textContent = `${(RACE_NAMES[s.race] || '').toUpperCase()}${ffa ? ` · ${sideOf(s.team).name.toUpperCase()}` : ''}${s.connected ? '' : ' · OFFLINE'}`;
    who.appendChild(race);
    row.appendChild(who);
    row.appendChild(el('span', won ? 'grn' : '')).textContent = s.kills;
    row.appendChild(el('span')).textContent = s.lost;
    row.appendChild(el('span', s.name === data.mvp ? 'amb' : '')).textContent = Math.round(s.baseDmg);
    if (ffa) {
      const pts = row.appendChild(el('span', s.points ? 'grn' : ''));
      pts.style.fontWeight = '700';
      pts.textContent = `+${s.points || 0}`;
    }
    goRows.appendChild(row);
  });
  goMvp.classList.toggle('hidden', !data.mvp);
}

export function renderGameOver(data) {
  const { winner } = data;
  const ffa = data.mode === 'ffa';
  Object.keys(SIDE).forEach((t) => goRoot.classList.toggle(`wf-go-${t}-won`, winner === t));
  goRoot.classList.toggle('wf-go-draw', winner === 'draw');
  goRoot.classList.toggle('wf-go-ffa', ffa);
  if (S.goBuiltFor !== data.clock.startedAt) {
    buildGameOverScene(data);
    S.goBuiltFor = data.clock.startedAt;
  }

  // "Blue base destroyed · round 11" -> how it ended, with the match time.
  const time = fmtMatchTime(data.matchMs);
  const loser = fallenSide(data) || (winner === 'red' ? 'blue' : 'red');
  if (ffa) {
    const shared = (data.placings || []).filter((p) => p.place === 1).map((p) => TEAM_NAME[p.side]);
    goReason.textContent = winner === 'draw'
      ? (data.endReason === 'base' && shared.length ? `${shared.join(' & ')} fell together · ${time}` : `Time up · bases level · ${time}`)
      : data.endReason === 'base' ? `Last side standing · ${time}` : `Time up · ${TEAM_NAME[winner]} base stood strongest · ${time}`;
  } else if (winner === 'draw') {
    goReason.textContent = data.endReason === 'base' ? `Both bases destroyed · ${time}` : `Time up · bases level · ${time}`;
  } else {
    goReason.textContent = data.endReason === 'base' ? `${TEAM_NAME[loser]} base destroyed · ${time}` : `Time up · ${TEAM_NAME[winner]} base stood stronger · ${time}`;
  }
  goReason.style.color = { red: '#ff9a9d', blue: '#9ac0ff', green: '#8fe8c4', gold: '#ffe08a' }[winner] || '#8fa3b5';
  goTitle.textContent = winner === 'draw' ? 'DRAW' : `${winner.toUpperCase()} WINS!`;
  // The mockup's 50px fits "RED WINS!" on a 390px phone; "BLUE WINS!" needs a little less, "GREEN WINS!" less again.
  goTitle.style.fontSize = goTitle.textContent.length > 10 ? '42px' : goTitle.textContent.length > 9 ? '44px' : '50px';
  // The mockup shows a winner's phone (◆ VICTORY ◆); the other side reads its defeat.
  const lost = !ffa && data.myTeam && winner !== 'draw' && data.myTeam !== winner;
  goSub.textContent = ffa ? '◆ FREE FOR ALL ◆' : winner === 'draw' ? '◆ STALEMATE ◆' : lost ? '◆ DEFEAT ◆' : '◆ VICTORY ◆';
  goSub.className = lost ? '' : 'amb';
  goSub.style.color = lost ? '#ff5a5f' : '';
  goSub.style.textShadow = lost ? '0 0 6px rgba(255,90,95,.5)' : '';

  renderBaseWells(data);
  renderStatRows(data);

  goAgain.disabled = !data.canCommand;
  const againSide = SIDE[winner] ? winner : 'red';
  Object.keys(SIDE).forEach((t) => goAgain.classList.toggle(`wf-go-${t}`, againSide === t));
  if (!goError.textContent || goError.classList.contains('wf-notice')) {
    goError.classList.toggle('wf-notice', !data.canCommand);
    goError.textContent = data.canCommand ? '' : ffa ? 'The host starts the next battle' : 'The host or a captain starts the next battle';
  }
  renderScoreboard(goScoreboard, data.scoreboard || []);
  S.ctx.showScreen('warfrontOver');
}
