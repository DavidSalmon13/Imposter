# Tokens & Betting — Product Spec (draft for PM review)

Status: **not started — this document is for scoping, not implementation.**
Builds on top of [`accounts-plan.md`](accounts-plan.md) / [`accounts-specs.md`](../specs/accounts-specs.md)
(Google sign-in, Postgres, Player Card) — tokens only exist for signed-in players,
so this feature is dormant wherever accounts are dormant.

---

## 1. Summary

Give signed-in players a play-money currency ("tokens") they can wager on outcomes
inside the games they're already playing, for fun and bragging rights — not for
cash, not redeemable, no purchases. Two separate betting mechanics:

- **Global bets** — a player vs. **the house**. Predict who wins the game, staking
  tokens for a payout if right, losing the stake if wrong.
- **Side bets** — a player vs. **another specific player**. One challenges, the
  other accepts; whoever's right takes both stakes.

## 2. Goals

- Give signed-in players another reason to keep an account and come back (loss
  aversion already works for stats/badges per `accounts-plan.md` §1 — this adds an
  active, replayable reason to engage every session, not just a trophy case).
- Add a light layer of banter/stakes for players already in the room, without
  touching how any game is actually played — this is a side layer, not a new game.
- Keep it strictly play-money. No real-money purchase, no cash-out, no transfer
  outside this app. This is the line that keeps it a party-game feature and out of
  gambling-regulation territory — it must never be crossed, including in later
  "ideas not built" extensions.

## 3. Non-goals (v1)

- No tokens for guests. Signed-in only, same gate as badges/rivalries.
- No token purchases, no cash value, no withdrawing tokens as anything.
- No leaderboard or cosmetic shop for tokens (decided: tokens are a pure betting
  chip, nothing else — revisit only if v1 proves engagement and the team wants a
  reason to open the app on non-game-night days).
- No cross-room or cross-session carryover rules beyond the daily grant — balance
  is just a number on the account, like a stats total.
- No betting mechanic for guests to watch/participate in without signing in.

## 4. The currency: Tokens

- **Who**: tied to the signed-in **account** (`users.id`), not the device/room —
  same scope as lifetime stats. A balance follows the player across devices and
  rooms, exactly like badges do.
- **Signup grant**: a one-time balance when an account is first created (first
  Google sign-in). *Proposed: 500 tokens* — tunable, no design dependency on the
  exact number.
- **Daily grant**: a small top-up once per calendar day for every account that
  signs in / is active that day. *Proposed: 50 tokens*, granted the first time
  that account is seen each day (reuses the existing `last_seen` bump in
  `accounts.js`, or a new `last_grant_date` column).
- **Floor at zero.** A balance never goes negative. A bet (global or side) can
  never be placed for more than the player's current balance.
