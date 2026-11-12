---
name: warfront-next
description: Implement the next unfinished Warfront step from docs/implementation/warfront-plan.md, then send the user three phone-width screenshots of the UI it touched. Use when the user says "next Warfront step", "continue Warfront", "/warfront-next" or similar.
---

# Warfront: do the next step, show three screenshots

## 1. Pick the step

Open `docs/implementation/warfront-plan.md` and take the **first** `### Step N` heading without ✅.
Do only that step. Say which one you're doing in one line, then start (no need to ask).

## 2. Build it

If the `warfront-step` skill is available, follow it for this step. Otherwise, the short version:

- **Read first:** `docs/specs/warfront-specs.md` (rules + the binding "Look & feel" section and swap
  table), the step in the plan (and decisions D1–D12), `CLAUDE.md`, and
  `docs/implementation/warfront-code-map.md`, which tells you which 1–3 files of the earlier steps' code
  (`server/games/warfront/engine/`, `server/games/warfront/`, `public/js/games/warfront/`,
  `public/warfront/`, `tests/games/warfront/`) to open and where new code goes. For UI work also
  the matching mockup in `docs/design/warfront/` and its source in `docs/design/warfront/source/`.
- **Rules:** the engine stays pure (no sockets/timers/`Date.now()`/`Math.random()`); hidden info
  goes per-socket, never `roomEmit`; every handler checks game, phase and who's asking, and
  answers `callback({ ok, error })`; port the mockup's markup/CSS/SVG (no emoji art, no
  look-alikes). If the spec and plan disagree or something is undefined, stop and ask.
- **Small modules:** new code goes where the code map says, in files of **≤400 lines** (hard cap
  500). Split along the seams before a file grows past that, keep the code map's layer rules (no
  circular imports), start each new file with a 3–6 line header, and update the code map when you
  add or move a file.
- **Tests:** write every test the step lists; `npm test` must be fully green (run `npm install`
  first if `node_modules` is missing).
- **Finish:** mark the step ✅ in the plan with a one-line note of anything that changed, commit
  naming the step, push to the session's branch. Steps 5, 6 and 7 go to a PR (ask before opening
  one if the user hasn't said).

## 3. Three screenshots

Skip this section only if the step had no frontend change, and say so.

```bash
node .claude/skills/warfront-next/scripts/shots.js <scratchpad>/shots-step-N
```

The script starts the app on a throwaway data dir (no OpenAI key, so the procedural map is
used), plays two phones (red host David, blue Bob) through team select into a battle, and saves:

1. `1-team-select.png` - the team-select screen
2. `2-battle-red.png` - the battlefield as red
3. `3-battle-blue.png` - the battlefield as blue

Options: `--map small|medium|large`, `--full` (whole scrolling screen instead of one phone view).

**Make the three shots show what this step changed.** If the new UI needs an action first
(select a unit, issue a move, open a tab, wait for combat...), add it to the `afterBattle(host,
bob)` hook in `scripts/shots.js` (and keep the change: commit it with the step, so the next run
gets it too). If a step's new screen isn't reached by the script (e.g. game over), extend the
script to reach it and swap one of the three shots for it. Always exactly three images.

Look at each image yourself before sending. If something looks broken, fix it and re-shoot.
Then send all three in **one** `SendUserFile` call with a caption naming the step and what each
shot shows.

## 4. Report

A short message: what was built, the test result (pass/fail counts), what the screenshots show,
anything deferred or worth the user trying on a real phone, and the next step's number.
