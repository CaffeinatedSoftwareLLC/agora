-- 102: a bot can act with its owner's authority (owner bots, docs/provider-terms.md).
-- On (the default): a post on a personal token the bot's owner made can direct the owner's agents
-- without can_direct, and the bot can start and resume them as the owner. Off: the bot keeps only
-- its own can_direct and the rule that lets it wake the owner's plan-owned agents.
ALTER TABLE users ADD COLUMN IF NOT EXISTS bot_acts_as_owner BOOLEAN NOT NULL DEFAULT true;
