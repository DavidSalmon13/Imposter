---
name: verify
description: How to launch and drive Shorot end-to-end in a headless browser to verify changes.
---

# Verifying Shorot changes

## Launch

```bash
DATA_DIR=<scratchpad>/data PORT=3517 node server.js   # run_in_background
```

Always point `DATA_DIR` at a scratch dir and delete its `rooms.json` between runs —
room state persists every 5s and reloads on boot, so stale rooms leak across runs.
No OPENAI_API_KEY needed for AIOF/Menifot/10 Seconds (only Imposter/Codenames word gen).

## Drive

No Playwright installed. Use `puppeteer-core` (npm i in scratchpad) driving installed Edge:
`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`, `headless: 'new'`.

Gotchas that cost real time:

- **Multi-player = one browser, one incognito context per player**
  (`browser.createBrowserContext()`), each with its own page. Same-profile pages share
  localStorage and collide on the session-restore keys (`imposterRoom` etc.) —
  `localStorage.clear()` + reload before typing a name.
- **Pass anti-throttling flags** or a backgrounded page's socket.io connection dies and
  that player silently stops receiving broadcasts:
  `--disable-background-timer-throttling --disable-backgrounding-occluded-windows
  --disable-renderer-backgrounding --disable-features=CalculateNativeWinOcclusion`.
- **Don't use `offsetParent !== null` for visibility** — it's always null inside
  `position: fixed` screens (e.g. `#aiof-screen`). Walk `getComputedStyle` display /
  visibility up to `<body>` instead.
- The first player clicks `#create-room-btn` and reads the 4-char code from
  `#room-code-display`; others fill `#room-code-input` and click `#join-btn`. The creator is host. The
  AIOF tile (`#choose-allinorfold-btn`) is visible to every player, not just the host.

## Worth driving

Full happy path per CLAUDE.md (create → play a round → scoreboard → back to lobby)
plus one disconnect/reconnect. For AIOF specifically: seat + buy-in slider, a contested
all-in showdown (reveal stages ~1.5s apart — wait for `#aiof-nexthand-btn`, not fixed
sleeps), the bust→rebuy and sit-out→buy-back-in sheets, and the gameover ranking overlay.
Hand outcomes are random — don't assume who busts; give both players equal buy-ins if
the test needs a guaranteed bust.
