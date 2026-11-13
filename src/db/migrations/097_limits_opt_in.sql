-- 097: agent limits are the user's choice. NULL means "no limit" for every limit below, and
-- "no limit" is the default: an owner who wants one sets it in Settings (docs/agent-limits.md).
-- (095 and 096 are taken by open pull requests #377 and #384.)
--
--   agent_profiles.wake_budget       wakes a session may use               was 50
--   agent_profiles.token_budget      tokens a session may use              was 50,000,000 (2,000,000 before 093)
--   agent_profiles.run_timeout_sec   seconds one run may take              was 900, allowed 60..7200
--   channels.max_bot_hops            bot messages in a row in a channel    was 4 (0 = off)
--   channels.max_thread_bot_hops     bot replies in a row in one thread    was 0 = off
--
-- Existing rows: a value the program chose (the old defaults above) becomes NULL; any other
-- value was set by a person and stays. agent_sessions.token_budget is only ever written by the
-- owner (a session's own limit) or for a subtask, so those rows stay as they are.
-- Sessions shelved for a budget stay shelved: the owner resumes them (a resume records who
-- restarted the agent, which the subscription rules need), and the resume now succeeds.
--
-- The statements can run more than once (the integration test runs the file again).

-- ─── Agent profiles ───
ALTER TABLE agent_profiles ALTER COLUMN wake_budget DROP NOT NULL;
ALTER TABLE agent_profiles ALTER COLUMN wake_budget DROP DEFAULT;
ALTER TABLE agent_profiles ALTER COLUMN wake_budget TYPE BIGINT;

ALTER TABLE agent_profiles ALTER COLUMN token_budget DROP NOT NULL;
ALTER TABLE agent_profiles ALTER COLUMN token_budget DROP DEFAULT;

ALTER TABLE agent_profiles DROP CONSTRAINT IF EXISTS agent_profiles_run_timeout_sec_check;
ALTER TABLE agent_profiles ALTER COLUMN run_timeout_sec DROP NOT NULL;
ALTER TABLE agent_profiles ALTER COLUMN run_timeout_sec DROP DEFAULT;
ALTER TABLE agent_profiles ALTER COLUMN run_timeout_sec TYPE BIGINT;
ALTER TABLE agent_profiles ADD CONSTRAINT agent_profiles_run_timeout_sec_check CHECK (run_timeout_sec > 0);

-- The limit a run was claimed with (094); NULL now also means "claimed with no limit"
ALTER TABLE agent_runs ALTER COLUMN timeout_sec TYPE BIGINT;

UPDATE agent_profiles SET wake_budget = NULL WHERE wake_budget = 50;
UPDATE agent_profiles SET token_budget = NULL WHERE token_budget IN (2000000, 50000000);
UPDATE agent_profiles SET run_timeout_sec = NULL WHERE run_timeout_sec = 900;

-- ─── Channel loop guards ───
ALTER TABLE channels ALTER COLUMN max_bot_hops DROP DEFAULT;
ALTER TABLE channels ALTER COLUMN max_bot_hops TYPE BIGINT;
ALTER TABLE channels ALTER COLUMN max_thread_bot_hops DROP NOT NULL;
ALTER TABLE channels ALTER COLUMN max_thread_bot_hops DROP DEFAULT;
ALTER TABLE channels ALTER COLUMN max_thread_bot_hops TYPE BIGINT;

-- 0 was "off" (the code still reads a stored 0 as off); 4 was the channel default (the thread
-- guard's default was already off)
UPDATE channels SET max_bot_hops = NULL WHERE max_bot_hops IN (0, 4);
UPDATE channels SET max_thread_bot_hops = NULL WHERE max_thread_bot_hops = 0;

-- ─── What stopped a session ───
-- Set when a session is shelved with end_reason 'budget': {"kind":"wake"|"token","used":n,"limit":n,
-- "sessionId":"<whose limit>"} or {"kind":"credit"} (the API key ran out of credit). Before this,
-- all three looked the same ("shelved (budget)") and the UI described each as the token budget.
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS limit_stop JSONB;
