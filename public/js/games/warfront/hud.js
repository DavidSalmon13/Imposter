/**
 * Warfront client: the top HUD. Base HP bars, the match clock and the enemies-in-sight strip.
 * Must NOT contain: the console info well (console/selection.js). Mockup: 2-battlefield.html.
 */

import { S } from './store.js';
import { el } from './util.js';
import { RACE_NAMES } from './constants.js';
import { hpEl, hpSegEl, hpNameEl, sideEl, hudEl, clockEl, clockLabelEl, stripEl, outBanner, outTitle, outText, outIcon } from './dom.js';
import { SIDE, SIDES, sideOf, ordinal } from './sides.js';

// ---------- HUD ----------

/**
 * Every side's base bar. Team battles: red and blue as in the mockup. Free for all
 * (5b-ffa-battlefield.html): every side in the battle, smaller, yours marked YOU, a fallen base
 * greyed with its place.
 */
export function renderBases(view) {
  const ffa = S.state.mode === 'ffa';
  hudEl.classList.toggle('wf-ffa', ffa);
  clockLabelEl.textContent = ffa ? 'FREE FOR ALL' : 'MATCH';
  SIDES.forEach((team) => {
    const base = view.bases[team];
    sideEl[team].classList.toggle('hidden', !base);
    if (!base) return;
    const place = ((view.placings || []).find((p) => p.side === team) || {}).place;
    const out = ffa && base.hp <= 0 && place != null;
    sideEl[team].classList.toggle('wf-out', out);
    sideEl[team].classList.toggle('wf-me', ffa && team === S.state.myTeam);
    hpNameEl[team].textContent = ffa ? SIDE[team].name.toUpperCase() : `${SIDE[team].name.toUpperCase()} BASE`;
    renderHp(team, out ? { hp: 0, maxHp: base.maxHp } : base);
    if (out) {
      hpEl[team].textContent = `OUT · ${ordinal(place)}`;
      hpEl[team].className = '';
    }
  });
  renderOutBanner(view);
}

/** Your own knock-out stays up for the rest of the match; someone else's shows for a few seconds. */
function renderOutBanner(view) {
  if (view.out) {
    const mine = (view.placings || []).find((p) => p.side === S.state.myTeam);
    showOut('👁️', `YOU ARE OUT${mine ? ` · ${ordinal(mine.place)}` : ''}`, 'Your base fell. Watching the whole map until the end.', true);
  } else if (outBanner.classList.contains('wf-out-mine') || (S.outShownUntil && Date.now() > S.outShownUntil)) {
    // A new battle (no longer out), or another side's news has had its few seconds.
    outBanner.classList.remove('wf-out-mine');
    outBanner.classList.add('hidden');
    S.outShownUntil = 0;
  }
}

function showOut(icon, title, text, mine) {
  outIcon.textContent = icon;
  outTitle.textContent = title;
  outText.textContent = text;
  outBanner.classList.toggle('wf-out-mine', mine);
  outBanner.classList.remove('hidden');
  S.outShownUntil = mine ? 0 : Date.now() + 4000;
}

/** A `knockedOut` event: another side's base fell (your own is the lasting banner above). */
export function announceKnockout(e) {
  if (!S.state || e.team === S.state.myTeam) return;
  const left = Object.values(S.live ? S.live.bases : {}).filter((b) => b.hp > 0).length;
  const who = (S.state.roster || []).filter((p) => p.team === e.team).map((p) => p.name).join(', ');
  showOut('💥', `${sideOf(e.team).name.toUpperCase()} IS OUT · ${ordinal(e.place)}`,
    `${who ? `${who}’s` : 'Their'} base has fallen.${left > 1 ? ` ${left} sides remain.` : ''}`, false);
}

export function renderHp(team, base) {
  const pct = base.maxHp ? base.hp / base.maxHp : 0;
  const lit = Math.max(0, Math.min(12, Math.ceil(pct * 12)));
  const colour = pct >= 0.75 ? '#4dff7a' : pct >= 0.35 ? '#ffcc33' : '#ff5a5f';
  hpEl[team].textContent = Math.max(0, Math.round(base.hp));
  hpEl[team].className = pct >= 0.75 ? 'grn' : 'amb';
  hpSegEl[team].innerHTML = '';
  for (let i = 0; i < 12; i++) {
    const seg = el('span');
    const c = i < lit ? colour : '#1a2028';
    seg.style.background = c;
    seg.style.boxShadow = `0 0 4px ${c}`;
    hpSegEl[team].appendChild(seg);
  }
}

export function tickClock() {
  if (!S.state || S.state.phase !== 'playing' || !S.state.clock) return;
  const left = Math.max(0, S.state.clock.matchEndsAt - (Date.now() + S.clockSkew));
  const secs = Math.ceil(left / 1000);
  clockEl.textContent = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
  // The mockup's blinking timer, saved for the last minute.
  clockEl.style.animation = secs <= 60 ? 'wfBlink 1s steps(1) infinite' : 'none';
}

export function renderStrip(data) {
  stripEl.innerHTML = '';
  const mine = data.roster.filter((p) => p.team === data.myTeam);
  const enemies = data.roster.filter((p) => p.team !== data.myTeam);
  const line = (led, nameText, nameColour, sub) => {
    const r = el('span', 'rdy');
    const l = el('span', 'led');
    l.style.background = led;
    l.style.boxShadow = `0 0 5px ${led}`;
    r.appendChild(l);
    const n = el('span');
    n.style.color = nameColour;
    n.textContent = nameText;
    r.appendChild(n);
    const s2 = el('span');
    s2.style.color = '#8fa3b5';
    s2.textContent = sub;
    r.appendChild(s2);
    stripEl.appendChild(r);
  };
  const teamColour = (t) => sideOf(t).label;
  mine.forEach((p) => {
    line(p.connected ? '#4dff7a' : '#4c5b69', p.name === data.you ? 'YOU' : p.name.toUpperCase(), teamColour(p.team),
      p.connected ? RACE_NAMES[p.race].toLowerCase() : 'offline');
  });
  // One line per enemy side (two sides in a team battle, up to three in free for all). The mockup's
  // "hidden" now says whether any of them are inside your vision; a knocked-out side says so.
  const sides = [...new Set(enemies.map((p) => p.team))];
  sides.forEach((t) => {
    const n = enemies.filter((p) => p.team === t).length;
    const base = S.live && S.live.bases[t];
    if (base && base.hp <= 0) {
      line('#4c5b69', sides.length > 1 || n === 1 ? t.toUpperCase() : `${t.toUpperCase()} ×${n}`, teamColour(t), 'out');
      return;
    }
    const seen = Boolean(S.live && S.live.units.some((u) => u.team === t));
    const label = data.mode === 'ffa' ? enemies.find((p) => p.team === t).name.toUpperCase() : `${t.toUpperCase()} ×${n}`;
    line(seen ? '#ffcc33' : '#4c5b69', label, teamColour(t), seen ? 'in sight' : 'hidden');
  });
}
