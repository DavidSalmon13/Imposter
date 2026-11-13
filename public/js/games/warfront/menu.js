/**
 * Warfront client: the in-battle menu behind the ☰ button. Restart the battle (host or
 * captain: fresh map, same teams, no points) or send everyone back to the lobby.
 * Must NOT contain: the game-over screen's Play Again / Back (gameOver.js).
 */

import { S } from './store.js';
import { flashError } from './util.js';
import { confirmDialog } from '../../shared/confirmDialog.js';

let overlay = null;

function close() {
  if (overlay) overlay.remove();
  overlay = null;
  document.removeEventListener('keydown', onKey);
}

function onKey(e) {
  if (e.key === 'Escape') close();
}

function item(label, sub, onClick, { danger = false, disabled = false } = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `wf-menu-item${danger ? ' wf-menu-danger' : ''}`;
  b.disabled = disabled;
  b.innerHTML = `<span class="wf-menu-lbl"></span><span class="wf-menu-sub"></span>`;
  b.firstChild.textContent = label;
  b.lastChild.textContent = sub;
  b.addEventListener('click', onClick);
  return b;
}

/** Opens the menu over the battlefield. */
export function openMenu(socket) {
  if (overlay) return close();
  const canCommand = Boolean(S.state && S.state.canCommand);
  overlay = document.createElement('div');
  overlay.className = 'wf-menu-overlay';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  const panel = document.createElement('div');
  panel.className = 'wf-menu-panel';
  panel.setAttribute('role', 'menu');
  const title = document.createElement('div');
  title.className = 'wf-menu-title';
  title.textContent = 'Battle menu';
  panel.appendChild(title);

  panel.appendChild(item('↻ Restart battle', canCommand ? (S.state.mode === 'ffa' ? 'New map, same players · no points' : 'New map, same teams · no points') : (S.state.mode === 'ffa' ? 'Only the host' : 'Only the host or a captain'), async () => {
    close();
    const ok = await confirmDialog('This battle ends with no winner and a new one starts on a fresh map with the same teams.', {
      title: 'Restart the battle?',
      confirmLabel: 'Restart',
      danger: true,
    });
    if (!ok) return;
    socket.emit('restartWarfront', (res) => {
      if (!res || !res.ok) flashError((res && res.error) || 'Could not restart the battle');
    });
  }, { disabled: !canCommand }));

  panel.appendChild(item('◂ Back to lobby', 'Ends the battle for everyone', async () => {
    close();
    const ok = await confirmDialog('Everyone goes back to the lobby and this battle ends.', {
      title: 'Leave the battle?',
      confirmLabel: 'Leave',
      danger: true,
    });
    if (ok) socket.emit('backToLobby', () => {});
  }, { danger: true }));

  panel.appendChild(item('Resume', '', close));
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  document.addEventListener('keydown', onKey);
}

/** Closes the menu if it's open (leaving the battle screen). */
export function closeMenu() {
  close();
}
