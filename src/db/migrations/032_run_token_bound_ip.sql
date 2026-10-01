-- A run token is bound to the first address that uses it (the sandbox container it
-- was issued to). The capability gateway rejects it from any other address, so a
-- token copied into another sandbox is refused while its run is still live.
ALTER TABLE exec_run_tokens ADD COLUMN IF NOT EXISTS bound_ip TEXT;
