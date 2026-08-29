# WebSockets and Concurrency in Shorot

This is your first production multiplayer app, so this doc goes slower than a
typical architecture note — it explains the *general* concept first, then shows
exactly where it lives in this codebase, with file/line pointers you can pull up
live in an interview.

---

## Part 1: WebSockets

### 1.1 What problem they solve

HTTP is request/response: the client asks, the server answers, the connection
(conceptually) closes. That's fine for loading a page, but useless for "tell
every player in this room the moment someone reveals a Codenames card" — the
server has no way to *initiate* a message to the browser over plain HTTP.

A WebSocket is a single TCP connection that starts as an HTTP request (the
"upgrade handshake") and then turns into a full-duplex pipe: either side can
push a message at any time, with no new connection and no polling. That's the
primitive multiplayer apps need — the server needs to say "the board changed"
to five phones simultaneously without any of them asking first.

### 1.2 Why Socket.io instead of raw `WebSocket`

This app uses `socket.io` (`server.js:7`, `public/client.js:1` — `const socket
= io()`), not the raw browser `WebSocket` API. Socket.io adds three things this
app actually leans on:

1. **Automatic reconnection with fallback transports.** If a phone's WebSocket
   connection drops (locked screen, WiFi handoff, cell tower change), the
   client library automatically retries and falls back to HTTP long-polling if
   needed. Raw WebSockets give you none of this — you'd hand-roll retry logic.
2. **Rooms.** `socket.join(roomCode)` (`server/lobby.js:85`,
   `attachToRoom`) puts a connection into a named group; `io.to(roomCode).emit(...)`
   (`roomEmit` in `server/roomStore.js:87-89`) broadcasts to everyone in that
   group in one call. Raw WebSockets give you a bag of open sockets and you'd
   maintain the room membership yourself.
3. **Acknowledgement callbacks.** `socket.emit('event', data, (response) => {...})`
   — the server-side handler receives that callback as its last argument and
   calls it with a result. This gives you request/response ergonomics on top
   of an otherwise fire-and-forget transport. See §1.4.

The tradeoff: Socket.io is a heavier protocol (its own framing on top of
WebSocket/HTTP) and it's not interoperable with a plain `ws://` client — both
ends must use the library. For a room-based party game where every client is
this app's own frontend, that tradeoff is a non-issue.

### 1.3 The room abstraction, concretely

Every socket connection carries per-connection state in `socket.data`
(`server/lobby.js:87`: `socket.data.roomCode = roomCode; socket.data.name =
name;`). This is Socket.io's built-in slot for "stuff attached to this
specific connection" — it's not shared state, it's private to that socket
instance, living in server memory for the lifetime of that connection.

Two emit patterns coexist in this codebase, and the difference between them
is the single most important WebSocket concept to be able to explain:

- **Broadcast to everyone in the room** — `ctx.roomEmit(roomCode, event,
  payload)` → `io.to(roomCode).emit(...)`. Used when all players should see
  the same thing, e.g. `lobbyUpdate`, `teamSelectUpdate`.
- **Targeted emit to one specific connection** — `ctx.io.to(p.socketId).emit(...)`.
  Used whenever players must see *different* things. This is not an edge case
  in this app — it's the mechanic the whole game of Imposter depends on:

  ```js
  // server/games/imposter.js:189-193
  for (const [, p] of room.players) {
    if (p.connected) {
      ctx.io.to(p.socketId).emit('role', { role: p.role, word: p.word, hint: p.hint });
    }
  }
  ```

  The imposter gets `{ role: 'imposter', word: null, hint }`; everyone else
  gets `{ role: 'crew', word, hint: null }`. There is no server-side "hide
  this from that client" filtering happening on a shared payload — the server
  simply never sends the crew's word to the imposter's socket in the first
  place. **This is the correct way to keep information asymmetric in a
  multiplayer game**: never rely on the client to withhold data it already
  received; only send each client the data it's allowed to see. Codenames does
  the same thing for the leader's view of unrevealed board colors
  (`boardForViewer` in `server/games/codenames.js:144-151` — a non-leader gets
  `color: null` for unrevealed cells, computed server-side per viewer before
  the emit, not filtered client-side).

### 1.4 Acknowledgement callbacks — request/response over an async transport

Nearly every client `socket.emit(...)` call passes a callback as the last
argument, and nearly every server `socket.on(...)` handler accepts one:

```js
// client
socket.emit('vote', level, (res) => {
  if (res && res.ok === false) return;
  myVote = level;
  renderVoting();
});

// server — server/games/imposter.js:415-433
socket.on('vote', (level, callback) => {
  callback = callback || (() => {});
  ...
  if (!LEVELS.includes(level)) return callback({ ok: false, error: 'Invalid level' });
  ...
  p.vote = level;
  callback({ ok: true });
  broadcastVoting(ctx, roomCode, room);
  maybeFinishVoting(ctx, roomCode, room);
});
```

