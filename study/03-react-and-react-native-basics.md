# React and React Native — the Basics

This app has **no React anywhere** — its frontend is vanilla DOM manipulation
(`public/js/`). That's actually a good teaching setup: every "why does React
work this way" question has a direct, concrete contrast in this repo's own
code. This doc leans on that contrast, then covers React Native specifically,
which has no equivalent in this codebase at all — that part is closer to
memorizing a vocabulary list, so it's kept short and junior-appropriate.

Budget: ~1.5 hours. This is a **junior** round — you need working knowledge
of components, props, state, and the couple of hooks everyone uses, not
performance-tuning or advanced patterns.

---

## 1. The problem React solves (seen through this app's own code)

Look at how this app updates the screen when a vote comes in
(`public/js/games/imposter.js`):

```js
function renderVoting() {
  levelButtons.forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.level === myVote);
  });
}
```

and how it wires up a click:

```js
btn.addEventListener('click', () => {
  const level = btn.dataset.level;
  ctx.socket.emit('vote', level, (res) => {
    if (res && res.ok === false) return;
    myVote = level;        // 1. mutate state by hand
    renderVoting();        // 2. manually call the function that updates the DOM
  });
});
```

This is **imperative** UI programming: *you* are responsible for (1) knowing
which piece of state changed, (2) knowing which DOM elements depend on it,
and (3) calling the right update function, by name, every single place that
state could change. `queryDom()` at the top of that file hand-picks every
element by ID up front; `renderGame`, `renderImposterReporting`,
`renderImposterResults` are all separate, manually-written "sync this state
into these specific DOM nodes" functions. It works, but it doesn't scale:
every new piece of state means writing a new render function and remembering
to call it from every place that state can change.

**React's pitch**: you describe *what the UI should look like for a given
state*, once, as a function of that state — and React figures out which DOM
nodes actually need to change and updates only those, every time state
changes, automatically. You never call a `renderX()` function yourself.

```jsx
function LevelVote({ myVote, onVote }) {
  return (
    <div>
      {['easy', 'medium', 'hard'].map((level) => (
        <button
          key={level}
          className={level === myVote ? 'level-btn selected' : 'level-btn'}
          onClick={() => onVote(level)}
        >
          {level}
        </button>
      ))}
    </div>
  );
}
```

Call `onVote('hard')` and React re-runs this function with the new `myVote`,
diffs the result against what's on screen, and patches only the `className`
that actually changed. No `queryDom()`, no manually-written `renderVoting()`
— the JSX above **is** the render function, and it always runs the same way
regardless of *why* `myVote` changed.

## 2. JSX

JSX (the HTML-looking syntax above) isn't a template language — it's sugar
for plain function calls, transpiled (by Babel) into:

```js
React.createElement('button', { className: '...', onClick: fn }, level)
```

