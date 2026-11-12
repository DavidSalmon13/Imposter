/**
 * Warfront client: the top HUD. Base HP bars, the match clock and the enemies-in-sight strip.
 * Must NOT contain: the console info well (console/selection.js). Mockup: 2-battlefield.html.
 */

import { S } from './store.js';
import { el } from './util.js';
import { RACE_NAMES } from './constants.js';
import { hpEl, hpSegEl, clockEl, stripEl } from './dom.js';

// ---------- HUD ----------

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
  const teamColour = (t) => (t === 'red' ? '#ff7a7e' : '#7fb0ff');
  mine.forEach((p) => {
    line(p.connected ? '#4dff7a' : '#4c5b69', p.name === data.you ? 'YOU' : p.name.toUpperCase(), teamColour(p.team),
      p.connected ? RACE_NAMES[p.race].toLowerCase() : 'offline');
  });
  if (enemies.length) {
    // The mockup's "hidden" now says whether any of them are inside your vision.
    const t = enemies[0].team;
    const seen = Boolean(S.live && S.live.units.some((u) => u.team === t));
    line(seen ? '#ffcc33' : '#4c5b69', `${t.toUpperCase()} ×${enemies.length}`, teamColour(t), seen ? 'in sight' : 'hidden');
  }
}
