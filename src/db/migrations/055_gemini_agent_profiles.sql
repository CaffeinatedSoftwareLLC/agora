-- 055: Gemini agent profiles, hosted over ACP (agora-host src/acp/, docs/provider-terms.md).
-- 051-054 are reserved for the other beta groups (docs/planning/cloud-handoff.md).
--
-- agora-host runs a gemini profile only with "protocol": "acp" and an API key; it refuses a
-- Google account login. Until the host reports its auth mode the server treats the profile as
-- 'subscription' (owner-only), like any other.
ALTER TABLE agent_profiles DROP CONSTRAINT agent_profiles_adapter_check;
ALTER TABLE agent_profiles ADD CONSTRAINT agent_profiles_adapter_check CHECK (adapter IN ('codex', 'claude', 'gemini'));
