# Imposter — Specs

A same-room party word game. Players join a shared room on their phones via one URL; the app's only job is to sync a shared word board and hand out private roles. Everything else (discussion, accusing, voting) happens verbally in person.

## Deployment

- **Repo**: https://github.com/DavidSalmon13/Imposter.git (currently empty)
- **Host**: Railway, connected to the GitHub repo — push to `main` triggers auto-deploy
- **Flow**: build & test locally first, get explicit go-ahead, then commit + push
- **Env**: server must bind to `process.env.PORT` (Railway assigns it); no other env vars needed

## Stack

- Node.js + Express (HTTP server, serves static frontend)
- Socket.io (real-time sync: lobby updates, start, role reveal, reset)
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

1. Server randomly picks one **theme** from: Movies, Animals, Food, Sports, Countries.
2. Server randomly selects **25 words** from that theme's word list → the 5×5 board, shown identically to all players.
3. Server randomly picks **exactly 1 imposter** from the joined players.
4. Server randomly picks **1 secret word** from the 25 board words.
5. Every non-imposter privately receives: the board + "your word: <secret word>".
6. The imposter privately receives: the board + "you are the imposter" (no word).
7. All role delivery is **private per-socket** — no player ever sees another player's role/word.

## Reconnect handling

- Client stores its name in `localStorage` on join.
- On page load/refresh, client silently re-announces its name to the server.
- Server keeps a `name → role` map for the active round and returns the player's existing role on reconnect (does not reassign or leak other players' roles).
- Rationale: players cannot ask each other "what was my role" out loud without breaking the game's secrecy (imposter doesn't know the word; non-imposters can't say the word aloud around the imposter), so silent client-side reconnect is required, not optional.

## Play again

- Once a round has started, a **"New Game" / "Play Again"** button is available.
- Pressing it resets server state back to an **empty lobby** (clears players, roles, board) — everyone rejoins with names fresh, then a new theme/word/imposter is picked on the next Start.

## Word bank

- Hardcoded JSON, ~30 words per theme, 5 themes: Movies, Animals, Food, Sports, Countries.
- Easy to hand-edit later to add themes or words.
- Each round: pick one theme at random, then sample 25 of its words at random for the board.

## UI

- Mobile-first, plain CSS, no framework.
- Clean/styled (not bare-bones default HTML) — centered cards, decent spacing/typography, legible on a phone.
- Screens: Join → Lobby (live player list + Start) → Board/Role (shared 5×5 grid + private role panel) → Play Again resets to Lobby.

## Explicitly out of scope (v1)

- No chat, voting, scoring, or win/lose detection in-app — resolved verbally by the players.
- No room codes / multiple concurrent games.
- No authentication beyond unique display names (trust-based, friends only).
- No persistence beyond server memory (a server restart clears the game).
