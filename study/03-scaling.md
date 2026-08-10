# Scaling Shorot

This app was built for "everyone in one physical room playing on their phones."
That use case has a specific shape — small rooms (2-8 players), short sessions
(minutes to an hour), a handful of rooms active at once — and the current
architecture is a genuinely reasonable fit for it. Scaling questions should
start from "what usage pattern are we actually planning for," not "how do we
make this infinitely horizontally scalable," because those have different
answers.

## 1. What the architecture is today (the constraint to design around)

- **One Node.js process.** `server.js` starts one Express + Socket.io server.
- **All room state lives in one in-process `Map`** (`rooms` in
  `server/roomStore.js`) — every active room's players, board state, scores,
  everything, sitting in that process's RAM.
- **Persistence is a snapshot, not a database.** Every 5 seconds
  (`SAVE_INTERVAL_MS` in `server/persistence.js`), the *entire* `rooms` Map is
  serialized to JSON and written to `data/rooms.json` via a temp-file-then-
  rename (safe against partial writes, but still a full-Map dump each time).
  On boot, that file is read back in and rooms are reconstructed
  (`loadRoomsFromDisk`), with each game module getting a chance to repair any
  round that was mid-flight when the process died (`repairOnLoad`).
- **Sockets are pinned to this one process.** A player's WebSocket connection
  is a live TCP connection to this specific process; there's no session
  handoff mechanism to another instance.

This design gets you a lot for free: no database to provision, no network
round-trip on every mutation (it's just a JS object write), trivial local
development, and — per `refactor_plan.md` §9 — it may genuinely be sufficient
for "hundreds of concurrent users," because that's hundreds of people spread
across tens of small rooms, not one giant shared room. The failure modes only
show up under specific kinds of growth, covered below.

## 2. Capacity ladder — what breaks first, and at roughly what scale

### Stage 1 (today): one instance, works fine up to roughly hundreds of concurrent players

Bottlenecks that would actually bite, in the order they'd bite:

1. **A process crash or redeploy loses up to 5 seconds of state and drops
   every open connection.** Every player's phone shows a disconnect; the
   client's `socket.on('connect', ...)` auto-rejoin (see the WebSockets doc)
   will reconnect them once the process is back up, and `repairOnLoad`
   recovers each room to a safe phase — but any game mid-round when the crash
   hit loses that round's granular progress (e.g. Menifot mid-allocation gets
   reset to `ready` for the next round, not resumed — see
   `repairOnLoad` in `server/games/menifot.js:427-441`). For a casual party
   game this is a minor annoyance, not data loss that matters. Deploys today
   are **not** graceful — there's no draining of active rooms before
   `SIGTERM`, only a final `saveRoomsToDisk()` (`server.js:78-83`) so at least
   the *last* snapshot is fresh, not stale by up to 5s.
2. **Ephemeral disks.** `DATA_DIR` — where `rooms.json` and uploaded
   background images live — must point at a persistent volume in production
   (already called out in `CLAUDE.md`). Most container platforms (including a
   plain Railway/Fly/Render deploy without an attached volume) wipe local disk
   on every redeploy. This is the first thing to verify in any real
   deployment, and it's already a documented gotcha here, not a hidden one.
3. **Memory growth is bounded by room count, not player count, and rooms
   never expire.** There is currently no room-reaping logic — a room created
   once stays in the `rooms` Map (and in `rooms.json`) forever, even after
   everyone disconnects, unless the process restarts and nobody ever
   reconnects (it'd still be loaded back into memory from disk on the next
   boot). For a real deployment that runs for weeks, this is a slow, real
   memory leak. This is the single cheapest, highest-value fix available
   before touching anything else — see §4.

### Stage 2: multiple server instances behind a load balancer, same architecture

This is where the current design actively breaks, not just degrades:

