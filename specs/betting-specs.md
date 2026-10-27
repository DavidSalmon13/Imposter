# Tokens & Betting — Specs

A play-money side layer for signed-in players: everyone gets a token balance and can
wager tokens on outcomes inside the game they're already playing, for fun and bragging
rights. **Never real money** — no purchases, no cash-out, no transfer outside the app.

Builds on [`accounts-specs.md`](accounts-specs.md) (Google sign-in, Player Card) — tokens
only exist for signed-in players, so this feature is invisible wherever accounts are
invisible (guests, or no database/sign-in configured).

Design, data model and rollout: [`plans/betting-implementation-plan.md`](../plans/betting-implementation-plan.md).

## Relationship to existing games / shared app changes

- Needs accounts (`DATABASE_URL` + `GOOGLE_CLIENT_ID`) **and** its own flag,
  `BETTING_ENABLED` — see "Configuration" in the implementation plan. Either one off
  means no betting UI anywhere, same "app behaves exactly as before" guarantee the rest
  of the accounts feature gives.
- **v1 ships for Bluff only.** It's the one game with a live mid-match elimination/
  spectator moment and a discrete per-round result, which both betting mechanics below
  need. Other games get the game-start global bet only, in a later phase; see
  `plans/betting-implementation-plan.md` "Phased rollout."
- **Guests see nothing.** No token balance, no bet offers, no indication that betting is
  happening at their table. A guest can still be the *subject* of someone else's bet
  (picked as the predicted winner/loser) without knowing it.
- Doesn't change how Bluff is played. No rule, timer, or decision described in
  `specs/bluff-specs.md` is altered; betting only observes the same events (round start,
  a player hitting 0 cards, the host's loser pick, match end) that already happen.

## Configurable constants

| Constant | Value | Meaning |
|---|---|---|
| `TOKENS_SIGNUP_GRANT` | 1000 | One-time balance when an account is first created |
| `TOKENS_DAILY_GRANT` | 100 | Top-up granted the first time a signed-in account is seen each calendar day |
| `BET_MIN_STAKE` | 10 | Smallest stake allowed on any bet, global or side |
| `BET_MAX_STAKE` | none | A bet can never exceed the bettor's current balance; no separate cap |
| `BET_HOUSE_EDGE` | 0.10 | Global-bet house cut, applied in the payout formula below; fixed, same for every game |

## The wallet

- **Scope**: tied to the signed-in **account** (`users.id`), same as lifetime stats — a
  balance follows the player across devices and rooms.
- **Signup grant**: `TOKENS_SIGNUP_GRANT` tokens, credited once, the moment an account is
  first created (first "Continue with Google" ever, on any device).
- **Daily grant**: `TOKENS_DAILY_GRANT` tokens, credited the first time that account is
  seen on any given calendar day (server clock) — opening the Player Card or signing in
  both count as "seen."
- **Floor at zero, no ceiling.** A balance never goes negative — a bet can never be
  placed for more than the player's current balance. There's no cap on the upside; a
  long winning streak can grow a balance arbitrarily.
- **No backstop.** Dropping below `BET_MIN_STAKE` before the next daily grant just means
  no more betting until it lands, same as being out of chips at a table. This is
  accepted as part of the experience for v1.
- **Visible**: balance shown on the Player Card, and as a small persistent readout
  in-game wherever a bet can be placed (next to the existing scoreboard/status chrome).

## Global bets (vs. the house)

Predicts the eventual **winner of the current match** (not a round). Two moments offer
one, each independently:

1. **Match start** — the instant Bluff deals round 1 (host clicks "Start Match"), every
   signed-in player on the frozen roster is offered a bet on who wins the whole match.
2. **On elimination** — the instant a player's card count hits 0 and they flip into
   spectator mode, *that player specifically* (not the whole table) is offered a second,
   independent bet — now predicting the winner among whoever is still active, since
   they can't do anything else productive with their phone until the match ends.

A player can have both a match-start bet and an elimination-moment bet live at once, on
different picks — they're separate trigger windows, not one bet that gets edited.

### Placing one

- Pick one name from the players still eligible to win at that moment (match start:
  the whole frozen roster; elimination moment: whoever is still active).
- Choose a stake, `BET_MIN_STAKE` up to current balance.
- **One open global bet per trigger window.** Once placed, that window is done — no
  changing the pick, no adding a second bet on the same trigger.
- The offer is dismissable. Not betting costs nothing and misses nothing else.

### Payout

`stake × eligibleCandidateCount × (1 − BET_HOUSE_EDGE)`, floored to a whole token, if the
pick wins the match; `0` back otherwise. `eligibleCandidateCount` is however many players
could still win at the moment *that specific bet* was placed — a match-start bet on a
6-way field pays much more than an elimination-moment bet made when only two players are
left standing.

Losing stakes are removed from circulation; winning payouts are minted (the house isn't a
player with its own balance to draw from). Total token supply isn't fixed — it drifts
down over many bets by roughly the house edge. This is intentional, same as any casino
game, and is the one piece of real economy design here.

Resolution is automatic the moment the match ends — nobody claims anything.

## Side bets (player vs. player)

Predicts **this round's loser** in Bluff — the only round-scoped outcome with a clear,
host-adjudicated result each time. (Bluff's optional hand-check "present"/"not there"
call is explicitly **not** bettable in v1 — out of scope, a candidate for v2.)

### Flow: challenge & accept

1. **Propose**: pick a name you think will be this round's loser, plus a stake, and
   either target one specific other signed-in player or leave it open to the table.
2. **Accept**: the targeted player (or whoever taps first, if open) accepts, locking
   both stakes immediately at the proposer's stake amount — no counter-offer in v1.
3. **No bet exists until accepted.** An unaccepted proposal carries no stake and no
   risk.
4. **Expiry**: tied exactly to the round it's about. The instant that round resolves —
   normally (the host picks a loser) or via an edit (see below) — any still-unaccepted
   proposal on it simply disappears. No separate countdown timer in v1.
5. **Resolve**: automatically when the host picks that round's loser. The correct side
   takes both stakes — pure zero-sum transfer between the two players, no house
   involvement, no minting or removal.
6. **Voided by an edit**: if the host resolves (or ends) the round via "Edit card
   counts" instead of a normal seat-tap, any side bets open on that round — accepted or
   not — are **cancelled and any taken stakes refunded**, rather than settled off the
   edit. An edit is a correction tool, not a real round outcome.
7. A player can have several side bets open at once (with different people), but only
   one **unaccepted proposal** waiting at a time, to keep the UI simple.
8. The player predicted as the loser doesn't have to be a signed-in player (anyone at
   the table can be picked) — only the two people staking tokens (proposer and
   accepter) need wallets.

