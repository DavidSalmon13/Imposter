# Kart Race — Session Split & Agent Prompts

Companion to `specs/kart-race.md` (rules/UX) and `kart-race-plan.md` (the 15-step
implementation checklist). This file says *when* to start a new session and *what to paste*
to kick each one off.

## Why split at all

`kart-race-plan.md`'s 15 steps are already ordered as "implement one, verify, then move on"
— but there's no test suite in this repo, so most verification is manual (read logs, or
click around a browser). A single unbroken agent session has no natural place to stop and
let you actually check that verification instead of just asserting it passed. Splitting at
the points where the *kind* of verification changes keeps each session's blast radius small
and gives you a real place to look before the next chunk gets built on top.

**Cross-session continuity**: each new session's agent starts cold — it has no memory of
this conversation. `kart-race-plan.md`'s checkboxes are the shared source of truth for where
things stand, the same way `refactor_plan.md`'s checkboxes already track that refactor.
**Every session below ends by flipping its completed steps' `- [ ]` to `- [x]` in
`kart-race-plan.md`** — that's what lets session 2's agent know session 1 actually finished
step 8 and isn't lying about it, without you having to re-explain anything.

## The three sessions

| Session | Plan steps | Needs a browser to verify? | Risk if skipped/rushed |
|---|---|---|---|
| 1 — Server core | 1–8 | No — logs / `require()` only | Physics/collision math bugs silently propagate into every later step |
| 2 — Client wiring | 9–10 | Yes, but just screen routing (no 3D) | Broken socket/DOM plumbing wastes session 3 debugging phantom rendering issues that are actually plumbing issues |
| 3 — 3D + multiplayer | 11–15 | Yes, real multi-tab play-testing | Most iteration-heavy step; wants your full attention and a fresh context, not the tail end of a long session |

Do them in order — each one's prompt tells the agent to read the plan and stop at the
session boundary, but nothing stops you from running two sessions back-to-back in one sitting
if session 1 comes out clean. The point is the checkpoint exists, not that you're forced to
wait a day between them.

---

## Session 1 — Server core (plan steps 1–8)

**What "done" looks like**: `server/games/kartRace.js` exists and implements the full
contract, `server/gameRegistry.js` has the one-line wire-up, `public/data/kart-track.json`
exists and is internally consistent, and the server boots clean with the other four games
unaffected. No client changes yet — Kart Race isn't reachable from the UI after this session.

**Prompt to send:**

> Implement Session 1 of the Kart Race feature: `kart-race-plan.md` steps 1 through 8 only
> (track data JSON + the full `server/games/kartRace.js` module + wiring it into
> `server/gameRegistry.js`). Read `specs/kart-race.md` and `kart-race-plan.md` in full first
> — the plan already specifies exact constants, formulas, and file shapes, don't re-derive
> them from scratch or deviate without telling me why.
>
> Stop after step 8. Do not touch `public/` or start on client code — that's session 2.
> For each step's verification note, actually do it (require the module, log tick output for
> a mocked room, etc.) and show me the result rather than asserting it passed. Flip each
> completed step's `- [ ]` to `- [x]` in `kart-race-plan.md` as you finish it. At the end,
> give me a short summary of what you verified and anything from the plan you had to
> deviate from or that turned out ambiguous.

---

## Session 2 — Client wiring, no 3D yet (plan steps 9–10)

**What "done" looks like**: choosing Kart Race from the lobby (with a real second browser
tab/player) reaches the ready screen and shows the player list; starting it transitions
phases and the (still-empty) race/results panels show/hide correctly. No track, no karts
rendered — `#kr-canvas` can be a blank rectangle at this point, that's expected.

**Prompt to send:**

> Implement Session 2 of the Kart Race feature: `kart-race-plan.md` steps 9 and 10 (vendor
> Three.js + `index.html` changes + the minimal `client.js` shim). Read `specs/kart-race.md`
> and `kart-race-plan.md` first — session 1 already finished steps 1–8 and flipped their
> checkboxes, confirm that's true before starting rather than assuming it.
>
> `public/js/games/kartRace.js` only needs to exist as a stub that exports `init`,
> `applyState`, `stop` for now — don't build the Three.js scene yet, that's session 3. Focus
> on: the screen/DOM/socket plumbing actually working end-to-end.
>
> Stop after step 10. Start the dev server (`npm start`) and tell me it's running so I can
> open two browser tabs and check the ready-screen flow myself — don't declare this session
> done until I confirm it. Flip `- [ ]` to `- [x]` in `kart-race-plan.md` for steps 9–10 only
> after I've confirmed it works.

---

## Session 3 — 3D rendering + multiplayer play-testing (plan steps 11–15)

**What "done" looks like**: the full manual test flow from `specs/kart-race.md`'s Testing
section passes with real multi-tab play — track renders, karts move and interpolate
smoothly, item boxes/hazards/collisions behave, a race can be finished, ranked, scored, and
replayed, and disconnect/reconnect resumes correctly.

**Prompt to send:**

> Implement Session 3 of the Kart Race feature: `kart-race-plan.md` steps 11 through 15 —
> the full Three.js scene, kart rendering, client-side interpolation, and the complete
> manual test pass. Read `specs/kart-race.md` and `kart-race-plan.md` first, and confirm
> steps 1–10 are actually checked off before starting.
>
> This is the most iteration-heavy part — expect to go back and forth with me on feel (turn
> rate, camera distance, hazard placement) once it's actually visible and driveable. Build
> incrementally per the plan's step order (static scene first, then one kart, then
> multi-tab), and after each step tell me what to look at in the browser rather than moving
> on unprompted. I'll open the tabs and drive; tell me specifically what to check for at
> each step (e.g. "steer left, confirm the kart turns and doesn't clip through the inner
> curve"). Flip each step's checkbox in `kart-race-plan.md` only once I've confirmed it
> in-browser, not on your own assessment of the code.

---

## If a session goes off the rails

If an agent session stalls, produces something clearly wrong, or you want to abandon its
changes: check `git status`/`git diff` before discarding anything (per this repo's normal
safety habits), and note in `kart-race-plan.md` (as a comment under the relevant step, not
by unchecking a box that's genuinely done) what went wrong so the next session's agent —
which won't remember this conversation either — doesn't repeat it.
