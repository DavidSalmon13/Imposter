/**
 * Crew gate for the built-in sticker bank (photos of the original friend group).
 *
 * Every sticker picture in the app (pickers, lobby avatars, reactions, badges, player
 * cards) loads from /images/stickers/<file>, so this one route is the gate: a browser
 * without the crew cookie gets a neutral generated avatar instead of the photo, under
 * the same filename. Picking, badges and reactions keep working unchanged; strangers
 * just see generic faces.
 *
 * The crew unlocks a device once by opening /crew?code=<CREW_CODE>, which sets a
 * long-lived httpOnly cookie. If CREW_CODE is unset, nobody is crew and everyone sees
 * the neutral avatars.
 */
const crypto = require('crypto');

const CREW_COOKIE = 'shorot_crew';
const CREW_COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const STICKER_PATH_RE = /^\/([\w.-]+)$/;

function crewCode() {
  return process.env.CREW_CODE || '';
}

/** The cookie value is derived from the code, so rotating CREW_CODE locks out old devices. */
function crewToken(code) {
  return crypto.createHmac('sha256', code).update('shorot-crew-v1').digest('hex');
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function isCrew(req) {
  const code = crewCode();
  if (!code) return false;
  const token = readCookie(req, CREW_COOKIE);
  return Boolean(token) && safeEqual(token, crewToken(code));
}

const PLACEHOLDER_TONES = ['#5b7fd6', '#d67f5b', '#5bd6a6', '#c15bd6', '#d6c05b', '#5bb8d6', '#d65b7f'];

/** A neutral face, coloured and shaped deterministically from the filename. */
function placeholderSvg(file) {
  const h = crypto.createHash('sha256').update(file).digest();
  const tone = PLACEHOLDER_TONES[h[0] % PLACEHOLDER_TONES.length];
  const eyeY = 40 + (h[1] % 6);
  const smile = 6 + (h[2] % 10);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<circle cx="50" cy="50" r="44" fill="${tone}" stroke="#fff" stroke-width="4"/>
<circle cx="36" cy="${eyeY}" r="6" fill="#241207"/><circle cx="64" cy="${eyeY}" r="6" fill="#241207"/>
<path d="M34 64 Q50 ${64 + smile} 66 64" fill="none" stroke="#241207" stroke-width="5" stroke-linecap="round"/>
</svg>`;
}

/**
 * Middleware for /images/stickers. Mount it before the static handlers: crew requests
 * fall through to the real files; everyone else gets the placeholder for any known id.
 * Responses vary by cookie, so they're private and always revalidated.
 */
function stickerGate({ isValidSticker }) {
  return (req, res, next) => {
    res.set('Cache-Control', 'private, no-cache');
    res.set('Vary', 'Cookie');
    if (isCrew(req)) return next();
    const m = STICKER_PATH_RE.exec(req.path);
    if (!m || !isValidSticker(m[1])) return next();
    res.type('image/svg+xml').send(placeholderSvg(m[1]));
  };
}

/** GET /crew?code=... unlocks this device and returns to the app. */
function registerCrewRoutes(app) {
  app.get('/crew', (req, res) => {
    const code = crewCode();
    const given = String(req.query.code || '');
    if (!code || !given || !safeEqual(given, code)) {
      return res.status(403).type('text').send('Wrong or missing crew code.');
    }
    res.cookie(CREW_COOKIE, crewToken(code), {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: CREW_COOKIE_MAX_AGE_MS,
      path: '/',
    });
    res.redirect('/');
  });
}

module.exports = { CREW_COOKIE, isCrew, crewToken, placeholderSvg, stickerGate, registerCrewRoutes };
