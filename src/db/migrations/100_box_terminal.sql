-- A terminal in the browser, attached to one agent box (docs/box-terminal.md,
-- docs/planning/box-terminal.md). The box's own agora-host starts the shell and relays its bytes
-- over the gateway; Agora keeps only who opened it, when, for how long and how many bytes moved.
-- The bytes themselves are never stored.
--
-- Written only by the server as the table owner (gateway and box terminal routes); app_user gets
-- no grants (migration 006 granted existing tables only), and RLS is on as for every box table.

-- ─── The owner's limits (security boundaries, shown in Settings, §"Limits") ───
ALTER TABLE agent_boxes
    -- No keystroke from the owner for this long ends the terminal
    ADD COLUMN terminal_idle_minutes INTEGER NOT NULL DEFAULT 15 CHECK (terminal_idle_minutes BETWEEN 1 AND 240),
    -- A terminal never lives longer than this, however busy
    ADD COLUMN terminal_max_hours    INTEGER NOT NULL DEFAULT 8  CHECK (terminal_max_hours BETWEEN 1 AND 24),
    -- Output the shell may send to the browser, KiB per second
    ADD COLUMN terminal_rate_kbps    INTEGER NOT NULL DEFAULT 512 CHECK (terminal_rate_kbps BETWEEN 16 AND 8192);

-- The terminal protocol a box's terminal relay speaks, reported when it connects. NULL: it never
-- has (an older box image), and Settings says the box needs its update first. The relay is its own
-- process, run by its own Unix user, apart from the agent's agora-host (docs/box-terminal.md):
-- protocol 2. Nothing shipped with protocol 1, where agora-host itself held the terminal.
ALTER TABLE agent_hosts ADD COLUMN shell_protocol INTEGER;

-- The terminal relay's own credential (ar_<hostId>.<secret>), stored as a SHA-256 digest.
-- Minted with the box's generation, delivered only to the relay's Unix user, and the only thing
-- the terminal hub accepts from a box. The host token (secret_hash) cannot register a terminal.
ALTER TABLE agent_hosts ADD COLUMN relay_secret_hash TEXT;

-- ─── One row per terminal: who, which box, when, how long, how many bytes ───
CREATE TABLE box_shell_sessions (
    id             CHAR(26) PRIMARY KEY,
    box_id         CHAR(26) NOT NULL REFERENCES agent_boxes(id) ON DELETE CASCADE,
    server_id      CHAR(26) NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    opened_by      CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    -- The box generation it was opened on: a rebuild ends it
    generation     INTEGER NOT NULL,
    -- opening: the host has been asked to start the shell; open: it started; closed: over
    state          VARCHAR(8) NOT NULL DEFAULT 'opening' CHECK (state IN ('opening', 'open', 'closed')),
    opened_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at     TIMESTAMPTZ,
    closed_at      TIMESTAMPTZ,
    close_reason   VARCHAR(40),
    -- Counts only, never content
    bytes_in       BIGINT NOT NULL DEFAULT 0,
    bytes_out      BIGINT NOT NULL DEFAULT 0
);
-- One terminal per box at a time, enforced by the database
CREATE UNIQUE INDEX idx_box_shell_one_per_box ON box_shell_sessions(box_id) WHERE state <> 'closed';
CREATE INDEX idx_box_shell_box ON box_shell_sessions(box_id, opened_at DESC);

-- ─── Tickets: short-lived, single-use, bound to a box, a person and one browser session ───
CREATE TABLE box_shell_tickets (
    id             CHAR(26) PRIMARY KEY,
    -- sha256 of the ticket; the ticket itself is shown once to the browser and never stored
    token_hash     CHAR(64) NOT NULL UNIQUE,
    box_id         CHAR(26) NOT NULL REFERENCES agent_boxes(id) ON DELETE CASCADE,
    user_id        CHAR(26) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- The jti of the cookie session that asked: another session of the same person can't redeem it
    session_jti    VARCHAR(64) NOT NULL,
    generation     INTEGER NOT NULL,
    expires_at     TIMESTAMPTZ NOT NULL,
    used_at        TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_box_shell_tickets_expiry ON box_shell_tickets(expires_at);

ALTER TABLE box_shell_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE box_shell_tickets ENABLE ROW LEVEL SECURITY;