This gives the *caller* a definite success/failure result for its own action
(did my vote register?), separate from the *broadcast* that tells everyone
else the room state changed. That split matters: the acknowledgement is
one-to-one (did **my** action succeed), the broadcast is one-to-many (here's
the **new shared state**). Conflating them — e.g. trying to infer "did my vote
work" from the next `votingUpdate` broadcast — would be racy and harder to
show errors for. Every handler in this codebase follows this same two-step
shape: validate → mutate → ack the caller → broadcast the room.

### 1.5 Reconnection — the part that actually matters for a phone-based party game

Phones lock screens, background tabs, and hop between WiFi and cellular
constantly, all of which can kill the underlying transport. Socket.io's client
detects this and reconnects automatically, but **reconnecting the transport is
not the same as resuming your place in the game** — a reconnect gets you a
brand new `socket.id` and a server-side connection object with empty
`socket.data`. All the room/name association is gone unless you rebuild it.

This app's reconnection flow (worth being able to draw on a whiteboard):

1. Client caches `name` and `roomCode` in `localStorage` the moment a join
   succeeds (`rememberSession`, `public/client.js:212-219`).
2. Every time the socket fires `'connect'` — the first connection *and* every
   automatic reconnection after a drop — the client re-runs the exact same
   `join` flow:

   ```js
   // public/client.js:1828-1833
   // Re-sync on every connect, not just the first one - phones suspend the socket when the
   // screen locks or the tab backgrounds, and on reconnect we need to catch back up to the
   // current phase/screen rather than being stuck on whatever was last rendered.
   socket.on('connect', () => {
     if (myName && myRoomCode) attemptJoin(myName, myRoomCode);
   });
   ```

3. On the server, `joinExistingRoom` (`server/lobby.js:108-134`) sees a name
   that already exists in `room.players` with `connected: false` and treats it
   as a reconnect rather than a new join: it flips `connected = true`, updates
   `socketId` to the new connection, re-attaches the socket to the Socket.io
   room, and — critically — asks the *currently active game module* to build a
   `reconnectPayload`. Each game module implements this differently because
   "what does state look like right now" is phase-dependent (mid-vote vs.
   mid-round vs. results screen) — see e.g. `reconnectPayload` in
   `server/games/imposter.js:288-353`, which branches on `room.phase` and
   returns only what that phase needs (a `playing` reconnect gets your
   role/word/hint back; a `voting` reconnect gets the current vote tally).
4. The client's `routeFromJoin` (`public/client.js:342-395`) reads
   `res.game`/`res.phase` from that same response and shows the matching
   screen. There's no separate "resume" code path — a reconnect *is* a join,
   just one that happens to find an existing seat instead of creating a new
   one. That symmetry is a deliberate simplification: one code path to test
   instead of two.
