-- 089: Devin agent profiles, hosted over ACP (`devin acp`) on the owner's own Devin login
-- (agora-host src/adapters.ts, docs/provider-terms.md "Devin"), on a machine or in an agent box.
--
-- agora-host runs a devin profile only with "protocol": "acp" and auth 'subscription', so the
-- server's owner-only wake rule applies to it like any other subscription profile.
--
-- The check constraint gains 'devin' by adding it to whatever list is there, never restating the
-- list, so another adapter's migration (oh-my-pi's 088) can land before or after this one
-- without either dropping the other's value.
DO $$
DECLARE
    def TEXT;
    adapters TEXT[];
BEGIN
    SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
     WHERE conrelid = 'agent_profiles'::regclass AND conname = 'agent_profiles_adapter_check';
    SELECT array_agg(m[1] ORDER BY n) INTO adapters
      FROM regexp_matches(COALESCE(def, ''), '''([a-z0-9_-]+)''', 'g') WITH ORDINALITY AS t(m, n);
    adapters := COALESCE(adapters, ARRAY['codex', 'claude', 'gemini', 'opencode']);
    IF NOT 'devin' = ANY (adapters) THEN adapters := array_append(adapters, 'devin'); END IF;
    IF def IS NOT NULL THEN ALTER TABLE agent_profiles DROP CONSTRAINT agent_profiles_adapter_check; END IF;
    EXECUTE format('ALTER TABLE agent_profiles ADD CONSTRAINT agent_profiles_adapter_check CHECK (adapter IN (%s))',
        (SELECT string_agg(quote_literal(a), ', ') FROM unnest(adapters) AS a));
END $$;
