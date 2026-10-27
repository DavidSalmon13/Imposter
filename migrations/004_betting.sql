-- Tokens & betting. Play money only; see specs/betting-specs.md and
-- plans/betting-implementation-plan.md. New tables only - nothing here changes any
-- existing table.

CREATE TABLE wallets (
  user_id          BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance          INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  last_grant_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE bets (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN ('global', 'side')),
  game_id            BIGINT REFERENCES games(id) ON DELETE SET NULL,
  room_code          TEXT NOT NULL,
  bettor_user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opponent_user_id   BIGINT REFERENCES users(id) ON DELETE CASCADE, -- null for global
  pick_name          TEXT NOT NULL,       -- name_used at bet time, not a player_id FK
  stake              INTEGER NOT NULL CHECK (stake > 0),
  payout             INTEGER,             -- null until resolved
  status             TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'resolved', 'expired', 'voided')),
  trigger            TEXT,                -- 'start' | 'elimination' | null for side bets
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at        TIMESTAMPTZ
);
CREATE INDEX bets_bettor_idx ON bets (bettor_user_id);
CREATE INDEX bets_opponent_idx ON bets (opponent_user_id);
CREATE INDEX bets_game_idx ON bets (game_id);
