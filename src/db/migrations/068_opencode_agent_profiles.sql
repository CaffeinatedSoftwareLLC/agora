-- 068: opencode agent profiles, hosted over ACP on an OpenRouter key (agora-host src/acp/,
-- docs/agent-sessions.md "opencode and OpenRouter"). 069 is reserved for the model agents work.
--
-- agora-host runs an opencode profile only with "protocol": "acp" and auth "api_key"
-- (OPENROUTER_API_KEY), with the profile's model. Until the host reports its auth mode the
-- server treats the profile as 'subscription' (owner-only), like any other.
ALTER TABLE agent_profiles DROP CONSTRAINT agent_profiles_adapter_check;
ALTER TABLE agent_profiles ADD CONSTRAINT agent_profiles_adapter_check CHECK (adapter IN ('codex', 'claude', 'gemini', 'opencode'));
