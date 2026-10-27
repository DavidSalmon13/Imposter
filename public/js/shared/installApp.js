/**
 * "Add to Home Screen" buttons on the join screen and in the lobby. Android/desktop
 * Chrome hand us a beforeinstallprompt event we can trigger from the button; iPhone
 * Safari has no such API, so there the button shows the Share -> Add to Home Screen
 * steps instead.
 */

let deferredPrompt = null;

function isInstalled() {
  return (
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    window.navigator.standalone === true
  );
}

function isIos() {
  const ua = navigator.userAgent || '';
  // iPadOS reports itself as a Mac, so tell it apart by its touchscreen.
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isAndroid() {
  return /Android/i.test(navigator.userAgent || '');
}

/** Single-button sheet listing the manual steps, styled like confirmDialog. */
function showSteps(title, steps) {
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';

  const panel = document.createElement('div');
  panel.className = 'confirm-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');

  const titleEl = document.createElement('h2');
  titleEl.className = 'confirm-title';
  titleEl.textContent = title;
  panel.appendChild(titleEl);

  const list = document.createElement('ol');
  list.className = 'install-steps';
  steps.forEach((step) => {
    const li = document.createElement('li');
    li.textContent = step;
    list.appendChild(li);
  });
  panel.appendChild(list);

  const okBtn = document.createElement('button');
  okBtn.type = 'button';
  okBtn.textContent = 'Got it';
  panel.appendChild(okBtn);

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  function onKey(e) {
    if (e.key === 'Escape') close();
  }
  function close() {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  }
  okBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onKey);
  okBtn.focus();
}

export function initInstallButtons(btns) {
  btns = btns.filter(Boolean);

  // Phones always get the button (with manual steps as the fallback); desktops only
  // once the browser says the app is installable.
  function refresh() {
    const show = !isInstalled() && (deferredPrompt || isIos() || isAndroid());
    btns.forEach((btn) => btn.classList.toggle('hidden', !show));
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    refresh();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    btns.forEach((btn) => btn.classList.add('hidden'));
  });

  async function onClick() {
    if (deferredPrompt) {
      const promptEvent = deferredPrompt;
      // A prompt event can only be shown once; the browser fires a fresh one if declined.
      deferredPrompt = null;
      promptEvent.prompt();
      try {
        await promptEvent.userChoice;
      } catch (e) {}
      refresh();
      return;
    }
    if (isIos()) {
      showSteps('Add Shorot to your Home Screen', [
        'Tap the Share button (the square with an arrow) in the browser bar.',
        'Scroll down and tap "Add to Home Screen".',
        'Tap "Add" - Shorot now opens like an app.',
      ]);
    } else {
      showSteps('Add Shorot to your Home Screen', [
        'Open your browser menu (⋮ at the top or bottom of the screen).',
        'Tap "Install app" or "Add to Home screen".',
        'Confirm - Shorot now opens like an app.',
      ]);
    }
  }

  btns.forEach((btn) => btn.addEventListener('click', onClick));
  refresh();
}
