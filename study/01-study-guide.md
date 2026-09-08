# Study Guide: JavaScript / React / React Native for the Moveo Interview

Moveo's stack leans heavily on React Native and JavaScript. You're strong in
Java but less confident in JS/React — this is a **junior** round, so the goal
is basics fluency, not framework mastery: know what closures, `async`/`await`,
and props-vs-state *are*, in your own words, with a concrete example ready for
each. This codebase (Shorot) is real, working JavaScript you already
half-understand — it's your best study material, because every abstract JS
concept below has an actual line of code in this repo to point at instead of
a memorized definition.

Read the docs in this folder in order:

1. **This file** — orientation, study order, self-test questions.
2. **`02-javascript-fundamentals.md`** — core JS logic, each concept mapped
   from what you already know in Java, anchored to real lines in this repo.
   **This is the one to know cold.**
3. **`03-react-and-react-native-basics.md`** — React basics (components,
   props/state, hooks) built on a direct contrast with this app's vanilla-DOM
   frontend, then React Native specifics (no DOM, `View`/`Text`, Flexbox,
   Metro).
4. *(Bonus, if the round goes deeper into "walk me through a project you
   built")* **`04-websockets-and-concurrency.md`** and **`05-scaling.md`** —
   deep dives on this app's backend architecture. Not the focus for a junior
   JS/RN round, but good material if asked to talk through something you
   built end-to-end.

Total time for the core material (docs 1–3): **~3.5–4.5 hours**, plus hands-on
practice below. If you only have 90 minutes, read doc 2 in full, skim doc 3's
headers and code samples, and do the self-tests at the end of each.

---

## 0. The one-paragraph pitch (memorize this)

Shorot is a same-room party game platform: players join a shared room from their
own phones using a 4-character code, one host picks from four mini-games
(Imposter, Codenames, 10 Seconds, Menifot — a poker variant), and a scoreboard
persists across games within the room. It's a Node/Express + Socket.io backend
with a single in-memory `Map` of room state, and a vanilla JS/HTML/CSS frontend
with no build step (no React — worth knowing, in case they ask "did you use
React for this"; a fair honest answer is in doc 3 §8, the "conceptual bridge"
paragraph, on how you'd rebuild it in React/RN). Two of the four games call
OpenAI's API at runtime to generate words/hints/boards.

## 1. Study order and time budget

| Step | What | Files | Time |
|---|---|---|---|
| 1 | Read `02-javascript-fundamentals.md` in full | — | 1.5–2 hr |
| 2 | Do the self-test at the end of doc 2, out loud, no notes | — | 15 min |
| 3 | Read `03-react-and-react-native-basics.md` in full | — | 1.5 hr |
| 4 | Do the self-test at the end of doc 3, out loud, no notes | — | 15 min |
| 5 | Skim `public/js/games/imposter.js` and `public/js/shared/dom.js` for 10 min with fresh eyes — you should now recognize closures, callbacks, destructuring, and imperative-DOM-vs-React patterns you didn't notice before | `public/js/games/imposter.js`, `public/js/shared/dom.js` | 15 min |
| 6 | Practice writing 3–4 small JS snippets from scratch (see §3 below) without looking anything up | — | 30–45 min |
| 7 | *(If time allows)* Read `04-websockets-and-concurrency.md` and `05-scaling.md` for "tell me about a project" ammunition | — | 1–1.5 hr |
| 8 | Run the app locally, play one round of Imposter across two browser tabs, so you have a live demo ready if asked | — | 20 min |

## 2. What "junior" actually means for this interview

Screening/junior rounds test **breadth and clear explanation**, not
production-scale system design. Concretely:

- They'll ask you to **define** things (closures, `let` vs `const`, props vs
  state) and expect a correct one-to-two-sentence answer plus a small example
  — not a deep dive.
- They may give a **small live-coding prompt**: reverse a string, dedupe an
  array, FizzBuzz, "find the first even number," implement a basic component.
  Fluency with array methods (doc 2 §6) and `useState`/basic JSX (doc 3 §3–6)
  covers most of this.
- They will **not** expect you to already know React Native's advanced
  APIs, performance optimization, or navigation library internals. Naming
  the right concept ("that's what `useEffect`'s dependency array is for") is
  enough at this level even if you haven't used it in production.
- Bridge from Java honestly and confidently: "X in JS is like Y in Java,
  except Z" is a strong answer style for this round — it shows you're
  transferring real understanding, not just pattern-matching syntax.

## 3. Practice snippets — write these from scratch, no lookups

The fastest way to convert "I read about closures" into "I can answer a
closure question live" is to actually type code. Do these on paper or in a
blank file, then check yourself against doc 2/3:

1. Write a function `dedupe(arr)` that returns an array with duplicates
   removed, using a `Set`.
2. Write `sumEvens(arr)` using `.filter()` and `.reduce()`.
3. Write a closure-based counter: a function `makeCounter()` that returns an
   object `{ increment, getValue }`, where `getValue` always reflects the
   current count — no module-level/global variable.
4. Write the classic `var` vs `let` loop example from doc 2 §8 from memory,
   and explain out loud why the output differs.
5. Write a tiny `async function fetchTwice()` that calls an (imaginary)
   `async function getData()` twice with `await`, and wraps it in `try`/
   `catch`.
6. Write a function component `Counter()` using `useState` that renders a
   number and a button that increments it.
7. Write a component `PlayerList({ players })` that renders an `<ul>` of
   `<li key={...}>` from a `players` array, each showing `player.name`.

## 4. The map — what lives where

```
server.js                  bootstrap only: express/http/io setup, load/save interval, listen
server/                    CommonJS (require/module.exports) — see doc 2 §12
  roomStore.js              the `rooms` Map (all state), room-code generation, io.to().emit() wrapper
  persistence.js             snapshot rooms to data/rooms.json every 5s, reload on boot
  lobby.js                  cross-game: create/join room, host handoff, scoreboard, disconnect/reconnect dispatch
  gameRegistry.js            wires the game modules into shared dispatch points
  lib/
    shuffle.js, validateName.js, openai.js
  games/
    imposter.js codenames.js tenseconds.js menifot.js menifot-eval.js musicTimeline.js allInOrFold.js
public/                     ES Modules (import/export) — see doc 2 §12, same syntax as React Native
  js/
    main.js                  bootstrap + lobby glue
    shared/                  dom.js, format.js, scoreboard.js — helpers shared across games
    games/                   one module per game, e.g. imposter.js — mirrors the server/games/ split
  index.html, style.css
specs/                      one .md per game describing rules/UX
implementation/             implementation plans and design docs (refactor_plan.md: why the module contract looks the way it does, and what's NOT solved yet)
```

**The one thing to internalize about the backend**: every game module exports
the same shape (`id`, `minPlayers`, `onChoose`, `registerHandlers`,
`reconnectPayload`, `onDisconnect`, `savedFields`, optional
`repairOnLoad`/`clearState`) — a plugin contract. `gameRegistry.js` is the
only file that knows which games exist; `roomStore.js`/`persistence.js`/
`lobby.js` never hardcode a game name. Good "tell me about a project"
material, but secondary for this round — see docs 4/5 if it comes up.

## 5. Self-test questions

**Primary — do these first, they're what this round actually tests.** The
full self-tests at the end of `02-javascript-fundamentals.md` and
`03-react-and-react-native-basics.md` are the core of your prep — go there
and answer every one of them out loud before you'd call yourself ready.

**Bonus — architecture/backend, only if "tell me about a project" comes up:**

<details>
<summary>Architecture, WebSockets, concurrency, scaling questions (click to expand)</summary>

**Architecture**
- Why is there one `rooms` Map instead of a database? What's the tradeoff?
- What is `ctx` and why does every game module take it as a parameter instead
  of just `require()`-ing `roomStore.js` directly? *(→ answer: avoids a
  circular require between `games/*.js` and `roomStore.js`/`lobby.js`, and
  keeps each game's dependencies explicit/mockable.)*
- Room state is one flat object with every game's fields at the top level
  (`cnBoard`, `tsActivePlayers`, `mfHands` all coexist). Why wasn't it
  namespaced per game? What's the actual risk of leaving it flat?

**WebSockets**
- Why does the imposter never see the crew's word, and the crew never see the
  hint? Where in the code does that asymmetry actually get enforced?
- What's the difference between `roomEmit(roomCode, ...)` and
  `io.to(socket.id).emit(...)`? When does the code use each?
- Every socket handler takes a `callback` parameter. What pattern is that, and
  why not just fire-and-forget events?
- What happens, socket-by-socket, when a phone's screen locks and then
  unlocks 30 seconds later?

**Concurrency**
- Node.js is single-threaded. Given that, can two players' `guessWord` events
  in Codenames ever interleave and corrupt `room.cnBoard`? Why or why not?
- Where does this app *not* get that guarantee for free — i.e. where does an
  `await` create a window where the world can change under you? (Hint: look at
  `generateWordAndHint` / `generateWordGrid` and the check right after the
  `await`.)
- Two players disconnect from a Codenames game in the same event-loop tick.
  Walk through what happens.

**Scaling**
- What's the single biggest reason this app can't run on two server instances
  today, unmodified?
- If you had to support 500 concurrent rooms tomorrow with zero code changes,
  what's actually the bottleneck — CPU, memory, or something else?
- Name two things you'd change first, in order, if traffic 10x'd.

</details>

## 6. A narrative you can tell in an interview

If asked "walk me through what happens when someone joins a room," you should
be able to narrate this without looking at code:

1. Client has `myName`/`myRoomCode` cached in `localStorage` from a previous
   session, or the user just typed them in.
2. Client emits `socket.emit('join', { name, roomCode }, callback)` —
   note the third argument, an acknowledgement callback, not a fire-and-forget.
3. Server's `join` handler (`server/lobby.js`) validates the name, normalizes
   the room code, and calls `joinExistingRoom`.
4. If the name already exists in `room.players` and is marked disconnected,
   this is treated as a **reconnect**: socket is attached to the room
   (`socket.join(roomCode)`), the player's `socketId` is updated, and the
   currently-active game module is asked for a `reconnectPayload` — a
   phase-appropriate snapshot of state so the client can jump straight back
   into whatever screen matches the room's current phase.
5. If the name is new and the room is still in the lobby phase, a fresh player
   entry is created.
6. The callback fires with `{ ok: true, game, phase, ... }`; the client's
   `routeFromJoin` reads `res.game`/`res.phase` and shows the matching screen —
   there's no separate "sync state" step, the join response *is* the full
   state sync.

This example is deliberately reused as the backbone of `04-websockets-and-
concurrency.md`'s WebSocket section, if you get to the bonus docs.
