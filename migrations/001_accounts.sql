-- Accounts + lifetime game history. Room state stays in rooms.json; this database
-- only holds data that must outlive a room. See plans/accounts-plan.md.

CREATE EXTENSION IF NOT EXISTS citext;

-- A signed-in account. Google-only for now; username/password_hash are reserved so
-- password sign-in can be added later without another table rewrite.
CREATE TABLE users (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username       CITEXT UNIQUE,
  email          CITEXT UNIQUE,
  password_hash  TEXT,
  display_name   TEXT NOT NULL,
  avatar_url     TEXT,
  sticker        TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- External logins (Google today, maybe Apple later) linked to a user.
CREATE TABLE user_identities (
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  provider_sub  TEXT NOT NULL,
  PRIMARY KEY (provider, provider_sub)
);
CREATE INDEX user_identities_user_idx ON user_identities (user_id);

-- Anyone who has played, guest or not, keyed by the browser's clientId. Stats hang
-- off this row, so a guest's history is kept and simply gains a user_id on sign-in.
CREATE TABLE players (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id   TEXT NOT NULL UNIQUE,
  user_id     BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX players_user_idx ON players (user_id);

-- One row per finished game/round that produced a result.
CREATE TABLE games (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_code   TEXT NOT NULL,
  game_type   TEXT NOT NULL,
  ended_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX games_type_ended_idx ON games (game_type, ended_at);

CREATE TABLE game_participants (
  game_id    BIGINT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id  BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  name_used  TEXT NOT NULL,
  role       TEXT,
  team       TEXT,
  won        BOOLEAN,
  points     INTEGER NOT NULL DEFAULT 0,
  details    JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (game_id, player_id)
);
CREATE INDEX game_participants_player_idx ON game_participants (player_id);

-- Badge definitions live in code; this only records who earned what.
CREATE TABLE achievements (
  player_id  BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  badge_id   TEXT NOT NULL,
  game_id    BIGINT REFERENCES games(id) ON DELETE SET NULL,
  earned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, badge_id)
);

-- Login sessions. Only a SHA-256 of the cookie token is stored.
CREATE TABLE auth_sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id);
