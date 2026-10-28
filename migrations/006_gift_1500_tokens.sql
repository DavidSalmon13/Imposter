-- One-time gift: every account that exists when this runs gets 1500 tokens on top of
-- its balance. Accounts with no wallet yet (created while betting was off) get one
-- holding the 1500. Runs once per database, like every migration; accounts created
-- afterwards just get the normal signup grant.
UPDATE wallets SET balance = balance + 1500;
INSERT INTO wallets (user_id, balance)
  SELECT id, 1500 FROM users WHERE id NOT IN (SELECT user_id FROM wallets);