- **Socket.io needs sticky sessions** (the load balancer must route a given
  client's every request to the same instance) just to keep one connection
  alive across the polling-fallback handshake — but stickiness alone doesn't
  fix the real problem, which is that **room state itself only exists on the
  instance that created it.** If player A's connection lands on instance 1
  (which owns their room) and player B's lands on instance 2, instance 2 has
  no idea that room exists. There is no cross-instance broadcast — `roomEmit`
  is `io.to(roomCode).emit(...)`, which only reaches sockets connected to
  *that* process.
- Two instances also can't share `data/rooms.json` safely — both writing the
  same file every 5 seconds on independent timers is a straightforward
  data-loss race (last writer wins, silently drops the other instance's
  rooms).

**Conclusion: you cannot horizontally scale this app by just running two
copies of `server.js` behind a load balancer.** That's true whether you're
adding instances for capacity or for zero-downtime deploys — both need this
solved.

### Stage 3: true horizontal scaling — the real fix, and it's a scoped one

Two changes, done together, get you real multi-instance capability:

1. **Socket.io's Redis adapter** (`@socket.io/redis-adapter`) so
   `io.to(roomCode).emit(...)` broadcasts across *all* instances via Redis
   pub/sub, not just the local process's sockets. This alone fixes
   cross-instance broadcast but does nothing for state — you'd still need
   every instance to be able to read/write a given room's data.
2. **Move `rooms` out of process memory into Redis (or a small DB).** Every
   `room.players.get(name)`, `room.cnBoard[index].revealed = true`, etc.
   becomes a read-modify-write against shared storage instead of a local
   object mutation. This is the bigger change, and it's exactly where the
   concurrency guarantees discussed in the concurrency doc **stop being
   free** — see §5.

This is a genuinely separate project from the current codebase, which is why
`refactor_plan.md` explicitly scopes it out (§9) rather than trying to bolt it
on. The right time to do it is when you actually have evidence of Stage-2-scale
demand (multiple regions, need for zero-downtime deploys with live games, or a
single instance visibly CPU/memory-constrained) — not preemptively.

## 3. What *doesn't* need to change for a while

Worth being able to say this out loud in an interview — knowing what *not* to
optimize is as important as knowing what to:

- **CPU is not the bottleneck.** All the game logic (revealing a card,
  tallying votes, evaluating a Menifot hand) is cheap synchronous JS. The only
  slow operations are the OpenAI calls, and those are I/O-bound waits, not CPU
  work — the event loop is free to handle other rooms' events the entire time
  a `fetch` to OpenAI is in flight (see the concurrency doc, §2.3).
- **A single Node process can hold many thousands of concurrent WebSocket
  connections** before connection count itself is the limiting factor — this
  app would hit the "state on one instance" ceiling long before the "too many
  sockets" ceiling.
- **No database is needed at Stage 1 or most of Stage 2.** Introducing
  Postgres/Mongo/etc. before you actually need cross-instance shared state
  would add operational overhead (migrations, connection pooling, query
  latency on every mutation) for no corresponding benefit — Redis is the
  right-sized tool specifically because room state is small, short-lived,
  key-value shaped, and doesn't need relational queries.

## 4. Concrete next steps, ranked by effort-to-value

1. **Room reaping (do this first, cheap, no architecture change).** Track
   `lastActivityAt` per room, sweep periodically, delete rooms with zero
   connected players past some TTL (e.g. 1-2 hours). Fixes the one real
   unbounded-growth bug in the current design.
2. **Confirm `DATA_DIR` is on a persistent volume in whatever host is used.**
   Already documented; just needs verifying at deploy time.
3. **Basic observability before scaling anything.** Right now failures mostly
   surface as `console.error` (e.g. `saveRoomsToDisk`, OpenAI failures). At
   real traffic you'd want structured logs and an error tracker (Sentry or
   similar) so a spike in OpenAI failures or a save-to-disk error doesn't go
   unnoticed. This should come *before* horizontal scaling — you want to see
   the problem you're solving, not guess at it.
4. **Load test to find the actual first bottleneck** before building Stage 3.
   Simulate concurrent rooms with `socket.io-client` scripts and watch memory/
   latency. This turns "we might need Redis" into a measured decision instead
   of speculative engineering — directly in the spirit of `refactor_plan.md`'s
   own philosophy of small, independently-verifiable steps.
5. **If and when Stage 3 is warranted:** Redis adapter + externalized room
   state (§2, Stage 3), likely paired with the room-state namespacing
   refactor `refactor_plan.md` §6/§9 already flags as deliberately deferred —
   namespacing `room.imposter = {...}` / `room.codenames = {...}` instead of
   one flat object would make "serialize this room to Redis" and "which game
   module owns which keys" both cleaner at the same time.

## 5. The concurrency guarantee you'd be giving up at Stage 3

This is worth understanding precisely, because it's the real cost of
horizontal scaling and a strong interview answer if asked "what's the hardest
part of scaling this out":

Today, every synchronous socket handler is atomic for free — see the
concurrency doc §2.2 — because there's exactly one JS thread and state lives
in that thread's memory. The moment room state moves to Redis, a handler like
`guessWord` becomes: **read** the board from Redis, **check** if the cell is
revealed, **mutate** it, **write** it back. Between that read and that write,
another instance handling a different player's simultaneous guess on the same
room can interleave — the free mutual-exclusion guarantee is gone, because two
different processes really can run at the same instant now. Reintroducing
correctness there means either:

- optimistic locking (versioned writes, e.g. Redis `WATCH`/`MULTI` or a
  Lua script that reads-checks-writes atomically server-side in Redis
  itself), or
- routing all mutations for a given room through a single owning
  instance (partition by room, e.g. consistent hashing on `roomCode`), which
  brings back "one process owns this room's writes" — just no longer tied to
  a specific socket connection, so it survives that connection dropping.

Either approach is real, well-trodden distributed-systems work — but it's
exactly the complexity this app avoids today by keeping everything on one
thread, and it's the honest answer to "why not just scale horizontally now":
because it trades a correctness guarantee you currently get for free for one
you'd have to engineer and test.
