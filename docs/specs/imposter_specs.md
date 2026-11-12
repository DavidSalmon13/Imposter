# Imposter — Specs

A same-room party word game. Players join a shared room on their phones via one URL; the app's only job is to vote on a hint difficulty, ask ChatGPT for a secret word + hint, and hand out private roles. Everything else (discussion, accusing, voting on who's the imposter) happens verbally in person.

## Deployment

- **Repo**: https://github.com/DavidSalmon13/shorot
- **Host**: Railway, connected to the GitHub repo — push to `main` triggers auto-deploy
- **Flow**: build & test locally first, get explicit go-ahead, then commit + push
- **Env**: server must bind to `process.env.PORT` (Railway assigns it). Also requires `OPENAI_API_KEY` (and optionally `OPENAI_MODEL`, default `gpt-4o-mini`) — set locally via `.env` (see `.env.example`, loaded with `dotenv`) and in Railway's dashboard for production.

## Stack

- Node.js + Express (HTTP server, serves static frontend)
- Socket.io (real-time sync: lobby updates, voting, generating, role reveal, reset)
- OpenAI Chat Completions API (`fetch`, no SDK dependency) to generate the secret word + hint each round
- Plain HTML/CSS/vanilla JS on the client — no framework, no build step
- No database — all state lives in server memory (single process, single room)

## Room model

- **Single fixed room**, app-wide. No room codes. The base URL *is* the game.
- Only one game can be "in progress" at a time across the whole deployment.

## Join / Lobby

- Player opens the URL → enters a **display name**.
- Names must be **unique** while the room is active (server rejects duplicates — this also protects role privacy on reconnect, see below).
- Lobby screen lists all currently-joined names live (via Socket.io) as people join.
- **Minimum 3 players** required before Start is enabled.
- **No host role** — any joined player can press **Start**.

## Round setup (on Start)

1. Host presses **Start** (still requires **minimum 3 players**) → phase moves to **voting**, not straight into a round.
2. Every joined player picks a hint difficulty: **easy / medium / hard**. Most votes wins; a **tie is resolved in favor of the easier level** (easy > medium > hard on ties).
3. Once everyone connected has voted, the server asks **ChatGPT** (OpenAI Chat Completions) for one common word plus a single short hint sentence calibrated to the winning difficulty. The server rejects/retries if the hint would leak the word.
4. Server randomly picks the imposter(s): **1 imposter** for 3-4 players, **2 imposters** for 5+ players. The same player(s) can't be the imposter again on the very next round (unless the player pool is too small to avoid it).
5. Every non-imposter privately receives: "your word: <secret word>" (no hint).
6. Each imposter privately receives: the same one hint sentence (no word, no word grid). Imposters do not know who the other imposter is.
7. All role delivery is **private per-socket** — no player ever sees another player's role/word/hint.
8. If the OpenAI call fails, the round is aborted, votes are cleared, everyone returns to the lobby, and the host can press Start again.

## Reconnect handling

- Client stores its name in `localStorage` on join.
- On page load/refresh, client silently re-announces its name to the server.
- Server keeps a `name → role` map for the active round and returns the player's existing role on reconnect (does not reassign or leak other players' roles).
- Rationale: players cannot ask each other "what was my role" out loud without breaking the game's secrecy (imposter doesn't know the word; non-imposters can't say the word aloud around the imposter), so silent client-side reconnect is required, not optional.

## Play again

- Once a round has started, a **"New Game" / "Play Again"** button is available.
- Pressing it resets server state back to an **empty lobby** (clears players, roles, board) — everyone rejoins with names fresh, then a new theme/word/imposter is picked on the next Start.

## Word source

- No local word bank — each round's word + hint is generated live by ChatGPT.
- Server keeps a rolling list of the last ~50 used words (in memory) and asks the model to avoid repeating them.

## UI

- Mobile-first, plain CSS, no framework.
- Clean/styled (not bare-bones default HTML) — centered cards, decent spacing/typography, legible on a phone.
- Screens: Join → Lobby (live player list + Start) → Voting (difficulty choice, live vote count) → Generating (waiting on ChatGPT) → Role panel (word for crew, hint for imposter) → Play Again resets to Lobby.

## Explicitly out of scope (v1)

- No chat, voting, scoring, or win/lose detection in-app — resolved verbally by the players.
- No room codes / multiple concurrent games.
- No authentication beyond unique display names (trust-based, friends only).
- No persistence beyond server memory (a server restart clears the game).