- **No cap proposed on upside** — a player's balance can grow arbitrarily from
  winning bets. (Open question #4 below: should it?)
- **Visible**: balance shown on the Player Card (👤), and as a small persistent
  readout in-game wherever a bet can be placed.

## 5. Global bets (vs. the house)

A global bet predicts the eventual **winner of the current game** (not a round).
Two distinct moments trigger an offer to place one:

1. **Game start** — every game, for every signed-in player at the table, the
   moment the game begins (roles dealt / board set / match started). This is the
   baseline: every game gets this, since every game already has a single clear
   winner at the end (see the win-condition table in `accounts-specs.md`).
2. **On elimination, in games with a live spectator moment** — today, that's
   **Bluff** only: the instant a player's card count hits zero they already flip
   into spectator mode (`docs/specs/bluff-specs.md` "Elimination / spectating"). That
   same moment offers them a *second* global bet — now predicting the winner out
   of whoever is still active, since they can't do anything else productive with
   their phone until the match ends.
   - **Imposter does not get this trigger.** Its "eliminated" is a self-report
     collected all at once at round end (`server/games/imposter.js`), not a live
     mid-round moment with a spectator view — there's no natural point to offer a
     second bet. Any future game that adds a Bluff-style live-elimination/
     spectator mode gets this trigger automatically; games that only know who
     lost at the very end don't.

### Mechanics

- Pick one candidate from the players still eligible to win at that moment (at
  game start: everyone; at a Bluff elimination: everyone still active).
- Choose a stake, 1 up to current balance (suggest a sane minimum, e.g. 10, so a
  bet isn't a rounding error).
- **One open global bet per trigger window.** Can't bet again at game start once
  placed; the Bluff elimination trigger is a separate, independent bet (a player
  could have both a game-start bet and an elimination-moment bet live at once, on
  different picks).
- **Payout formula (proposed)**: `stake × eligibleCandidateCount × (1 − houseEdge)`
  if the pick wins, `0` back if not. `eligibleCandidateCount` is however many
  players could still win at the moment the bet was placed (so betting on a 6-way
  game-start pick pays much more than betting on the last two standing in Bluff).
  *Proposed `houseEdge`: 10–15%.* This is the one piece of real game-design math
  in this feature and deserves its own sign-off — treat the number above as a
  placeholder, not a decision.
- Tokens staked on a losing global bet are simply removed from circulation (the
  house isn't a player with its own balance); tokens paid out on a win are minted.
  This means the total token supply isn't fixed — it drifts with how the house
  edge nets out over many bets. That's intentional (house edge trends the economy
  down over time, same as any casino game), but worth the PM and whoever tunes
  the edge understanding explicitly.
- Resolution happens automatically at game-over, no one needs to claim anything.

## 6. Side bets (player vs. player)

Only where "per round" is a meaningful concept with a visible live result — today
that's **Bluff** (one round = one loser pick), alongside its global bets. Not
offered in games without discrete rounds with a clear in-app result each time.

### Flow: challenge & accept

1. **Propose**: Player A picks an opponent prediction for *this round* ("I bet X
   is this round's loser" / any other round-scoped outcome the game already
   tracks) plus a stake, and either targets a specific other player or leaves it
   open to the table.
2. **Accept**: the targeted player (or first to tap, if open) accepts, which
   locks both stakes immediately — their matching stake is the same amount A
   proposed, no custom counter-offer in v1.
3. **No bet exists until accepted.** A pending, unaccepted challenge visibly
   expires the moment the round it was about resolves (nothing was staked, no
   harm) — it simply disappears if nobody accepts in time.
4. **Resolve**: automatically when the round's result lands (e.g. the host picks
   that round's loser in Bluff). Correct side keeps both stakes; this is pure
   zero-sum transfer between the two players, no house involvement, no minting.
5. A player can have multiple side bets open at once (with different people), but
   only one **unaccepted proposal** waiting at a time, to keep the UI simple.

### Why challenge & accept over a pool

Chosen over a pari-mutuel pool (several people backing the same outcome, split at
resolution) because it's simpler to show on a phone screen mid-round (two names,
two stakes, one outcome) and because payouts are known up front — no surprise
splitting math. A pool model is a plausible v2 if 1:1 bets prove too slow to form
in the short window a round actually lasts.

## 7. Cross-cutting UX

- **Balance**: always visible once in a game that supports betting — a small
  token counter near the existing scoreboard/status chrome.
- **Placing a global bet**: a lightweight modal/sheet at the trigger moment
  (game start for everyone; on-elimination for Bluff spectators) — pick a name,
  pick a stake, confirm. Dismissable without betting (not every player wants to).
- **Placing/receiving a side bet**: a compact composer ("Bet ⟪name⟪ ⟪stake⟫ tokens
  that ___") and, for the other player, a push-style in-app prompt to accept or
  ignore, time-boxed to the current round.
- **Resolution feedback**: a brief toast/banner when a bet resolves ("You won 90
  tokens!" / "Lost your 20-token bet on Sam"), similar in tone to the existing
  badge/rivalry pop-ups (`accounts-specs.md` "Player Card") — reuse that pop-up
  queue rather than inventing a second notification system.
- **History**: out of scope for v1 beyond the resolution toast. A "recent bets"
  list on the Player Card is a natural v2, not required to ship v1.

## 8. Economy & fairness risks (for the PM to weigh, not just engineering)

- **Throwing the game for profit.** Any system where a player can win tokens by
  predicting outcomes creates an incentive to manipulate the outcome they bet on
  — e.g. the Bluff host (who alone decides each round's loser) could have a side
  bet riding on that exact decision. This app already concentrates a lot of
  trust in the host (same host picks losers, same host would see global bet
  picks); tokens add a reason, however small, to abuse that. Given this is a
  same-room party game among friends with play money and no cash value, the risk
  is probably acceptable — but it should be a conscious call, not an oversight,
  and it's worth considering hiding other players' bet picks from the host
  specifically.
- **Collusion between side bettors** (agree the outcome beforehand) — same
  acceptable-for-a-party-game risk, called out for the same reason.
- **Negative experience for new/low-balance accounts** — a bad streak takes a
  signed-in player below the minimum bet until the next daily grant. Needs either
  a floor grant ("can't go below the minimum stake") or just accept that running
  out is part of the game, like being out of chips. v1 can ship with no backstop;
  revisit if it's reported as a bad experience.
- **House edge tuning** is a live-service-style parameter (§5) — expect to adjust
  it after watching real play, not to get it right on paper.

## 9. Data model impact (for feasibility awareness, not a schema review)

Fits the existing accounts architecture (`accounts-plan.md` §4) as new tables
alongside `users`/`players`/`games`:

- `wallets` — one row per `user_id`: `balance`, `last_grant_date`.
- `bets` — one row per bet (global or side): `kind` (`global`/`side`), `game_id`
  (FK to the existing `games` table, so a bet is always tied to a specific
  recorded match), `bettor_user_id`, `opponent_user_id` (null for global),
  `pick`, `stake`, `payout`, `status` (`pending`/`accepted`/`resolved`/
  `expired`), timestamps.
- Resolution hooks into the same place each game already calls
  `ctx.recordGameResult` (`accounts-plan.md` §5.3) — that's already the single
  point where a game module knows "it's over, here's who won," so settling bets
  can piggyback on it rather than adding new per-game wiring.
- Like the rest of the accounts feature, this should **fail open**: no database,
  or a write failure mid-bet, should never block or desync the actual game — a
  bet that can't be recorded/settled is just a bet that didn't happen, same
  philosophy as a game result that doesn't get recorded (`accounts-plan.md` §3).

## 10. Phased rollout (proposed)

1. **v1, Bluff only**: game-start global bet, elimination-moment global bet for
   spectators, side bets per round. This is the one game with a live elimination/
   spectator moment and discrete per-round results, so it's the natural pilot —
   it's also literally the example that motivated this feature.
2. **v2**: game-start global bets on the remaining 7 games (no side bets or
   elimination-moment bets outside games with Bluff's live elimination/spectator
   shape, unless a future game adds one).
3. **v3 (not committed)**: anything from "ideas not built" in §12 of
   `accounts-plan.md`'s spirit — bet history on the Player Card, a pari-mutuel
   side-bet pool, per-game odds tuning based on observed outcomes.

## 11. Open questions for product sign-off

1. Exact signup grant and daily grant amounts (proposed: 500 / 50).
2. Exact house edge on global bets (proposed: 10–15%) and whether it should vary
   by game or stay constant.
3. Minimum stake (proposed: 10 tokens) and whether there's a maximum per bet.
4. Should balance be capped, or allowed to grow unbounded for a player on a long
   winning streak?
5. Any backstop for a player who drops to zero before their next daily grant
   (e.g. a small "can't go below the minimum stake" floor), or is running out
   part of the intended experience?
6. Should the Bluff host's own bets (global or side) be hidden from the host's
   view of other players' bets, given the host alone decides round outcomes?
7. Side-bet proposal expiry: tied exactly to "this round ends," or a shorter
   fixed timer (e.g. 30 seconds) so a slow-to-respond opponent doesn't stall it?
