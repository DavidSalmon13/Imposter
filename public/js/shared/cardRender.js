/**
 * Shared, state-free DOM builders for badges and rivals - used by the lobby's badge/
 * rivalry toast pop-ups (public/js/shared/account.js) and the full account page
 * (public/js/account-page.js), so neither duplicates the other's markup.
 */

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
    lock.textContent = '🔒';
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
