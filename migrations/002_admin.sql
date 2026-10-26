-- Admin page (/admin, server/admin.js): banning accounts and individual devices.
-- A banned account can't sign in or join; a banned device (players row, guest or
-- not) can't join whatever account it's signed in to.

ALTER TABLE users ADD COLUMN banned_at TIMESTAMPTZ;
ALTER TABLE players ADD COLUMN banned_at TIMESTAMPTZ;
