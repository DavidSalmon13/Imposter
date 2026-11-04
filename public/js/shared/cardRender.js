/**
 * Shared, state-free DOM builders for badges and rivals - used by the lobby's badge/
 * rivalry toast pop-ups (public/js/shared/account.js) and the full account page
 * (public/js/account-page.js), so neither duplicates the other's markup.
 */

const RATING_STATS = ['SPD', 'COM', 'STR', 'TAC', 'NRV', 'DEC'];

/**
 * Builds a standalone FIFA Ultimate Team-style rating card element for `user`/`card`
 * (same shape GET /api/me returns) - used by the lobby's click-to-view popup
 * (public/js/shared/account.js). The full account page (account-page.js) renders its
 * own copy into fixed page elements instead of using this.
 */
export function buildRatingCard(user, card) {
  const ratings = (card && card.ratings) || { ovr: 60, tier: 'bronze', stats: {} };
  const strongGold = ratings.tier === 'gold' && ratings.ovr >= 85;
  const el = document.createElement('div');
  el.className = `rating-card rating-card-${ratings.tier}${strongGold ? ' rating-card-gold-strong' : ''}`;

  const top = document.createElement('div');
  top.className = 'rating-card-top';
  if (user && user.sticker) {
    const img = document.createElement('img');
    img.className = 'rating-photo';
    img.src = `images/stickers/${user.sticker}`;
    img.alt = '';
    top.appendChild(img);
  }
  const ovr = document.createElement('span');
  ovr.className = 'rating-ovr';
  ovr.textContent = ratings.ovr;
  top.appendChild(ovr);
  el.appendChild(top);

  const name = document.createElement('p');
  name.className = 'rating-name';
  name.textContent = (user && user.name) || '';
  el.appendChild(name);

  const stats = document.createElement('div');
  stats.className = 'rating-stats';
  for (const stat of RATING_STATS) {
    const wrap = document.createElement('div');
    wrap.className = 'rating-stat';
    const val = document.createElement('span');
    val.className = 'rating-stat-val';
    val.textContent = ratings.stats[stat] ?? 60;
    const abbr = document.createElement('span');
    abbr.className = 'rating-stat-abbr';
    abbr.textContent = stat;
    wrap.append(val, abbr);
    stats.appendChild(wrap);
  }
  el.appendChild(stats);
  return el;
}

export const GAME_LABELS = {
  imposter: '🕵️ Imposter',
  codenames: '🔴🔵 Codenames',
  tenseconds: '⏱️ 10 Seconds',
  menifot: '🃏 Menifot',
  musictimeline: '🎵 Music Timeline',
  allinorfold: '🎰 All-In or Fold',
  mindmeld: '🧠 Mind Meld',
  bluff: '🂠 Bluff',
};

/**
 * A badge's picture: its sticker from the app's sticker bank, or its emoji if the
 * sticker is gone. Locked badges show the sticker as a dark silhouette with a lock.
 */
export function badgeArt(b, locked, className) {
  const wrap = document.createElement('span');
  wrap.className = className;
  if (b.sticker) {
    const img = document.createElement('img');
    img.src = `images/stickers/${b.sticker}`;
    img.alt = '';
    img.loading = 'lazy';
    wrap.appendChild(img);
  } else {
    wrap.textContent = b.emoji;
  }
  if (locked) {
    const lock = document.createElement('span');
    lock.className = 'badge-lock';
    lock.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
    wrap.appendChild(lock);
  }
  return wrap;
}

/** Renders the "Badges X/14" grid into `grid`, with `heading` and a tap-to-expand `detail` line. */
export function renderBadges(grid, heading, detail, badges) {
  grid.innerHTML = '';
  detail.classList.add('hidden');
  heading.classList.toggle('hidden', !badges.length);
  if (!badges.length) return;
  const earnedCount = badges.filter((b) => b.earned).length;
  heading.textContent = `Badges ${earnedCount}/${badges.length}`;
  // Earned first, then locked, each keeping the server's order.
  const ordered = [...badges.filter((b) => b.earned), ...badges.filter((b) => !b.earned)];
  for (const b of ordered) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = `card-badge${b.earned ? '' : ' locked'}`;
    const name = document.createElement('span');
    name.textContent = b.name;
    tile.append(badgeArt(b, !b.earned, 'card-badge-art'), name);
    tile.addEventListener('click', () => {
      const wasSelected = tile.classList.contains('selected');
      grid.querySelectorAll('.card-badge.selected').forEach((t) => t.classList.remove('selected'));
      if (wasSelected) return detail.classList.add('hidden');
      tile.classList.add('selected');
      detail.textContent = `${b.earned ? '' : '🔒 '}${b.name} - ${b.description}`;
      detail.classList.remove('hidden');
    });
    grid.appendChild(tile);
  }
}

function rivalStatus(r) {
  if (r.wins > r.losses) return { icon: '👑', cls: 'ahead', text: 'You lead' };
  if (r.wins < r.losses) return { icon: '😤', cls: 'behind', text: 'They lead' };
  return { icon: '🤝', cls: '', text: 'Dead even' };
}

/** Head-to-head records into `list`/`heading`; tap a rival to see the record per game. */
export function renderRivals(list, heading, rivals) {
  list.innerHTML = '';
  heading.classList.toggle('hidden', !rivals.length);
  for (const r of rivals) {
    const status = rivalStatus(r);
    const li = document.createElement('li');
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'card-rival';

    const main = document.createElement('span');
    main.className = 'card-rival-main';
    const icon = document.createElement('span');
    icon.textContent = status.icon;
    const name = document.createElement('span');
    name.className = 'card-rival-name';
    name.textContent = `vs ${r.name}`;
    const record = document.createElement('span');
    record.className = `card-rival-record ${status.cls}`;
    record.textContent = `${r.wins}–${r.losses}`;
    main.append(icon, name, record);

    const sub = document.createElement('span');
    sub.className = 'card-rival-sub';
    sub.textContent = `${status.text} · ${r.games === 1 ? '1 game' : `${r.games} games`} together`;

    const games = document.createElement('ul');
    games.className = 'card-rival-games';
    Object.entries(r.byGame)
      .sort((a, b) => b[1].games - a[1].games)
      .forEach(([type, s]) => {
        const g = document.createElement('li');
        const label = document.createElement('span');
        label.textContent = GAME_LABELS[type] || type;
        const value = document.createElement('span');
        value.textContent = `${s.wins}–${s.losses}`;
        g.append(label, value);
        games.appendChild(g);
      });

    row.append(main, sub, games);
    row.addEventListener('click', () => row.classList.toggle('open'));
    li.appendChild(row);
    list.appendChild(li);
  }
}
