/**
 * In-app replacement for window.confirm() - the native dialog renders in the OS's own
 * style (and language), with the site URL as its title, which doesn't fit the app.
 */

let openDialog = null;

/**
 * Resolves true on confirm, false on cancel / backdrop tap / Escape. Opening a new
 * dialog while one is still up cancels the old one.
 */
export function confirmDialog(message, { title = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
  if (openDialog) openDialog.close(false);

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';

    const panel = document.createElement('div');
    panel.className = 'confirm-panel';
    panel.setAttribute('role', 'alertdialog');
    panel.setAttribute('aria-modal', 'true');

    if (title) {
      const titleEl = document.createElement('h2');
      titleEl.className = 'confirm-title';
      titleEl.textContent = title;
      panel.appendChild(titleEl);
    }

    const messageEl = document.createElement('p');
    messageEl.className = 'confirm-message';
    messageEl.textContent = message;
    panel.appendChild(messageEl);

    const row = document.createElement('div');
    row.className = 'btn-row';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'secondary';
    cancelBtn.textContent = cancelLabel;
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.textContent = confirmLabel;
    if (danger) okBtn.classList.add('confirm-danger');
    row.appendChild(cancelBtn);
    row.appendChild(okBtn);
    panel.appendChild(row);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    function onKey(e) {
      if (e.key === 'Escape') close(false);
    }

    function close(result) {
      if (openDialog !== handle) return;
      openDialog = null;
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(result);
    }

    const handle = { close };
    openDialog = handle;

    cancelBtn.addEventListener('click', () => close(false));
    okBtn.addEventListener('click', () => close(true));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(false);
    });
    document.addEventListener('keydown', onKey);
    okBtn.focus();
  });
}
