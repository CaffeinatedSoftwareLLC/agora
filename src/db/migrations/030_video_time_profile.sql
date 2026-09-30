-- Video runs (Veo) get their own, longer time profile (WBS 5.3, src/runtime/limits.ts).
ALTER TABLE exec_runs DROP CONSTRAINT IF EXISTS exec_runs_time_profile_check;
ALTER TABLE exec_runs ADD CONSTRAINT exec_runs_time_profile_check
    CHECK (time_profile IN ('standard', 'generation', 'video'));
