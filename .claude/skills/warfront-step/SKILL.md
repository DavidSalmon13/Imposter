---
name: "warfront-step"
description: "Implement one or more steps of the Warfront build plan (docs/implementation/warfront-plan.md) in the Shorot/Imposter repo, e.g. \"implement Warfront Step 3\" or \"do Warfront Steps 1-2\"."
---

# Implementing a Warfront step

Warfront is built in small, checked chunks. Each run implements **only the step(s) named** in the
request — never the next one. If no step is named, find the first step in
`docs/implementation/warfront-plan.md` not marked ✅, confirm it with the user, and do that one.

## 1. Read before writing any code

Read these in full, every run (a fresh session has no memory of earlier steps):

1. `docs/specs/warfront-specs.md` — the rules source of truth, including the
   **"Look & feel — the design is binding"** section and its swap table.
2. `docs/implementation/warfront-plan.md` — decisions D1–D12, naming reference, and the step(s) you're
   doing. Skim the earlier steps marked ✅ to know what already exists.
3. `docs/implementation/refactor_plan.md` §4 — the game-module contract.
4. `CLAUDE.md` — repo conventions and testing rules.
5. For any client step: the matching mockup(s) in `docs/design/warfront/` and their editable source in
   `docs/design/warfront/source/*.dc.html`, plus `docs/design/warfront/README.md`.
6. `docs/implementation/warfront-code-map.md`: where every part of Warfront lives, the "to change X,
   edit Y" table, the dependency-layer rules and where this step's new code goes. Then open **only**
   the files it points you to (usually 1–3 per feature) in `server/games/warfront/engine/`,
   `server/games/warfront/`, `public/js/games/warfront/`, `public/warfront/` and
   `tests/games/warfront/`. Extend that code, don't rewrite it.

Then check `git log --oneline -10` and `git status` so you start from the current `main`.

## 2. Hard rules

- **Scope:** only the named step(s). If you notice something a later step needs, leave it for that
  step (mention it in your report).
- **Spec and plan win.** If they disagree with each other, or something the step needs isn't
  defined, **stop and ask the user** — don't guess. If the user changes a rule, update the spec
  first, then the plan.
- **Engine purity:** nothing under `server/games/warfront/engine/` uses sockets, timers, OpenAI,
  `Date.now()` or `Math.random()` (`tests/games/warfront/engine/purity.test.js` checks). Time comes
  in as `now`; randomness from `rngFor(seed, tick)`.
- **Small modules (≤400 lines):** put new code where the code map says. A new system gets its own
  `engine/systems/<name>.js`, wired through `commands.js`/`sim.js`. A new client part gets its own
  module and is called from `battle.js`. New styles get a new `public/warfront/<part>.css` linked
  last in `index.html`. No file may exceed 400 lines (hard cap 500): split along the seams first.
  Keep the layer rules (no circular imports, no lower layer importing a higher one, no client module
  importing `index.js`/`battle.js`, shared client state only in `store.js`'s `S`). Start every new
  file with the 3–6 line header (what it owns, what it must not contain, which spec/mockup section).
  Update the code map when you add or move a file.
- **Use the plan's names** for files, events, functions and state fields (`wf` prefix).
- **Design is binding:** the game must look exactly like `docs/design/warfront/`. Port the mockup's
  markup, CSS and SVG — don't recreate a look-alike and never use emoji placeholder art. Apply
  only the round-based → real-time swaps listed in the spec. New elements the mockups don't draw
  must use the same visual language. If the design can't be matched (e.g. the 2.5D camera
  stutters on a phone), **stop and ask** — don't ship a different look.
- **Hidden info is server-side only:** fog and team-only data go per-socket via `io.to(socketId)`,
  never `roomEmit`, never hidden with CSS.
- **Every handler** guards `room.game === 'warfront'`, the phase, and the caller's authority, and
  answers `callback({ ok, error })`.

## 3. Build

- Implement the step exactly as the plan lists it, including every test it names.
- Engine tests: tiny hand-made maps, fixed seed, call `stepSim` N times, assert the result.
- Module tests: use `tests/helpers/harness.js` (`createTestCtx`, `makeHandlerSocket`, `mockOpenAi`,
  `emissionsFor`) and `t.mock.timers` for the sim loop.

## 4. Verify

1. `npm install` (if `node_modules` is missing), then `npm test` — everything must pass, not just
   the Warfront tests. If installs are blocked in this environment, say so plainly; don't claim
   tests passed.
2. For steps with a client part, drive it in a headless browser using the repo's `verify` skill
   (`.claude/skills/verify/SKILL.md`): the step's **Browser:** check from the plan, plus one
   disconnect/reconnect. Screenshot each new screen next to its mockup at phone width (390px) and
   fix differences that aren't in the spec's swap table.

## 5. Finish

1. Mark the step(s) ✅ in `docs/implementation/warfront-plan.md` (heading), with a one-line note of
   anything that deviated or was deferred.
2. Commit with a message naming the step(s).
3. **Steps 5, 6 and 7** (sim loop, combat, economy): push a branch and open a PR instead of pushing
   to `main`, unless the user said otherwise. Other steps: push to `main` if the user asked to.
4. Report briefly: what was built, test result, screenshots vs mockups (send them), what the user
   should try in the browser themselves, and the next step's number.