That's it. `{ }` inside JSX drops back into plain JS (`{level === myVote ?
'selected' : ''}`, `{items.map(...)}`) — because it *is* plain JS, just with
a function-call shorthand for building UI trees. Every component must return
**one** root element (or a `<>...</>` fragment).

## 3. Components: props vs. state

This is the single most-asked junior React question, and the contrast with
this codebase's globals makes it concrete:

- **Props** — data passed *into* a component from its parent, read-only from
  the component's own point of view. Analogous to a Java method's
  parameters: the component doesn't own them, doesn't mutate them, just
  reads them. `<LevelVote myVote={myVote} onVote={handleVote} />` — `myVote`
  and `onVote` are `LevelVote`'s props.
- **State** — data a component owns and can change *itself*, which triggers
  a re-render when it does. Declared with the `useState` hook. This is the
  proper, scoped version of what `let myVote = null;` is doing at
  `imposter.js:28` — a module-level global shared by every function in that
  file — except React state is private to one component instance and
  changing it automatically re-runs that component's render, instead of you
  having to remember to call `renderVoting()` yourself.

```jsx
function VotingScreen() {
  const [myVote, setMyVote] = useState(null);   // [currentValue, setterFunction]

  function handleVote(level) {
    socket.emit('vote', level, (res) => {
      if (res?.ok === false) return;
      setMyVote(level);   // triggers a re-render; React calls this component's
                           // function again with the new myVote, and diffs the result
    });
  }

  return <LevelVote myVote={myVote} onVote={handleVote} />;
}
```

**Key rule**: never mutate state directly (`myVote = level` — wrong, React
won't know anything changed). Always call the setter (`setMyVote(level)`) —
that's what schedules the re-render. This is the #1 junior React bug
interviewers expect you to know about.

## 4. `useEffect` — the hook for "do something when X changes"

`useEffect` runs side effects (things that reach outside the render itself:
subscribing to a socket, fetching data, setting a timer) after a render.
It's the React-idiomatic replacement for this app's `init()`/`bindSocket()`
pattern (`imposter.js:190-196`, called once when the module loads) and its
`stop()` cleanup (`imposter.js:217-221`, called when leaving the game):

```jsx
useEffect(() => {
  function handleVotingUpdate({ total, voted }) {
    setVoteCount({ total, voted });
  }
  socket.on('votingUpdate', handleVotingUpdate);

  return () => {
    socket.off('votingUpdate', handleVotingUpdate);   // cleanup — mirrors this app's stop()
  };
}, []);   // empty dependency array = run once on mount, clean up once on unmount
```

The **dependency array** (the `[]` at the end) controls when the effect
re-runs: empty = once; `[roomCode]` = re-run whenever `roomCode` changes;
omitted entirely = re-run after every single render (rarely what you want).
For a junior round, know that the dependency array exists and roughly what
`[]` vs `[someValue]` means — you won't be expected to debug subtle
dependency-array bugs yet.

## 5. Lists and keys

Directly analogous to `.map()` building `<tr>` rows in this app's vanilla
code (`imposter.js:91-98`, manually calling `appendChild` in a loop):

```jsx
{results.map((row) => (
  <tr key={row.name}>
    <td>{row.name}</td>
    <td>{row.role}</td>
  </tr>
))}
```

`key` is required on any list of elements produced by `.map()` — it's how
React tells "this row" apart from "that row" across re-renders (so it can
correctly reorder/add/remove DOM nodes instead of guessing by position). Use
a stable, unique id from your data (never the array index if the list can
reorder or items can be removed — index-as-key is a very common junior
mistake).

## 6. Conditional rendering

Directly analogous to the `role === 'imposter'` branch in `renderGame`
(`imposter.js:63-76`):

```jsx
{role === 'imposter' ? (
  <div className="role-panel imposter">
    <div>YOU ARE THE IMPOSTER</div>
    <div className="hint-text">Hint: {hint}</div>
  </div>
) : (
  <div className="role-panel crew">Your word: {word}</div>
)}
```

`&&` is the common shorthand for "render this, or nothing": `{error && <div
className="error">{error}</div>}` — renders the div only if `error` is
truthy (see fundamentals doc §4 on truthy/falsy — this is exactly why
`error` being `''` vs a real string matters here).

## 7. One-way data flow

Data flows **down** through props; the *only* way a child affects a parent
is by calling a function the parent passed it (a callback prop) — same
principle as this codebase's ack-callback pattern (fundamentals doc §9): the
child never reaches up and mutates the parent's state directly, it calls a
function and lets the owner decide what to do. This is why `onVote` gets
passed down to `LevelVote` in §1 rather than `LevelVote` importing/mutating
`myVote` itself — `myVote`'s owner (`VotingScreen`) is the only thing allowed
to call `setMyVote`.

If asked "how would you share state between sibling components" — the junior
-appropriate answer is **lift state up**: move the state to their common
parent, pass it down as props to both. (Context/Redux are the answers for
"many components, deeply nested" — worth naming if asked, not worth deep
diving for this round.)

---

## 8. React Native — what's actually different from web React

Everything in §1–7 (components, JSX, props, state, hooks, one-way data flow)
is **identical** in React Native — same React, same rules. What changes is
what you render *to*, because there's no browser and no DOM.

| Web React | React Native |
|---|---|
| `<div>` | `<View>` |
| `<span>` / `<p>` (text must be in an element) | `<Text>` (⚠️ **all text must be inside `<Text>`** — unlike the DOM, you can't put a bare string inside a `<View>`) |
| `<img>` | `<Image source={{ uri: ... }} />` |
| `<button>` | `<TouchableOpacity>` / `<Pressable>` (no native clickable button styling to fight) |
| `<input>` | `<TextInput>` |
| scrollable `<div>` | `<ScrollView>` (renders all children) / `<FlatList>` (virtualized — only renders visible rows, essential for long lists) |
| CSS files / `className` | `StyleSheet.create({...})` objects, applied via `style={styles.foo}` — a JS object, not a stylesheet language |
| CSS `display: flex` (opt-in) | **Flexbox by default on every `View`** — but `flexDirection: 'column'` is the *default* (opposite of web's default `row`) |
| click events | touch events (`onPress`, not `onClick`) |
| routing via URLs (React Router) | **React Navigation** — stack/tab/drawer navigators, no URLs |

**Why no `<div>`/DOM at all**: React Native doesn't run in a browser — it
runs your JS on a JS engine (Hermes, typically) on the phone, and React
Native translates your component tree into **real native UI components**
(`UIView` on iOS, `android.view.View` on Android), not HTML. That's the
whole pitch of RN: write once in JS/React, get an actually-native UI, not a
web page wrapped in an app shell (that's what tools like Cordova did, and RN
was built specifically to avoid it).

**Metro** is React Native's bundler (the RN equivalent of what Webpack/Vite
does for web) — it's what transpiles your JSX and ES Modules and serves the
JS bundle to the device/simulator during development, with fast refresh on
save.

**Platform differences**: `Platform.OS === 'ios' | 'android'` lets you branch
logic; file-suffix conventions (`Button.ios.js` / `Button.android.js`)
auto-select per platform at bundle time if you need substantially different
implementations. For a junior round, just know these mechanisms exist — you
won't be expected to have hit real iOS/Android divergence bugs yet.

**Conceptual bridge back to this codebase, if you want a talking point**:
this app already has the "push new state, re-render the affected screen"
mental model baked in — a `socket.on('votingUpdate', ...)` handler receiving
new data and updating the UI is the *exact same shape* as a React component
receiving new props/state and re-rendering, just with a hand-written
`renderVoting()` call instead of it happening automatically. If asked "how
would you rebuild this app's frontend in React," that's a genuinely good
answer: each game screen becomes a component, `socket.on(...)` handlers
become `useEffect` calls with `setState` inside instead of manual DOM
updates, and `showScreen(name)` becomes either simple conditional rendering
or a navigator.

---

## Self-test — answer out loud before moving on

1. What's the difference between props and state?
2. Why can't you just do `myVote = level` to update state in React?
3. What does the dependency array in `useEffect` control? What does `[]`
   mean vs `[roomCode]`?
4. Why does `.map()`-generated JSX need a `key`, and why is array index
   usually a bad choice for it?
5. What is one-way data flow, and how does a child component communicate
   back up to its parent?
6. Name three React Native components and their closest web-React
   equivalent.
7. What's the default `flexDirection` in React Native, and how does that
   differ from CSS on the web?
8. Why doesn't React Native use `<div>`s or render to a DOM at all?
9. What does Metro do?
10. All text in React Native must be wrapped in what component?
