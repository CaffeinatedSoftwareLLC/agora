-- 088: oh-my-pi (omp) agent profiles, hosted over ACP on an OpenRouter key only (agora-host
-- src/acp/omp.ts, docs/provider-terms.md "oh-my-pi"), on a machine and in an agent box.
--
-- The check constraint gains 'omp' by adding it to whatever list is there, rather than
-- restating the list: another adapter's migration (Devin is being added in parallel) can then
-- land before or after this one without either dropping the other's value.
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
    IF NOT 'omp' = ANY (adapters) THEN adapters := array_append(adapters, 'omp'); END IF;
    IF def IS NOT NULL THEN ALTER TABLE agent_profiles DROP CONSTRAINT agent_profiles_adapter_check; END IF;
    EXECUTE format('ALTER TABLE agent_profiles ADD CONSTRAINT agent_profiles_adapter_check CHECK (adapter IN (%s))',
        (SELECT string_agg(quote_literal(a), ', ') FROM unnest(adapters) AS a));
END $$;
