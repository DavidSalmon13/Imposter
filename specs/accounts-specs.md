# Accounts, Player Card, Badges & Rivalries — Specs

Cross-game feature that remembers players across nights and devices. Everyone plays as
a guest exactly as before; every finished game is recorded; signing in with Google
keeps that history forever. On top of the history: a Player Card, badges that unlock
stickers, and head-to-head rivalries.

Design, rollout and rollback: [`plans/accounts-plan.md`](../plans/accounts-plan.md).

## Relationship to the rest of the app

- **Optional.** Needs `DATABASE_URL` (Postgres). Without it, or with the database down,
  the app behaves exactly as before: nothing recorded, no card, all stickers free.
  Sign-in and the card additionally need `GOOGLE_CLIENT_ID`.
- **Joining never changes.** No sign-up wall. Name, optional sticker, play.
- **The room scoreboard is unchanged** ([`scoreboard-specs.md`](scoreboard-specs.md)).
  It's still per room, name-keyed and resettable. Lifetime stats are a separate,
  permanent record.
- **Never blocks a game.** Results are saved after the round ends. A failed save loses
  only that record; the game carries on.

## Identity

- **Device**: each browser has a random ID saved in it. Games played on it are recorded
  against it, signed in or not ("guest history").
- **Account**: created on first "Continue with Google" and recognized by Google's
  permanent account ID (not the email). Each device the player signs in on is linked
  to the account, and that device's guest history joins the account.
- A device already linked to one account is never moved to another. Signing in can
  never pull someone else's stats.
- Staying signed in: a login cookie lasting 180 days. After that, tap "Continue with
  Google" again.
- Names are not identities. Players can use any name each night; stats follow the
  device or account.

## What gets recorded

One record per finished round or match, at the moment the game awards scoreboard points,
for every participant still known to the room:

| Game | Counts as a win when | Also saved |
|---|---|---|
| Imposter | You weren't eliminated (either role) | Role, eliminated or not |
| Codenames | Your team won | Spymaster or operative, team |
| 10 Seconds | You were the champion | Finishing place |
| Menifot | You reached the target score | Final score, place |
| Music Timeline | Your team reached the target | Team, cards collected |
| Mind Meld | You finished first (ties share it) | Match score, place |
| All-In or Fold | You finished with the top net profit (ties share it) | Net profit, total bought in |
| Bluff | You were the last player standing | Place |

Points recorded are exactly the scoreboard points from that game. Rounds abandoned with
"Back to Lobby" before a result are not recorded.

## Player Card (lobby 👤 button)

Shown only when sign-in is available. Opens a drop-down in the lobby:

- **Guest**: "On this device: N games · W wins · P pts", per-game rows, rivals, badges,
  then "Sign in with Google to keep your stats forever, on any device" with a
  **Continue with Google** button.
- **Signed in**: Google name and photo, lifetime totals across all linked devices,
  per-game rows ("2/5 won"), rivals, badges, **Sign out**, and a small red
  **Delete my account** link.
- Refreshes whenever it's opened, on returning to the lobby, and after earning a badge.

## Badges

14 badges. Each is earned once, permanently, the first time your history meets its
rule. History includes games from before the badge existed, so new badges can be
awarded retroactively on your next game or sign-in.

