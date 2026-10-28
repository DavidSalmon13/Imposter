-- Global bets lock in their payout multiplier at placement time (see computeGlobalOdds
-- in server/betting.js). Null on rows placed before this - those keep paying the old
-- flat stake * eligible * (1 - house edge).
ALTER TABLE bets ADD COLUMN odds NUMERIC(6, 1);
