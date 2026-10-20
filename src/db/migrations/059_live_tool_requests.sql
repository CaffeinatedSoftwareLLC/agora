-- 059: Codex app-server approvals become tool-request cards while the turn waits (#93).
-- 058 is taken by another branch.
--
-- A live request is one approval a running turn holds: Codex asked to run one command, write
-- one change or get one permission, and the host waits for the card's decision. Its row is
-- 'waiting' (not 'pending', so the one-pending-card-per-tool index of after-run cards is left
-- alone) until it is decided, or 'expired' once the host stops waiting or the run ends.
-- `request_key` binds the card to that exact request (thread, turn, item and JSON-RPC id,
-- hashed by the host), so a card only ever answers the request it was posted for.
-- `waiting_until` is when the host gives up and denies. Live requests are never granted to a
-- later run.
ALTER TABLE agent_tool_requests ADD COLUMN request_key CHAR(64);
ALTER TABLE agent_tool_requests ADD COLUMN waiting_until TIMESTAMPTZ;

ALTER TABLE agent_tool_requests DROP CONSTRAINT agent_tool_requests_status_check;
ALTER TABLE agent_tool_requests ADD CONSTRAINT agent_tool_requests_status_check
    CHECK (status IN ('pending', 'waiting', 'once', 'always', 'denied', 'expired'));
ALTER TABLE agent_tool_requests ADD CONSTRAINT agent_tool_requests_live_check
    CHECK ((request_key IS NULL) = (waiting_until IS NULL) AND (status <> 'waiting' OR request_key IS NOT NULL));

CREATE UNIQUE INDEX idx_agent_tool_requests_live ON agent_tool_requests(run_id, request_key)
    WHERE request_key IS NOT NULL;
