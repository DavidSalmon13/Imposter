# Strategy (working title) — Specs

A same-room, turn-based strategy game. Players split into two (or more) teams, or play 1v1. Each team has a **base**; each player controls a **character** (a commander leading an army) picked from a shared character list, and every character has its own strengths. Every turn all players secretly pick their actions at the same time; when everyone has ended the turn, all actions resolve together and everyone sees what happened. A team wins by destroying the other team's base.

The core of the game is **reading the opponent**: you never see what the other team chose until the turn resolves, so every decision is a guess about what they will do.

> **Status:** this spec fixes the framework (teams, bases, characters, armies, hidden simultaneous turns, the reveal, winning, and how it fits the app). The **gameplay itself is deliberately left open**: the exact actions, the map, unit types, the character roster, numbers and balance. See [Open gameplay design](#open-gameplay-design). Sections marked *open* should be decided (and this spec updated) before implementation starts.

## Relationship to the other games / shared app changes

- Added as a new option on the "Choose a game" screen, using the same `chooseGame` socket event pattern (`room.game = 'strategy'`; final id follows the final name).
- Implemented as one new module under `server/games/` implementing the standard game contract (`id`, `minPlayers`/`maxPlayers`, `onChoose`, `registerHandlers`, `reconnectPayload`, `onDisconnect`, `savedFields`, plus `clearState`/`repairOnLoad` as needed), and one line in `gameRegistry.js`'s `GAMES` map. Client module at `public/js/games/strategy.js` exporting `init` / `applyState` / `stop`.
- Reuses the shared lobby, host concept, room-code model, scoreboard, and the "Back to Lobby" reset pattern (clears only this game's state, keeps the roster).
- Mid-game joins are blocked like every other game: "Game in progress, wait for the next round."
- No external API calls needed.
- All game fields live at the top level of room state with a game prefix (e.g. `stTeams`, `stBases`, `stTurn`, `stPendingActions`), matching the existing flat, prefixed convention.

## Phases

```
lobby (shared) → team-select → character-select → planning ⇄ resolving → gameover
```

- **team-select**: players join teams; host presses Start once teams are valid (see [Teams](#teams)).
- **character-select**: each player picks a character from the list. Whether two players can pick the same character (same team / opposing teams) is *open*.
- **planning**: every player secretly chooses their action(s) for this turn and presses **End Turn**. A turn timer is shown to everyone.
- **resolving**: the server resolves every action at once and broadcasts the results. Every phone plays the turn's **reveal**, one step at a time. Then the game returns to **planning** for the next turn, or goes to **gameover**.
- **gameover**: winning team shown, plus a short summary of the game. "Play Again" (host-only, same teams; character-select again) or "Back to Lobby" (host-only).

## Teams

- **2 teams** by default (e.g. Red / Blue). Support for **3+ teams** (free-for-all between teams) is a goal of the design; whether it ships in v1 is *open*.
- **1v1** is a valid setup: two teams of one player each.
- Players self-assign to a team on a live-updating team-select screen (same pattern as Codenames), and the host can press **Random Teams** to shuffle (sizes differ by at most one).
- Every team needs at least 1 connected player. Uneven teams (e.g. 3v2) are allowed. How the game compensates the smaller team is *open*.
- Minimum players: **2**. Maximum: *open* (bounded by how readable the board is on a phone).

## The fixed building blocks

These are the pillars of the game. Their existence is fixed; their details are *open*.

### Base

- Each team has exactly **one base**, shared by all players on that team.
- A base has **health**. Health is visible to everyone at all times.
- When a team's base is destroyed (health reaches 0), that team is **out**.
- Whether a base can be defended, repaired or upgraded (e.g. defence towers, walls), and how, is *open*.

### Characters (commanders)

- Each player controls **one character**, chosen from a shared **character list**.
- Every character has its **own strengths** (and, ideally, weaknesses), so the choice changes how that player plays. In a team, characters are meant to complement each other.
- How a character's strengths are expressed is *open* (e.g. a passive bonus, a special ability with a cooldown, a different starting army, cheaper or exclusive actions).
- The roster itself (names, theme, number of characters) is *open*.

### Army

- Each player's character leads an **army** that acts on the board for them: it attacks, defends, and is what actually damages the enemy base.
- Armies can be lost in battle and grown again.
- What an army is made of (one blob with a strength number vs. distinct unit types with counters) and how it is grown is *open*.

### Power / strength

- Battles are decided by comparing the **power** of the forces involved, adjusted by character strengths, defences and any counters.
- The combat formula is *open*.

### Resources

- Whether there is an economy (gold, energy, etc.) that limits what a player can do each turn, and whether it is per player or shared per team, is *open*.

## Turn structure (fixed)

1. **Planning.** Every player sees the current public board state and chooses their action(s) for this turn. Typical actions are attacking, defending, building (e.g. another defence tower), growing the army, or using a character's strength. The actual action list is *open*.
2. **End Turn.** A player presses **End Turn** to lock in. They can change their choice until they lock in; whether they can unlock again before the turn resolves is *open*.
3. **Resolution.** When **every** active player has locked in (or the turn timer runs out), the server resolves **all** actions from all teams **simultaneously**, using a fixed resolution order that is known to all players. The resolution order is *open*.
4. **Reveal.** All phones show what happened, as a sequence of events, e.g. "Red sent their army to attack the left side… Blue built a defence tower on the left… the attack was stopped." The reveal should be dramatic and readable, since it is the payoff of every turn.
5. **Next turn**, unless a base was destroyed.

### Turn timer

- Every planning phase has a timer so the game keeps moving at party pace. Exact length is *open* (suggested range 30–60s), possibly host-configurable.
- A player who has not locked in when the timer runs out gets a **default action** (a safe "do nothing / hold" equivalent; exact choice *open*).

## Hidden information (fixed)

- **Choices are secret until resolution.** No player ever sees an opposing player's chosen action before the turn resolves. The server holds pending actions and **never sends them to any client** before resolution. Clients only receive "player X has locked in: yes/no", so nobody can cheat by reading another phone's network traffic.
- **Teammates can see each other.** Players see their own teammates' current choices (and locked-in state) during planning, so a team can coordinate without saying everything out loud in front of the other team. Talking out loud is still allowed, and bluffing is part of the game.
- **Quick team pings** (e.g. "I'm attacking", "defend!") visible only to teammates: in scope, exact set *open*.
- How much of the **board** is public is *open*: e.g. whether enemy army size and defences are fully visible or partly hidden ("fog of war"), and whether some characters can scout.

## Winning

- A team wins when it is the **last team with a base standing**.
- If several bases are destroyed in the same turn and no team is left standing, the result is a **draw** (or decided by a tiebreak; *open*).
- **Game length must be bounded.** Games should end in roughly 10–20 minutes, so the design must stop endless defensive play (e.g. a turn cap, "sudden death" damage after turn N, or something else; mechanism *open*).

## Disconnect handling

- **During planning**: a disconnected player is not waited on. If they haven't locked in when everyone else has (or the timer ends), they get the default action. On reconnect they rejoin the current turn with full state (`reconnectPayload`), including their own pending choice if they had made one.
- **During reveal**: reconnecting players get the current board state and the latest turn's event list.
- **A whole team disconnected**: their base stays on the board and they keep receiving default actions; the game is not ended automatically. The host can end the game from the gameover / Back to Lobby controls.
- **Host-only start gate**: Start is disabled on team-select while any team has no connected player.
- Mid-game state (board, bases, armies, pending actions, turn number) is part of `savedFields`, so a server restart resumes the game at the start of the current planning phase.

## Scoring (shared scoreboard)

| Outcome | Points |
|---|---|
| Player on the winning team | **+2** |
| Player on a losing team | **0** |
| Draw | **0** for everyone |

(Same values as Codenames; can be revisited once the game is playtested. To be added to `specs/scoreboard-specs.md` when implemented.)

## Implementation notes

- **Pure resolver.** All turn logic should live in one pure function, e.g. `resolveTurn(state, actionsByPlayer) → { state, events }`, with no sockets, timers or randomness it doesn't receive as input. The socket handlers only collect actions, call it, save, and broadcast. Benefits:
  - the rules are unit-testable in `tests/games/` without any timer mocking;
  - the client only animates the `events` list, so the reveal and the rules can't drift apart;
  - balance can be checked with a small script that plays thousands of bot-vs-bot games.
- **Events list.** `events` is an ordered list of small, renderable facts (e.g. `{ type: 'attack', player, target, ... }`, `{ type: 'baseDamage', team, amount }`), designed so a client can show them one at a time.
- **Phone-first UI.** The whole board must be readable on one phone screen without scrolling sideways. This is a hard constraint on whatever map is chosen.

## Open gameplay design

The following are intentionally undecided. Each should be settled (and this spec updated) before implementation, ideally after a quick paper playtest.

1. **The map / board.** Options discussed: three lanes with a tug-of-war front line (Clash Royale style); a single front with left/right/center sides; a small grid; no map at all (bases and armies only).
2. **Action list.** What can a player do in a turn, and how many actions per turn (one action, or action points)? Candidates: attack (where / whom), defend, build defences, grow army, gather resources, move, scout, character ability.
3. **Army model.** One army with a power number, or distinct unit types with a counter system (e.g. infantry > archers > cavalry > infantry, siege vs. buildings)?
4. **Characters.** Roster, theme, and how strengths work. Ideas so far: Engineer (cheap defences), Warlord (stronger attacks), Merchant (more resources), Spy (sees more of the enemy), Saboteur (damages defences), Priest (repairs the base).
5. **Combat formula and resolution order.** What happens when an attack meets a defence, when two attacks cross, and in what order actions apply.
6. **Economy.** Whether there are resources at all; per player or shared per team.
7. **Information.** Fully visible board vs. fog of war; what scouting reveals.
8. **Balance mechanics.** Stopping snowballing (comeback help for the losing team), turtling, and compensating uneven teams.
9. **Game-length cap.** Turn limit, sudden death, or something else.
10. **3+ teams.** In v1 or later, and how attacks pick a target team.
11. **Theme and final name.**
