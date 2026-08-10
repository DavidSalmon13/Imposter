# Study Guide: Shorot

A roadmap for learning this codebase well enough to present it in an interview —
not just "what it does" but "why it's built this way" and "what I'd change."

Read the three docs in this folder in order:

1. **This file** — orientation, study order, self-test questions.
2. **`02-websockets-and-concurrency.md`** — the two concepts you specifically asked
   about, explained against this app's actual code.
3. **`03-scaling.md`** — what breaks first under load and how you'd fix it.

Total time: **~6-8 hours** if you also click through the app in a browser while
reading. Budget below.

---

## 0. The one-paragraph pitch (memorize this)

Shorot is a same-room party game platform: players join a shared room from their
own phones using a 4-character code, one host picks from four mini-games
(Imposter, Codenames, 10 Seconds, Menifot — a poker variant), and a scoreboard
persists across games within the room. It's a Node/Express + Socket.io backend
with a single in-memory `Map` of room state, and a vanilla JS/HTML/CSS frontend
with no build step. Two of the four games call OpenAI's API at runtime to
generate words/hints/boards.

## 1. Study order and time budget

| Step | What | Files | Time |
|---|---|---|---|
| 1 | Run it locally, create a room, play one round of Imposter with two browser tabs | — | 20 min |
| 2 | Read the specs for the game you'll demo | `specs/imposter_specs.md` (+ others) | 20 min |
| 3 | Read the shared "core" — this is the part every game plugs into | `server/roomStore.js`, `server/persistence.js`, `server/gameRegistry.js`, `server/lobby.js`, `server.js` | 1.5 hr |
| 4 | Read `02-websockets-and-concurrency.md` in this folder | — | 45 min |
| 5 | Read **one** game module end-to-end, e.g. `server/games/imposter.js` (smallest, cleanest state machine) | `server/games/imposter.js` | 45 min |
| 6 | Skim the other three game modules — you don't need mastery, just enough to compare | `codenames.js`, `tenseconds.js`, `menifot.js` | 1 hr |
| 7 | Read the client-side counterpart for the game you studied in step 5 | `public/client.js` (grep for `imposter`/`vote`/`role`) | 45 min |
| 8 | Read `03-scaling.md` | — | 30 min |
| 9 | Read `refactor_plan.md` in the repo root — it's a real design doc explaining *why* the module boundaries are where they are | `refactor_plan.md` | 20 min |
| 10 | Do a disconnect/reconnect test yourself (kill wifi mid-game, watch it recover) | — | 15 min |

That's ~6 hours of reading plus the hands-on steps. If you only have 2 hours,
do steps 1, 3, 4, 5, 8.

## 2. The map — what lives where

```
server.js                  bootstrap only: express/http/io setup, load/save interval, listen
server/
  roomStore.js              the `rooms` Map (all state), room-code generation, io.to().emit() wrapper
  persistence.js             snapshot rooms to data/rooms.json every 5s, reload on boot
  lobby.js                  cross-game: create/join room, host handoff, scoreboard, disconnect/reconnect dispatch
  gameRegistry.js            wires the 4 game modules into shared dispatch points
  lib/
    shuffle.js, validateName.js, openai.js
  games/
    imposter.js codenames.js tenseconds.js menifot.js menifot-eval.js
public/
  client.js                 ALL frontend logic for all 4 games (monolithic, no build step)
  index.html, style.css
specs/                      one .md per game describing rules/UX — read before touching game logic
refactor_plan.md            design doc: why the module contract looks the way it does, and what's NOT solved yet
```

**The one thing to internalize**: every game module exports the same shape
(`id`, `minPlayers`, `onChoose`, `registerHandlers`, `reconnectPayload`,
`onDisconnect`, `savedFields`, optional `repairOnLoad`/`clearState`). This is a
plugin contract. `gameRegistry.js` is the only file that knows all four games
exist — `roomStore.js`, `persistence.js`, and `lobby.js` never hardcode a game
name. This is the single most interview-worthy architectural decision in the
repo: **adding a 5th game touches zero existing game files.**

## 3. Self-test questions

Answer these out loud, from memory, before you'd call yourself ready. Each one
maps to a section in the deep-dive doc.

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

## 4. A narrative you can tell in an interview

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

This example is deliberately reused as the backbone of the deep-dive doc's
WebSocket section — read that next.
