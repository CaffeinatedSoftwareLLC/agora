-- 088: Devin agent profiles, hosted over ACP (`devin acp`) on the owner's own Devin login
-- (agora-host src/adapters.ts, docs/provider-terms.md "Devin"), on a machine or in an agent box.
--
-- agora-host runs a devin profile only with "protocol": "acp" and auth 'subscription', so the
-- server's owner-only wake rule applies to it like any other subscription profile.
ALTER TABLE agent_profiles DROP CONSTRAINT agent_profiles_adapter_check;
ALTER TABLE agent_profiles ADD CONSTRAINT agent_profiles_adapter_check CHECK (adapter IN ('codex', 'claude', 'gemini', 'opencode', 'devin'));
