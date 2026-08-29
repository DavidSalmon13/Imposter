# JavaScript, for a Java Developer

You already know OOP, generics, streams, and concurrency — that's most of the
hard conceptual work. JavaScript's *syntax* will look familiar (curly braces,
`if`/`for`, dot notation); what trips Java developers up in interviews is a
short list of places where JS behaves differently on purpose. This doc is that
list, each one anchored to a real line in this codebase so you have a concrete
example to point to instead of reciting a definition.

Read this after skimming `01-study-guide.md`. Budget: ~1.5–2 hours.

---

## 1. Variables: `var` / `let` / `const`

Java has one kind of local variable. JS has three keywords, and the
distinction is a classic interview question.

- **`var`** — function-scoped (not block-scoped) and *hoisted*: the
  declaration is moved to the top of its function, so it exists (as
  `undefined`) even before the line that declares it runs. Legacy; avoid it.
- **`let`** — block-scoped, like a Java local variable. Can be reassigned.
- **`const`** — block-scoped, cannot be *reassigned*. This codebase uses
  `const` by default everywhere (`server/roomStore.js:5`: `const rooms = new
  Map();`) and only reaches for `let` when a variable is genuinely rebound
  (`public/js/games/imposter.js:28`: `let myVote = null;`, later reassigned in
  `renderVoting`'s callers).

**The gotcha to say out loud**: `const` does **not** mean immutable — it means
*this binding* can't be reassigned to point at a different value. The value
itself (if it's an object or array) is still fully mutable:

```js
const rooms = new Map();      // roomStore.js:5
rooms.set('ABCD', {...});     // legal — mutating the Map's contents, not reassigning `rooms`
rooms = new Map();            // ILLEGAL — TypeError, can't reassign a const
```

Same idea shows up constantly in this codebase: `room.phase = 'generating'`
(`server/games/imposter.js:136`) mutates a field on an object that was
probably declared `const room = ...` somewhere up the call stack. Java
developers reach for this instinctively (it's exactly like a `final`
reference to a mutable object), so this one usually isn't the hard part —
just have the vocabulary ready.

## 2. Dynamic typing, and `==` vs `===`

JS has no compile-time type checking — a variable can hold a string, then a
number, then an object, with no error. This makes `==` dangerous: it performs
**type coercion** before comparing (`'5' == 5` is `true`), which produces
surprising results. `===` (**strict equality**) compares value *and* type with
no coercion, and is what you should default to everywhere.

**Rule to state in an interview**: always use `===`/`!==` unless you have a
specific, deliberate reason for `==`. This codebase follows that convention
throughout — grep any game module and you won't find a bare `==`.

## 3. `null` vs `undefined`

Java has one absence value: `null`. JS has two:

- **`undefined`** — a variable was declared but never assigned, a function
  parameter wasn't passed, or a property doesn't exist on an object at all.
  It's what JS gives you by default.
- **`null`** — an *intentional*, explicit "no value," assigned by code.

This codebase uses `null` deliberately as a real state value — e.g.
`server/roomStore.js:22`: `hostName: null` (no host yet, will be set), or
`imposter.js:176`: `p.word = null` (the imposter is never given the word — see
`04-websockets-and-concurrency.md` §1.3 for why). `undefined` shows up mostly
as "this key was never set" — e.g. `p.eliminatedReport` checks
(`p.eliminatedReport === null || p.eliminatedReport === undefined`,
`imposter.js:218`) have to check **both**, because depending on how the object
was built, an unanswered report could be either.

Two loose-equality tricks worth knowing (interviewers like asking these):
- `null == undefined` is `true` (the *only* thing `==` is reliably useful
  for), but `null === undefined` is `false`.
- Optional chaining `?.` and nullish coalescing `??` (both ES2020+) short-
  circuit past `null`/`undefined` specifically — `a?.b` returns `undefined`
  instead of throwing if `a` is `null`/`undefined`, and `a ?? 'default'` gives
  `'default'` only if `a` is `null`/`undefined` (unlike `||`, which also
  triggers on `0`, `''`, `false`).

## 4. Truthy / falsy

Every value in JS is truthy or falsy when used where a boolean is expected
(`if (x)`, `x && y`). The **only** falsy values: `false`, `0`, `''` (empty
string), `null`, `undefined`, `NaN`. Everything else — including `'0'`
(non-empty string!), `[]`, and `{}` — is truthy. This is why
`if (!word || !hint)` in `imposter.js:112` correctly catches both `null` and
`''` in one check: an empty string is falsy, so `!word` is `true` for both a
missing word and an empty-string word.

## 5. Objects and `Map` — and why this codebase uses both

A plain JS object (`{ key: value }`) is the rough equivalent of a Java
`HashMap<String, Object>` with no fixed schema — you'll use these constantly
as ad-hoc structs (`{ ok: true, error: 'Invalid level' }`,
`imposter.js:423`). JS also has a real `Map` class (`new Map()`) that behaves
more like Java's `HashMap<K, V>`: any key type (not just strings), a real
`.size`, guaranteed iteration order, and no accidental collisions with
inherited-property names.

This codebase picks deliberately: `room.players` is a real `Map` (`name ->
player object`, `server/roomStore.js:23`) because it's genuinely a key→value
lookup that's mutated and iterated a lot, while individual player/room
records are plain objects because they're closer to fixed-shape structs (like
a Java class with public fields, minus the type declarations). If you're
asked "why not just use an object for `players` too" — the honest answer is
plain objects can accidentally collide with inherited keys like
`hasOwnProperty`, and `Map.prototype.size`/`.keys()`/`.values()` are just
nicer ergonomics for something this mutation-heavy.

## 6. Arrays and the "streams" methods

This is the most direct mapping to something you already know well. JS array
methods are Java Streams, minus the `.stream()`/`.collect()` ceremony —
they operate directly on the array and (mostly) return a new array.

| JS | Java Streams equivalent |
|---|---|
| `arr.map(x => x * 2)` | `.stream().map(x -> x * 2).collect(toList())` |
| `arr.filter(x => x > 5)` | `.stream().filter(x -> x > 5).collect(toList())` |
| `arr.reduce((acc, x) => acc + x, 0)` | `.stream().reduce(0, Integer::sum)` |
| `arr.find(x => x.id === 3)` | `.stream().filter(...).findFirst().orElse(null)` |
| `arr.some(x => x > 5)` | `.stream().anyMatch(...)` |
| `arr.every(x => x > 5)` | `.stream().allMatch(...)` |
| `arr.forEach(x => ...)` | `.forEach(x -> ...)` |
| `arr.includes(x)` | `.stream().anyMatch(y -> y.equals(x))` / `list.contains(x)` |

Real example from this codebase (`server/games/imposter.js:82-84`):

```js
const maxCount = Math.max(...LEVELS.map((l) => counts[l]));
return LEVELS.find((l) => counts[l] === maxCount);
```

`.map()` transforms each level name into its vote count; `.find()` returns
the first level whose count matches the max — i.e. "which difficulty won the
vote." One important difference from Java Streams: **JS array methods are
eager, not lazy** — `.map()` fully builds the intermediate array before
`.find()` runs, there's no fused single-pass execution the way a Stream
pipeline can do. For array sizes like this app's (a handful of players), that
difference never matters in practice — just know it if asked.

## 7. Functions, arrow functions, and `this`

Java has methods; every method's `this` is unambiguous — whichever object
it's called on. JS has **four** ways to write a function, and — more
importantly — `this` is decided differently for each. For a junior interview,
you mainly need: regular functions vs **arrow functions**, and why arrow
functions won over regular functions for callbacks.

```js
function add(a, b) { return a + b; }   // function declaration
const add2 = function (a, b) { return a + b; };  // function expression
const add3 = (a, b) => a + b;          // arrow function (implicit return)
const add4 = (a, b) => { return a + b; };        // arrow function (block body)
```

Arrow functions **don't have their own `this`** — they inherit it from
wherever they're defined (lexical scoping), unlike regular functions, whose
`this` depends on *how they're called*. This matters most inside callbacks:
before arrow functions existed, `this` inside a `setTimeout` or event-listener
callback silently became something else (`window`, `undefined` in strict
mode), forcing workarounds like `const self = this`. Arrow functions make
that whole class of bug disappear, which is exactly why this codebase uses
them for essentially every callback — every `.map()`/`.filter()` predicate,
every `socket.on(...)` handler, every `addEventListener` callback:

```js
// public/js/games/imposter.js:103-112
levelButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const level = btn.dataset.level;
    ctx.socket.emit('vote', level, (res) => { ... });
  });
});
```

Three arrow functions nested here, none of which need to think about `this`
at all — a `this`-based bug simply isn't possible in this style of code. If
you're asked "when would you still use a regular `function`?" — a fair
answer: object methods that need to reference the calling object via `this`,
or when you specifically need `arguments` (arrow functions don't have their
own `arguments` object either).

## 8. Closures

This is the one JS concept with no clean one-line Java equivalent (the
closest is a lambda or anonymous inner class capturing an effectively-final
local variable — same underlying idea, much more ceremony in Java).

**A closure is a function that "remembers" the variables from the scope it
was created in, even after that outer scope has finished running.**

Every client-side game module in this codebase is a closure in disguise.
Look at the top of `public/js/games/imposter.js`:

```js
let ctx = null;
let myVote = null;
let pendingLevel = null;
// ...

export const Imposter = {
  init(gameCtx) { ctx = gameCtx; /* ... */ },
  applyJoin(res) { /* reads ctx, myVote */ },
  stop() { myVote = null; pendingLevel = null; },
};
```

`ctx`, `myVote`, and `pendingLevel` are module-level variables — every
function defined in this file (`renderVoting`, `bindButtons`, `bindSocket`,
the exported `Imposter` object's methods) forms a closure over them. That's
what lets `bindButtons`'s click handler set `myVote` and have `renderVoting`
(called from somewhere else entirely, later, in response to a socket event)
see the updated value — they're not passing it as a parameter, they're both
closing over the same variable. This is the plain-JS-module version of what a
class's private instance fields give you in Java, without needing a class at
all.

**Classic interview closure question** — what does this print?

```js
for (var i = 0; i < 3; i++) {
  setTimeout(() => console.log(i), 0);
}
// prints: 3, 3, 3
```

```js
for (let i = 0; i < 3; i++) {
  setTimeout(() => console.log(i), 0);
}
// prints: 0, 1, 2
```

`var` is function-scoped, so there's exactly **one** `i` shared by every
closure created in the loop — by the time the timeouts fire, the loop has
finished and `i` is `3`. `let` is block-scoped, so **each iteration gets its
own fresh binding** of `i`, and each closure captures its own copy. This is a
genuinely common junior-level "explain closures" question — know it cold.

## 9. Callbacks

A callback is just a function passed as an argument to be called later —
Java has the same idea via functional interfaces (`Runnable`, `Consumer<T>`,
a lambda passed to `.thenApply(...)`), just with more type ceremony. This app
uses callbacks constantly for one specific reason: **Socket.io's
acknowledgement pattern**, which gives you a request/response result on top
of an event-based transport:

```js
// server/games/imposter.js:415-433
socket.on('vote', (level, callback) => {
  callback = callback || (() => {});
  // ...validate...
  if (!LEVELS.includes(level)) return callback({ ok: false, error: 'Invalid level' });
  // ...mutate state...
  callback({ ok: true });
  broadcastVoting(ctx, roomCode, room);
});
```

`callback` is the last argument the client passed to `socket.emit('vote',
level, callback)` — the server calls it exactly once to report whether *this
specific caller's* action succeeded, separately from the broadcast that tells
the whole room the state changed. `callback = callback || (() => {})` is a
defensive default: if a caller emits without a callback, calling `callback()`
still doesn't throw. See `04-websockets-and-concurrency.md` §1.4 for the full
request/response-vs-broadcast reasoning — that's genuinely interview-worthy
architecture, not just JS trivia.

## 10. Promises and `async`/`await`

Java concurrency is thread-based: blocking calls, thread pools, `Future`/
`CompletableFuture` for async composition. **Node.js is single-threaded** and
has no blocking I/O at all in the way Java does — every I/O operation (a
network call, a file read) is asynchronous by construction, and the mechanism
for that is the **Promise**.

A `Promise` represents a value that isn't ready yet, but will be (or will
fail) at some point. `async`/`await` (ES2017) is syntax sugar that lets you
write asynchronous code that *reads* like synchronous code, instead of
chaining `.then()` callbacks:

```js
// server/games/imposter.js:86-120 (trimmed)
async function generateWordAndHint(room, level) {
  // ... build a prompt string ...
  const parsed = await chatCompletionJson(prompt, { temperature: 1.2 });  // <- pauses here
  const word = String(parsed.word || '').trim();
  // ...
  return { word, hint };
}
```

`chatCompletionJson` returns a `Promise` (it calls OpenAI's API over the
network). `await` pauses *this function* until that Promise resolves — but
critically, it does **not** block the whole process the way a blocking Java
network call would block a thread. While this `await` is pending, Node's
single thread is free to handle other players' socket events, other rooms
entirely, timers, anything else queued up. This is the direct JS analogue of
`CompletableFuture.thenApply` chains, but without needing an executor or a
thread pool — there's only ever one thread, and `await` is where it's
allowed to go do something else for a while.

**The one real gotcha, and it's an excellent interview answer if asked "what
would you watch out for with async code here":** the world can change while
you're awaiting. `finishVoting` (`imposter.js:133-153`) re-checks that the
room still exists *after* the `await` finishes, specifically because a
network call might take hundreds of milliseconds — plenty of time for players
to disconnect or the room to be torn down while you were waiting:

```js
({ word, hint } = await generateWordAndHint(room, level));
// Room may have been deleted while awaiting OpenAI.
if (!ctx.rooms.has(roomCode) || ctx.rooms.get(roomCode) !== room) return;
```

Full depth on this (including how it relates to Node's single-threaded event
loop) is in `04-websockets-and-concurrency.md` §2.3 — read that section once
you're comfortable with the syntax here.

**A promise you should be able to state without looking it up**: `try`/
`catch` works directly around `await` — no separate `.catch()` chain needed:

```js
try {
  ({ word, hint } = await generateWordAndHint(room, level));
} catch (err) {
  console.error('generateWordAndHint failed:', err.message);
  // handle the failure
}
```

## 11. Destructuring, spread, and template literals

Three syntax features you'll see on nearly every line of this codebase and
should be fluent reading (even if you don't write them fluently yet).

**Destructuring** — pull values out of an object or array by name/position in
one statement:

```js
// public/js/games/imposter.js:150
const { socket, showScreen, setHost } = ctx;
// equivalent to: const socket = ctx.socket; const showScreen = ctx.showScreen; ...

socket.on('votingStarted', ({ host }) => { ... });
// destructures the event payload's `host` field directly in the parameter list
```

**Spread (`...`)** — expand an array/object's elements in place:

```js
// server/games/imposter.js:82
const maxCount = Math.max(...LEVELS.map((l) => counts[l]));
// LEVELS.map(...) returns an array; Math.max needs individual arguments, not an array —
// spread expands the array into separate arguments.
```

**Template literals** (backticks) — string interpolation, replacing Java's
`String.format`/concatenation:

```js
// public/js/games/imposter.js:61
levelLabel.textContent = level ? `Difficulty: ${level}` : '';
```

## 12. Modules: this repo actually uses both systems

JS has two competing module systems, and this codebase is a genuinely useful
example because it uses **both**, split cleanly by folder:

- **`server/` — CommonJS** (Node's original module system):
  ```js
  // server/games/imposter.js
  const { shuffle } = require('../lib/shuffle');
  // ...
  module.exports = { id: 'imposter', /* ... */ };
  ```
- **`public/js/` — ES Modules** (the modern standard, works in browsers
  natively):
  ```js
  // public/js/games/imposter.js
  import { renderScoreboard } from '../shared/scoreboard.js';
  // ...
  export const Imposter = { /* ... */ };
  ```

If asked the difference: CommonJS `require()` calls are synchronous and can
happen anywhere in a file (even conditionally); ES Module `import`s are
static — resolved and hoisted to the top before any code runs, which is what
lets bundlers/browsers do tree-shaking and know the full dependency graph
without executing anything. **React Native uses ES Module `import`/`export`
syntax** (transpiled by Metro/Babel under the hood) — so the `public/js/`
half of this codebase is the syntax you'll actually be writing at Moveo, not
the `server/` half.

## 13. Classes — and why this codebase mostly avoids them

JS does have `class` syntax (ES6+), and it looks reassuringly Java-like:

```js
class Player {
  constructor(name) {
    this.name = name;
    this.connected = true;
  }
  disconnect() {
    this.connected = false;
  }
}
```

Under the hood it's sugar over JS's actual object model, **prototypal
inheritance** — every object has a hidden link to a "prototype" object it
falls back to for property lookups, rather than Java's class-based
inheritance. You don't need prototype internals for a junior round, but know
that `class` is not JS's primary way of organizing code the way it is in
Java. This codebase's dominant pattern instead is **plain objects with
function properties, built via closures** (see §8) — every game module
exports a plain object (`module.exports = { id, onChoose, registerHandlers,
... }`) rather than a class instance. That's idiomatic Node: prefer functions
and plain data over classes unless you specifically need
multiple-instances-with-shared-behavior. You'll see the opposite bias in
React: modern React is almost entirely **function components**, not classes
either (see next doc) — so the "reach for a class" instinct from Java is one
you'll want to consciously suppress in both halves of the JS world.

---

## Self-test — answer out loud before moving on

1. What's the difference between `let` and `const`? Does `const` make an
   object immutable?
2. Why does `null == undefined` return `true` but `null === undefined`
   return `false`?
3. Name three falsy values besides `false`.
4. What does `.map()` return? Does it mutate the original array?
5. Why do arrow functions not have their own `this`? Give an example of a bug
   that causes.
6. What is a closure, in one sentence? Point to one in this codebase.
7. What does `await` actually do, given that Node is single-threaded and
   can't block?
8. What's the difference between CommonJS and ES Modules? Which one does
   React Native use?
9. Destructure `{ a: 1, b: 2 }` into two variables in one line.
10. What's wrong with `for (var i = 0; ...) { setTimeout(() => use(i)) }`, and
    how does `let` fix it?