5. Server-side disconnect handling (`server/lobby.js:373-404`) mirrors this:
   past the lobby phase, a dropped connection does **not** delete the player —
   it only marks `connected = false` and lets the active game module react
   (e.g. Imposter auto-defaults an un-submitted elimination report to `true`
   so a stuck reporting phase can't hang forever waiting for someone who's
   gone — `server/games/imposter.js:355-368`). Only in the lobby phase
   (nobody's mid-game yet) does a disconnect actually remove the player.

**Interview-ready one-liner**: "Reconnection isn't a special protocol feature
here — it's an ordinary join request that happens to find an existing,
disconnected player by name, and the server always answers with a full,
phase-correct state snapshot rather than a diff, so the client never needs to
reconcile partial state."

---

## Part 2: Concurrency

### 2.1 The concurrency model you're actually working with

Node.js runs your JavaScript on a **single thread**. There is no
multi-threaded access to `room.players` or `room.cnBoard` — two pieces of your
own code can never execute simultaneously and tear a data structure in half
the way they could in Java or Go without a lock. This is the single fact that
makes most of this codebase's mutation code correct *without* any mutexes,
`synchronized` blocks, or atomic operations anywhere in it.

But "single-threaded" does **not** mean "nothing can interleave." Node's event
loop processes one callback to completion, then picks the next one from the
queue — and `await` is exactly the point where your function *yields* the
thread back to the event loop, letting other events (another player's socket
message, a timer firing) run before your `await` resumes. Concurrency bugs in
this codebase, if they existed, would live at `await` boundaries, not inside
any single synchronous block of code.

### 2.2 Why a synchronous handler is automatically race-free

Take `guessWord` in Codenames (`server/games/codenames.js:466-510`, no
`await` anywhere in it). If two different players' clicks arrive at the
server within microseconds of each other, Node still processes them **one
full handler at a time** — socket A's entire `guessWord` handler runs to
completion (read `room.cnBoard[index]`, check `revealed`, mutate it, maybe end
the turn, emit the new state) before socket B's handler even starts. There is
no window where both handlers are "in the middle of" mutating `cnBoard`
simultaneously. This is why the codebase doesn't need optimistic locking,
version numbers, or compare-and-swap on `cnBoard[index].revealed` — the
runtime guarantees mutual exclusion for free, as long as the handler doesn't
`await` in the middle.

This generalizes: **every fully-synchronous socket handler in this app is
implicitly atomic with respect to every other handler**, including handlers
for a different game module or a different room, because they all share the
one JS thread and none of them yield mid-mutation.

### 2.3 Where the guarantee actually breaks: `await` boundaries

The two places this codebase calls out to OpenAI (`generateWordAndHint` in
`imposter.js`, `generateWordGrid` in `codenames.js`) are genuine concurrency
hazards, because a network call is exactly where a handler yields the thread
for a long time (hundreds of milliseconds) while arbitrary other events —
including more socket events for the *same room* — get processed.

Look at `finishVoting` (`server/games/imposter.js:133-194`):

```js
room.phase = 'generating';
ctx.roomEmit(roomCode, 'generating', { game: 'imposter', level });

let word, hint;
try {
  ({ word, hint } = await generateWordAndHint(room, level));   // <-- yields here
} catch (err) { ... }

// Room may have been deleted while awaiting OpenAI.
if (!ctx.rooms.has(roomCode) || ctx.rooms.get(roomCode) !== room) return;

const names = ctx.connectedNames(room);
if (names.length < MIN_PLAYERS) {
  return failImposterRound(ctx, roomCode, room, `Not enough players remained connected...`);
}
```

Between the `await` and the code that resumes after it, real time passes and
the world can change: every player could disconnect, the room could be torn
down, players could leave. The code explicitly re-validates its assumptions
after the `await` rather than trusting state captured before it — that
`ctx.rooms.get(roomCode) !== room` check and the re-count of `connectedNames`
are exactly the defensive re-checks a synchronous handler would never need.
**This is the concurrency lesson to be able to state clearly**: in
single-threaded async code, the danger isn't "two threads touch the same
memory," it's "the world moved on while I was awaiting, and I'm about to act
on stale assumptions." The fix is always the same shape: re-read/re-validate
after every `await`, don't just resume as if no time passed.

`room.phase = 'generating'` is set *before* the `await` specifically so that
any socket event arriving during the OpenAI call sees a room mid-generation
(handlers guard on `room.phase !== 'voting'` etc.) and gets rejected rather
than mutating a room that's about to have its state overwritten by the
resumed `finishVoting` call. That phase field is effectively acting as a lock
flag — cheap and sufficient here because there's no true parallelism to guard
against, only reentrancy across an `await`.

### 2.4 Timers are the other source of "concurrent" mutation

`setTimeout` callbacks (the Codenames turn timer in `codenames.js:46-65`, the
10 Seconds force-stop in `tenseconds.js:118-147`) are also just events queued
onto the same single-threaded event loop — they don't run "in parallel" with
socket handlers, they interleave with them the same way two socket events
would. But they're a distinct hazard because they're **not triggered by a
client action** — a timer can fire and mutate room state while a player is
mid-interaction with no message in flight at all. Both timer callbacks
re-validate before acting, same principle as the `await` case:

```js
// server/games/codenames.js:59-65
function cnTimerExpired(ctx, roomCode) {
  const room = ctx.rooms.get(roomCode);
  if (!room || room.game !== 'codenames' || room.phase !== 'playing') return;
  ...
}
```

If the room was already reset to lobby, or the game changed, or the room was
deleted, between when the timer was scheduled and when it fires, this bails
out instead of resurrecting stale state. Every timer handle in this app is
also tracked in a module-local `Map` (`cnTimerHandles`, `tsForceStopHandles`)
specifically so it can be **cancelled** — `clearCnTimerHandle` — whenever the
game state moves on for a legitimate reason (turn ends via a guess, round
resets), preventing a stale timer from firing at all. Uncancelled timers
referencing torn-down state are a classic memory/correctness leak in
long-running Node processes; this codebase is careful about pairing every
`setTimeout` with a `clearTimeout` path.

### 2.5 What this app does *not* have to worry about (and why)

Worth being able to say explicitly, because it shows you understand the
model rather than just pattern-matching "websockets = hard":

- **No multi-threaded data races.** Never a concern in a single Node process,
  by construction. (Would become relevant instantly if this were rewritten
  with `worker_threads` or clustered — see the scaling doc.)
- **No SQL-style transaction isolation problems.** There's no database in the
  hot path; `room` is a plain JS object mutated directly, and every mutation
  is inside one synchronous handler execution. There's nothing analogous to
  "two transactions read-modify-write the same row" because there's no
  read/modify/write round-trip to interleave — it's all in-process memory.
- **No message-ordering problem within a room.** Socket.io delivers events
  from a given client in the order they were sent, and the server processes
  them one handler-to-completion at a time, so "player clicks card A then
  card B" can never be observed by the server as B-then-A.

### 2.6 Where the real risk still lives

Be honest about this if asked "what would you improve":

- Every `await`-crossing function needs its own manual re-validation
  (`ctx.rooms.get(roomCode) !== room`, re-check player counts). This is
  correct today but easy to forget when adding a 5th game with its own async
  call — nothing enforces the pattern, it's convention only.
- The `phase` field doubles as an ad-hoc mutex ("generating" blocks other
  actions) but it's not a formalized lock — a bug that forgets to set
  `room.phase = 'generating'` before an `await` would silently reopen the
  race window. A more explicit `room._locked` flag or a small state-machine
  library would make this invariant harder to violate by accident.
