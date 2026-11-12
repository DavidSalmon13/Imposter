'use strict';

// Warfront engine tests: engine purity. No I/O, clocks or randomness in any file under
// server/games/warfront/engine/ (the same check the single-file engine had, now over every file).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ENGINE_DIR = path.join(__dirname, '../../../../server/games/warfront/engine');

function engineFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? engineFiles(path.join(dir, d.name)) : d.name.endsWith('.js') ? [path.join(dir, d.name)] : []);
}

test('engine source has no non-deterministic or I/O calls', () => {
  const src = engineFiles(ENGINE_DIR)
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  for (const banned of ['Math.random', 'Date.now', 'setInterval', 'setTimeout', "require('socket.io", 'fetch(']) {
    assert.ok(!src.includes(banned), banned);
  }
});