### Why challenge & accept over a pool

Chosen over a pari-mutuel pool (several people backing the same outcome, split at
resolution) because it's simpler to show on a phone mid-round — two names, two stakes,
one outcome — and payouts are known up front. A pool model is a plausible v2 if 1:1 bets
prove too slow to form in the short window a round lasts.

## Who can see whose bets

Visibility is based on the **viewer's own status in the match**, not specifically on
whether they're the host — this is what keeps the host (who alone adjudicates every
round and the match) from ever seeing information that would give them a reason to
steer a decision:

- **Still-active players** (including an active host) never see any bet except their
  own — their own global bet(s), their own side bets (proposed, accepted, or offered to
  them). No ambient view of what anyone else has riding on the round or the match.
- **Eliminated/spectating players** can additionally see every other eliminated
  player's bets. They have nothing left to gain from that information and nothing left
  to influence, so there's no integrity reason to keep hiding it from them.
- This applies equally if the host themselves is eliminated mid-match (still-active
  host handoff happens as normal per `bluff-specs.md` "Disconnects," but a host who
  stays on as an eliminated spectator still never sees active players' bets, since
  they're still the one tapping seats).

## Cross-cutting UX

- **Balance**: a small token counter near the existing scoreboard/status chrome,
  visible once betting is live for that player.
- **Placing a global bet**: a lightweight modal/sheet at the trigger moment (match start
  for everyone; elimination for that one newly-spectating player) — pick a name, pick a
  stake, confirm. Dismissable.
- **Placing/receiving a side bet**: a compact composer ("Bet ⟪name⟫ ⟪stake⟫ tokens that
  ⟪pick⟫ is this round's loser") and, for the targeted player, an in-app prompt to
  accept or ignore, gone the moment the round resolves.
- **Resolution feedback**: a brief toast when a bet resolves ("You won 90 tokens!" /
  "Lost your 20-token bet on Sam") — reuses the existing badge/rivalry pop-up queue
  (`accounts-specs.md` "Badges" / "Rivalries"), queued after those if several land at
  once, not a second notification system.
- **No standing opt-out in v1.** Dismissing each offer individually is the only way to
  not participate; there's no Player Card toggle to hide betting entirely. A natural v2
  if players find the prompts intrusive.
- **History**: out of scope for v1 beyond the resolution toast.

## Economy & fairness risks (accepted for v1)

- **Throwing the game for profit** and **collusion between side bettors** are both
  possible in principle (the Bluff host alone decides round/match outcomes). Accepted
  for a same-room party game among friends with play money and no cash value — the
  host-view-hiding rule above removes the host's *ambient* view of others' stakes, but
  doesn't stop a host from colluding with a specific player they already know is
  betting on them.
- **House edge tuning** is a live-service-style parameter — expect to adjust
  `BET_HOUSE_EDGE` after watching real play, not to get it right on paper.

## Explicitly out of scope (v1)

- Tokens or betting for guests, in any form.
- Token purchases, cash value, or withdrawing tokens as anything.
- A leaderboard or cosmetic shop for tokens.
- Cross-room/cross-session carryover rules beyond the daily grant.
- Any betting mechanic in games other than Bluff (match-start global bets for the other
  7 games are a named v2; everything else stays Bluff-only until a future game adds a
  Bluff-style live elimination/spectator moment).
- Betting on Bluff's hand-check "present"/"not there" call.
- A balance cap, a zero-balance backstop, a per-player opt-out toggle, and bet history
  beyond the resolution toast — all considered and deliberately deferred.
- Admin-page visibility into the token economy (circulation, total wagered, house take).

## Edge cases

- **A bettor disconnects/leaves before resolution**: their bet(s) resolve normally off
  the final result when the match (global) or round (side) ends — same as the room
  scoreboard, which keeps running without them.
- **Database down, or a write fails mid-bet**: fails open, same philosophy as game
  result recording — a bet that can't be placed/settled is just a bet that didn't
  happen, and never blocks or desyncs the actual game.
- **A side bet's predicted player is eliminated before the round resolves**: can't
  happen — the predicted player is always drawn from the currently-active roster at
  propose time, and a round resolves in one shot (one loser pick or one edit), not
  incrementally.
