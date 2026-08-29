# Music Timeline: How to Run This

The plan (`music-timeline-plan.md`) has **10 steps**, each its own checkbox. Do **one step per
session** — that's what makes each session's work small enough to actually verify in a browser
before moving on, same convention this repo already used for the `refactor_plan.md` migration.

## How many sessions

**10 sessions**, one per step in `music-timeline-plan.md`'s checklist. Some steps are small and
might go fast (Step 1 is mostly scaffolding); don't combine steps in one sitting even if a
session finishes early — stop, verify, come back for the next one. If a step turns out to need
more back-and-forth (bug fixes, a verify step failing), that's still the same session — just keep
going until that one step's checkbox is genuinely done and verified.

## The prompt (same one, every session)

Paste exactly this, every time:

```
Read ../specs/music-timeline-specs.md and music-timeline-plan.md. Find the first
unchecked (- [ ]) step in music-timeline-plan.md's "Implementation order"
checklist. Implement only that step. Tell me exactly how to verify it (which
browser actions to take), then wait for me to confirm it works before marking
the checkbox [x].
```

## What you do each session

1. Paste the prompt above.
2. Claude implements one step.
3. Claude tells you what to click through in the browser to verify it (per that step's "Verify"
   note in the plan).
4. You actually do that in a browser — this repo has no automated tests, so this is the real
   check, not optional.
5. If it works: tell Claude to mark the box `[x]` and stop for the session. If it doesn't: tell
   Claude what went wrong and let it fix it before marking the box, same session.
6. Start a fresh session next time you're ready for the next step — the prompt is identical, it
   just naturally picks up the next unchecked box.

## When you're done

After session 10, every box in `music-timeline-plan.md` is checked and Music Timeline is fully
playable end-to-end, including tokens, disconnects, and a server restart mid-game. At that point
it's worth one last full regression pass — play all six games back-to-back — which is already
what Step 10 ends with.
