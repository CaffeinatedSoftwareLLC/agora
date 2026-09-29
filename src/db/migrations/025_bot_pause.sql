-- Bot pause: an admin (or later, an orchestrator/tripwire) can halt a bot without
-- revoking its tokens. Paused bots can read but not write (enforced in requireAuth).
ALTER TABLE users
  ADD COLUMN bot_paused_at TIMESTAMPTZ,
  ADD COLUMN bot_paused_reason TEXT;
