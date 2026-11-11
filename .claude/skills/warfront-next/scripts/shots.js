#!/usr/bin/env node
/**
 * Warfront screenshot helper for the warfront-next skill.
 *
 * Starts the app on a throwaway data dir, plays two phones (red host "David" and
 * blue "Bob") through choose game -> team select -> Start Battle, and saves phone-width
 * screenshots (390px, 2x) at each stage into OUT_DIR:
 *
 *   1-team-select.png   host on the team-select screen, teams + races picked
 *   2-battle-red.png    host on the battlefield
 *   3-battle-blue.png   Bob on the battlefield
 *
 * Usage: node .claude/skills/warfront-next/scripts/shots.js OUT_DIR [--map small|medium|large] [--full]
 *   --full   capture the whole scrolling screen instead of one phone viewport
 *
 * If a step adds UI that needs an action first (select a unit, move, open a tab...),
 * add it in the `afterBattle` hook below before the battle screenshots.
 * Exits non-zero (and prints the page errors) if anything fails.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repo = path.resolve(__dirname, '../../../..');
const outDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'warfront-shots'));
const mapSize = (process.argv.includes('--map') && process.argv[process.argv.indexOf('--map') + 1]) || 'medium';
const full = process.argv.includes('--full');
const PORT = 3600 + Math.floor(Math.random() * 300);
const URL = `http://localhost:${PORT}/`;

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  console.error('Playwright is not available. In a cloud session it is pre-installed; locally run: npm i -D playwright');
  process.exit(2);
}

/** Hook for step-specific actions before the battle screenshots. */
async function afterBattle(/* host, bob */) {}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-data-'));
  const server = spawn(process.execPath, ['server.js'], {
    cwd: repo,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, OPENAI_API_KEY: '', DATABASE_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });

  const browser = await chromium.launch({
    args: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
  });
  const errors = [];
  try {
    for (let i = 0; i < 50 && !/listening/i.test(serverLog); i++) await new Promise((r) => setTimeout(r, 200));
    if (!/listening/i.test(serverLog)) throw new Error(`server did not start:\n${serverLog}`);

    async function player(name) {
      const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
      const p = await c.newPage();
      p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
      p.on('console', (m) => {
        if (m.type() === 'error' && !/vibrate/.test(m.text())) errors.push(`${name} console: ${m.text()}`);
      });
      await p.goto(URL);
      await p.fill('#name-input', name);
      await p.click('#join-btn');
      await p.waitForSelector('#lobby-screen:not(.hidden)');
      return p;
    }

    async function shot(page, screenSel, file) {
      if (full) {
        const h = await page.evaluate((sel) => {
          const inner = document.querySelector(`${sel} .wf`) || document.querySelector(sel);
          return inner ? inner.scrollHeight : 844;
        }, screenSel);
        await page.setViewportSize({ width: 390, height: Math.max(844, h) });
        await page.waitForTimeout(300);
      }
      await page.screenshot({ path: path.join(outDir, file) });
      if (full) await page.setViewportSize({ width: 390, height: 844 });
      console.log('saved', path.join(outDir, file));
    }

    const host = await player('David');
    const bob = await player('Bob');
    await host.click('#choose-warfront-btn');
    await host.waitForSelector('#wf-team-screen:not(.hidden)');
    await bob.waitForSelector('#wf-team-screen:not(.hidden)');
    await host.click('#wf-join-red');
    await bob.click('#wf-join-blue');
    await host.click('#wf-captain-btn');
    await host.click('#wf-race-list .r-forge');
    await bob.click('#wf-race-list .r-arcane');
    await host.click(`#wf-size-seg button:nth-child(${{ small: 1, medium: 2, large: 3 }[mapSize] || 2})`);
    await host.waitForTimeout(500);
    await shot(host, '#wf-team-screen', '1-team-select.png');

    await host.click('#wf-start-btn');
    await host.waitForSelector('#wf-screen:not(.hidden)', { timeout: 20000 });
    await bob.waitForSelector('#wf-screen:not(.hidden)', { timeout: 20000 });
    await host.waitForTimeout(1000);
    await afterBattle(host, bob);
    await shot(host, '#wf-screen', '2-battle-red.png');
    await shot(bob, '#wf-screen', '3-battle-blue.png');
  } finally {
    await browser.close();
    // Let the server finish its last rooms.json write before deleting its data dir.
    await new Promise((resolve) => {
      server.once('exit', resolve);
      server.kill();
    });
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch (e) {
      // best effort: it's a temp dir
    }
  }
  if (errors.length) {
    console.error('Page errors:\n' + errors.join('\n'));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
