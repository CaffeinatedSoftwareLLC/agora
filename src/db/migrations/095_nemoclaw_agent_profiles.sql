-- 095: NVIDIA NemoClaw agent profiles (agora-host src/nemoclaw.ts, docs/provider-terms.md
-- "NVIDIA NemoClaw"): on a machine OpenClaw in a NemoClaw sandbox, in an agent box OpenClaw
-- itself, on an API key or a local model only.
--
-- Adds 'nemoclaw' to whatever list the check constraint has (the pattern of 088 and 089), so
-- another adapter's migration can land before or after this one.
DO $$
DECLARE
    def TEXT;
    adapters TEXT[];
BEGIN
    SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
     WHERE conrelid = 'agent_profiles'::regclass AND conname = 'agent_profiles_adapter_check';
    SELECT array_agg(m[1] ORDER BY n) INTO adapters
      FROM regexp_matches(COALESCE(def, ''), '''([a-z0-9_-]+)''', 'g') WITH ORDINALITY AS t(m, n);
    adapters := COALESCE(adapters, ARRAY['codex', 'claude', 'gemini', 'opencode', 'omp', 'devin']);
    IF NOT 'nemoclaw' = ANY (adapters) THEN adapters := array_append(adapters, 'nemoclaw'); END IF;
    IF def IS NOT NULL THEN ALTER TABLE agent_profiles DROP CONSTRAINT agent_profiles_adapter_check; END IF;
    EXECUTE format('ALTER TABLE agent_profiles ADD CONSTRAINT agent_profiles_adapter_check CHECK (adapter IN (%s))',
        (SELECT string_agg(quote_literal(a), ', ') FROM unnest(adapters) AS a));
END $$;
