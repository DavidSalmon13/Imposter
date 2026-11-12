'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const crew = require('../server/crew');

const KNOWN = 'abc.webp';

/** Real express app: the gate in front of a stand-in for the static sticker files. */
async function startApp(t, code) {
  const previous = process.env.CREW_CODE;
  if (code === undefined) delete process.env.CREW_CODE;
  else process.env.CREW_CODE = code;
  t.after(() => {
    if (previous === undefined) delete process.env.CREW_CODE;
    else process.env.CREW_CODE = previous;
  });

  const app = express();
  app.use('/images/stickers', crew.stickerGate({ isValidSticker: (id) => id === KNOWN }));
  app.use('/images/stickers', (req, res) => res.type('text').send(`real ${req.path}`));
  crew.registerCrewRoutes(app);
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return (path, cookie) =>
    fetch(base + path, { redirect: 'manual', headers: cookie ? { cookie } : {} });
}

test('strangers get a neutral SVG for a known sticker', async (t) => {
  const get = await startApp(t, 'secret-code');
  const res = await get(`/images/stickers/${KNOWN}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(res.headers.get('cache-control'), /private/);
  assert.match(await res.text(), /^<svg/);
});

test('unknown files fall through instead of getting a placeholder', async (t) => {
  const get = await startApp(t, 'secret-code');
  const res = await get('/images/stickers/nope.webp');
  assert.equal(await res.text(), 'real /nope.webp');
});

test('the placeholder is the same for the same file', () => {
  assert.equal(crew.placeholderSvg(KNOWN), crew.placeholderSvg(KNOWN));
});

test('/crew with the right code sets a cookie that unlocks the real sticker', async (t) => {
  const get = await startApp(t, 'secret-code');
  const unlock = await get('/crew?code=secret-code');
  assert.equal(unlock.status, 302);
  const setCookie = unlock.headers.get('set-cookie');
  assert.match(setCookie, new RegExp(`^${crew.CREW_COOKIE}=`));
  assert.match(setCookie, /HttpOnly/i);
  const cookie = setCookie.split(';')[0];
  const res = await get(`/images/stickers/${KNOWN}`, cookie);
  assert.equal(await res.text(), `real /${KNOWN}`);
});

test('/crew rejects a wrong or missing code', async (t) => {
  const get = await startApp(t, 'secret-code');
  assert.equal((await get('/crew?code=wrong')).status, 403);
  assert.equal((await get('/crew')).status, 403);
});

test('a cookie made for an old code stops working after the code changes', async (t) => {
  const get = await startApp(t, 'new-code');
  const cookie = `${crew.CREW_COOKIE}=${crew.crewToken('old-code')}`;
  const res = await get(`/images/stickers/${KNOWN}`, cookie);
  assert.match(res.headers.get('content-type'), /image\/svg\+xml/);
});

test('with CREW_CODE unset nobody can unlock', async (t) => {
  const get = await startApp(t, undefined);
  assert.equal((await get('/crew?code=')).status, 403);
  const cookie = `${crew.CREW_COOKIE}=${crew.crewToken('')}`;
  const res = await get(`/images/stickers/${KNOWN}`, cookie);
  assert.match(res.headers.get('content-type'), /image\/svg\+xml/);
});
