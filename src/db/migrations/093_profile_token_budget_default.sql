-- 093: new agent profiles get a 50,000,000-token budget per session instead of 2,000,000.
-- Claude counts cached context, so long runs use millions of tokens and the old default
-- shelved task cards mid-job. Existing profiles keep the budget they have; the owner raises
-- one in Settings -> Agents ("Token budget per session").

ALTER TABLE agent_profiles ALTER COLUMN token_budget SET DEFAULT 50000000;
