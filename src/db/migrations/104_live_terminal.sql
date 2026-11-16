-- Live terminals (docs/planning/live-terminals.md): a boxed Claude Code agent can run its normal
-- interactive CLI in a long-lived terminal inside its box, which the server owner can watch and type
-- into from the web app.
--
-- Written only by the server as the table owner (the gateway's live hub and the session routes);
-- app_user gets no grants (migration 006 granted existing tables only). The terminal's bytes are
-- never stored: only states, turn boundaries and counts.

-- The owner's choice per agent. 'runs': a fresh headless process per wake (today's behaviour,
-- token budgets apply). 'live': one interactive session per channel session (no token budget).
ALTER TABLE agent_profiles
    ADD COLUMN session_mode VARCHAR(8) NOT NULL DEFAULT 'runs' CHECK (session_mode IN ('runs', 'live'));

-- A live-mode session is an ordinary hosted session row (it keeps /start, /end, the chip and the
-- limits) that takes no per-wake runs: the claim query skips it and messages reach the agent through
-- the Claude Code Channel. native_session_id holds the conversation's id (a UUID chosen at /start)
-- so the interactive CLI resumes the same conversation after a box restart or rebuild.
ALTER TABLE agent_sessions
    ADD COLUMN live_mode     BOOLEAN NOT NULL DEFAULT FALSE,
    -- starting | idle | working | waiting | restarting | stopped; what the box last reported
    ADD COLUMN live_state    VARCHAR(12),
    -- A fixed code for the owner's page: no_signal, notification, channel_unavailable, ... (never screen text)
    ADD COLUMN live_note     VARCHAR(40),
    ADD COLUMN live_state_at TIMESTAMPTZ;

-- The live protocol an agent's host speaks, reported when its live socket connects.
ALTER TABLE agent_hosts ADD COLUMN live_protocol INTEGER;

-- One row per turn of a live session: from a delivered message (or from something the owner typed)
-- until the agent goes idle. Branch and commit are read by the box's host from git at both ends, so
-- the receipts grading can compare them later; whether the idle signal was a real one is on the row.
CREATE TABLE live_terminal_turns (
    id                CHAR(26) PRIMARY KEY,
    session_id        CHAR(26) NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    server_id         CHAR(26) NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    channel_id        CHAR(26) NOT NULL,
    -- The Agora message whose channel push started the turn; NULL for a turn the owner typed
    message_id        CHAR(26),
    source            VARCHAR(8) NOT NULL CHECK (source IN ('message', 'typed')),
    started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at          TIMESTAMPTZ,
    branch            VARCHAR(255),
    start_sha         VARCHAR(64),
    end_sha           VARCHAR(64),
    -- How the turn ended: stop_hook (the CLI said it finished), interrupted (the turn limit),
    -- session_ended (/end or the CLI exited), host_lost (the box stopped reporting)
    end_signal        VARCHAR(16),
    -- The agent's own CLI reported a clean end (its Stop hook) and both commits were read. This is the agent's
    -- report, NOT proof: receipts grading must not trust it as evidence that work finished.
    agent_reported_clean BOOLEAN NOT NULL DEFAULT FALSE,
    unverified_reason VARCHAR(40)
);
-- Deliveries to a live session go through the inbox the server's routing already fills (mention, sole agent,
-- thread follow-up, task thread, protocol, handoff; mayDirect, termsAllow, the plan-owner rule). The server
-- counts the wake when it sends the push (live_wake_counted), and replays what is not acknowledged.
ALTER TABLE agent_inbox
    ADD COLUMN live_sent_at      TIMESTAMPTZ,
    ADD COLUMN live_wake_counted BOOLEAN NOT NULL DEFAULT FALSE,
    -- The "started a session" notice a /start or /resume posts so the agent says hello: the one row a live session
    -- acknowledges without pushing it (every other row, notices to the agent included, is delivered)
    ADD COLUMN hello             BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX idx_live_turns_session ON live_terminal_turns(session_id, started_at DESC);
CREATE UNIQUE INDEX idx_live_turns_open ON live_terminal_turns(session_id) WHERE ended_at IS NULL;
ALTER TABLE live_terminal_turns ENABLE ROW LEVEL SECURITY;
