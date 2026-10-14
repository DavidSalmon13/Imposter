/**
 * Shared feedback layer: synthesized sound effects, haptics, and an
 * animated scoreboard renderer used by every game screen.
 */

const MUTE_KEY = 'shorot-muted';
const prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let muted = localStorage.getItem(MUTE_KEY) === '1';
let audioCtx = null;

function getAudioCtx() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!audioCtx) audioCtx = new Ctx();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// Browsers block audio until a user gesture; prime the context on the first one. A touch
// pointerdown doesn't count as a gesture on Android Chrome, so touchend/click cover that.
['pointerdown', 'touchend', 'click', 'keydown'].forEach((evt) => {
  window.addEventListener(evt, () => getAudioCtx(), { once: true, passive: true });
});

function tone(freq, duration, { type = 'sine', gain = 0.12, delay = 0 } = {}) {
  if (muted) return;
  const ctx = getAudioCtx();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const start = ctx.currentTime + delay;
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(gain, start + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

// --- Animal tap sounds: clips from public/sounds/, listed by GET /api/sounds ---

const TAP_GAIN = 0.6;
let tapBuffers = [];
let tapLoadStarted = false;
let tapSource = null;
let lastTapIndex = -1;

// Decoding needs a running AudioContext, so this is kicked off on the first gesture
// rather than at import. Missing or undecodable files are skipped.
function loadTapSounds() {
  if (tapLoadStarted) return;
  tapLoadStarted = true;
  const ctx = getAudioCtx();
  if (!ctx) return;
  fetch('/api/sounds')
    .then((res) => (res.ok ? res.json() : { sounds: [] }))
    .then(({ sounds }) =>
      Promise.all(
        (sounds || []).map((file) =>
          fetch(`/sounds/${encodeURIComponent(file)}`)
            .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject()))
            // Callback form: Safari < 14.1 doesn't return a promise from decodeAudioData.
            .then((data) => new Promise((resolve, reject) => ctx.decodeAudioData(data, resolve, reject)))
            .catch(() => null)
        )
      )
    )
    .then((buffers) => {
      tapBuffers = buffers.filter(Boolean);
    })
    .catch(() => {});
}

['pointerdown', 'touchend', 'click', 'keydown'].forEach((evt) => {
  window.addEventListener(evt, loadTapSounds, { once: true, passive: true });
});

// Plays a random clip (never the same one twice in a row), cutting off the previous
// one so fast tapping doesn't pile sounds on top of each other. Returns false if no
// clips are loaded so the caller can fall back.
function playTapSound() {
  if (!tapBuffers.length) return false;
  const ctx = getAudioCtx();
  if (!ctx) return false;
  let i = Math.floor(Math.random() * tapBuffers.length);
  if (tapBuffers.length > 1 && i === lastTapIndex) i = (i + 1) % tapBuffers.length;
  lastTapIndex = i;
  if (tapSource) {
    try {
      tapSource.stop();
    } catch (e) {
      // already ended
    }
  }
  const src = ctx.createBufferSource();
  const g = ctx.createGain();
  src.buffer = tapBuffers[i];
  g.gain.value = TAP_GAIN;
  src.connect(g);
  g.connect(ctx.destination);
  src.onended = () => {
    if (tapSource === src) tapSource = null;
  };
  src.start();
  tapSource = src;
  return true;
}

export const sfx = {
  click() {
    if (muted) return;
    if (playTapSound()) return;
    tone(520, 0.06, { type: 'square', gain: 0.05 });
  },
  scoreUp() {
    tone(660, 0.12, { type: 'triangle' });
    tone(880, 0.16, { type: 'triangle', delay: 0.07 });
  },
  scoreDown() {
    tone(220, 0.18, { type: 'sawtooth', gain: 0.08 });
  },
  win() {
    [523, 659, 784, 1046].forEach((freq, i) => tone(freq, 0.18, { type: 'triangle', delay: i * 0.09 }));
  },
  join() {
    tone(440, 0.08);
    tone(660, 0.1, { delay: 0.06 });
  },
  error() {
    tone(180, 0.15, { type: 'sawtooth', gain: 0.08 });
  },
};

export function isMuted() {
  return muted;
}

export function setMuted(value) {
  muted = !!value;
  localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
}

export function toggleMuted() {
  setMuted(!muted);
  return muted;
}

export function haptic(pattern) {
  if (muted) return;
  if (navigator.vibrate) navigator.vibrate(pattern);
}

export const haptics = {
  tap() {
    haptic(10);
  },
  success() {
    haptic([15, 40, 15]);
  },
  warn() {
    haptic(60);
  },
};

// --- Animated scoreboard rendering, shared by every game's scoreboard list ---

const scoreboardPrev = new WeakMap();

function animateCount(el, from, to, duration = 650) {
  if (prefersReducedMotion) {
    el.textContent = to > 0 ? `+${to}` : String(to);
    return;
  }
  const start = performance.now();
  function frame(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - (1 - t) ** 3;
    const value = Math.round(from + (to - from) * eased);
    el.textContent = value > 0 ? `+${value}` : String(value);
    if (t < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/**
 * Renders a scoreboard <ol>/<ul> from {name, points} entries, animating any
 * point changes since the last render of this same list and playing a
 * score-up/score-down cue when something changes on a currently visible list.
 */
export function renderScoreboardFx(listEl, entries) {
  if (!listEl) return;
  const prev = scoreboardPrev.get(listEl) || new Map();
  const next = new Map();
  let anyUp = false;
  let anyDown = false;

  listEl.innerHTML = '';
  (entries || []).forEach(({ name, points }) => {
    const li = document.createElement('li');
    const nameSpan = document.createElement('span');
    nameSpan.textContent = name;
    const ptsSpan = document.createElement('span');
    ptsSpan.className = 'sb-points' + (points < 0 ? ' negative' : '');
    li.appendChild(nameSpan);
    li.appendChild(ptsSpan);
    listEl.appendChild(li);

    const hadPrev = prev.has(name);
    const from = hadPrev ? prev.get(name) : points;
    next.set(name, points);

    if (hadPrev && from !== points) {
      animateCount(ptsSpan, from, points);
      const up = points > from;
      li.classList.add(up ? 'sb-flash-up' : 'sb-flash-down');
      setTimeout(() => li.classList.remove('sb-flash-up', 'sb-flash-down'), 900);
      if (up) anyUp = true;
      else anyDown = true;
    } else {
      ptsSpan.textContent = points > 0 ? `+${points}` : String(points);
    }
  });

  scoreboardPrev.set(listEl, next);

  const visible = listEl.offsetParent !== null;
  if (visible) {
    if (anyUp) {
      sfx.scoreUp();
      haptics.success();
    } else if (anyDown) {
      sfx.scoreDown();
      haptics.warn();
    }
  }
}
