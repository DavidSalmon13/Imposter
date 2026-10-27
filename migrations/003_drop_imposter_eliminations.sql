-- One-time cleanup for a bug where Imposter dealt a role to every player in the room,
-- including people who had closed the app. They never answered "were you eliminated?",
-- which defaulted to eliminated, so each round recorded a loss for them. Those rows
-- can't be told apart from real eliminations (nothing recorded whether the player
-- answered), so every eliminated Imposter result is dropped. Survivors' wins stay.

DELETE FROM game_participants gp
 USING games g
 WHERE gp.game_id = g.id
   AND g.game_type = 'imposter'
   AND gp.details->>'eliminated' = 'true';

-- Rounds where nobody survived are left with no participants.
DELETE FROM games g
 WHERE g.game_type = 'imposter'
   AND NOT EXISTS (SELECT 1 FROM game_participants gp WHERE gp.game_id = g.id);