| Badge | How to earn it | Sticker |
|---|---|---|
| Welcome! | Finish your first game | `10ba2cfe…` raising a drink |
| On Fire | Win 3 games in a row (any games) | `1a2e4a90…` open shirt, bucket hat |
| All-Rounder | Win 5 different games | `b4c9322a…` bow tie and antlers |
| Regular | Play 50 games | `8529cc18…` sitting on a stool |
| Undetected | Survive a round as the imposter | `05ed7c84…` back turned |
| Ghost | Survive 3 of your imposter rounds in a row (crew rounds in between don't break the streak) | `a549c348…` fake-mustache disguise |
| Human Lie Detector | Survive 10 Imposter rounds as crew | `5a2df0c7…` suspicious sunglasses |
| Spymaster Supreme | Win 3 Codenames games as spymaster | `d3b78bcb…` mirrored sunglasses |
| Clutch | Win a game of 10 Seconds | `ff6eca8a…` shaving-foam shock |
| Card Shark | Win a Menifot match | `3741e064…` holding cash |
| DJ | Win a Music Timeline match | `8cf3f7e0…` party glow |
| Telepath | Win a Mind Meld match | `65e3b128…` eyes closed, head tilted |
| Poker Face | Win a Bluff match | `2ac82037…` blank stare |
| High Roller | Finish All-In or Fold with net profit at least equal to what you bought in (doubled your money) | `machine-smelly` poker robot |

Display:

- **On the card**: "Badges X/14" grid, earned first. An earned badge shows its sticker;
  a locked one shows the sticker as a dark silhouette with 🔒. Tapping any badge shows
  "Name - how to earn it".
- **Earned pop-up**: appears on the earner's own phone over whatever screen is showing:
  "🏅 Badge earned!" with the sticker (with a pop animation) and name, the win sound,
  and a vibration. Plus "Sticker unlocked! Wear it from 🧸 in the lobby." and, for
  guests when sign-in is available, "Sign in with Google from 👤 in the lobby to keep
  it forever." It closes on tap or after 6 seconds.
- If a badge's sticker file is ever deleted, the badge shows its emoji instead.

## Sticker unlocks

- The 14 stickers used as badge art are **locked** for signed-in players until they earn
  that badge. The other built-in stickers and all player-uploaded stickers stay free.
- **Guests** (anyone not signed in on this browser, including after Sign out) can wear
  every sticker — nothing is locked for them.
- Locked stickers appear in both pickers (join screen and lobby 🧸) as silhouettes with
  🔒. Tapping one shows: 🔒 Earn the "<badge>" badge to unlock this sticker.
- Earned per account once signed in (any linked device's badge unlocks it everywhere).
- The server enforces it: a locked sticker sent on join is dropped (the join still
  succeeds, with no sticker), and choosing one in the lobby is refused.
- A previously saved choice that's now locked is cleared when the page loads.
- Nothing is locked when there's no database, or if the unlock check itself fails.

## Rivalries

### On the card

- "Rivals": the 5 people you've shared the most recorded games with.
- Each row: status icon, "vs <name>", record **W–L**, and "You lead / They lead / Dead
  even · N games together". 👑 and green when you lead, 😤 and red when you trail,
  🤝 when tied.
- Tap a row to expand the record per game.
- A rival with an account counts as one person across all their devices. A guest
  rival is one device. Your own devices never appear.
- The name shown is the one they used most recently in a game with you.

### Who beat whom in a shared game

1. A win beats a loss.
2. With the same outcome, more points wins (e.g. surviving imposter +3 beats surviving
   crew +1).
3. Otherwise it's a draw. It counts toward games together but not wins or losses
   (e.g. Codenames teammates).

### After a game

Each player may get one rivalry pop-up about one opponent from that game:

- Only opponents with a winner between them this game, and at least 3 shared games in
  total (counting this one).
- The opponent you've played most is chosen.
- Text depends on what this result did to the all-time record:
  - You won: "You beat X again" (still leading), "You took the lead over X!",
    "You drew level with X", "You beat X, closing in" (still behind).
  - You lost: "X beat you again", "X took the lead over you", "X drew level with you",
    "X got you, but you still lead".
  - Each ends with the record, e.g. "15–9 all-time".
- Green border and rising sound for a win, red border and falling sound for a loss.
- Pop-ups queue: badge first, then rivalry. Tapping one shows the next.

## Sign out

- **Sign out** on the card ends the login on this browser. The account and stats are
  kept, and signing in again brings everything back.
- In the lobby the player is a guest from then on: no signed-in glow, no account
  sticker, every sticker free. "Signed in" always means a valid login on this browser,
  not just a device that was once linked.
- The device stays linked to the account, but games played on it while signed out
  are **not** counted for anyone (a signed-out phone may be in someone else's hands).
  Signing in again brings the account back on it.

## Delete my account

- Small red link on the signed-in card, behind a confirmation: "Delete your account?
  Your account, all your game history and stats will be erased for good. This cannot
  be undone." with **Cancel** and **Delete forever**.
- Permanently erases: the account, its Google link, all logins on every device, every
  linked device's game history, and its badges. The card returns to an empty guest view.
- Kept: other players' own records of shared games (the deleted player disappears from
  their rivals), the current room scoreboard until it's reset, and the anonymous daily
  counts on `/stats`.
- Signing in with the same Google account afterwards starts a brand-new, empty account.

## Data retention

- Guest history not played on for 60 days is deleted automatically.
- Expired logins are deleted.
- Account history is kept until the player deletes the account.

## Edge cases

- **Database down mid-game**: the round finishes normally; that result isn't recorded.
- **Database connected, sign-in not configured**: games are recorded, badges pop up and
  unlock stickers, and locks are active. The 👤 card is hidden and there's no sign-in
  nudge.
- **Same account playing one game from two devices**: the game counts twice.
- **Player leaves the room before the result**: not recorded for them. Other players
  are unaffected.
