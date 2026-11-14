-- 101: GitHub issue automation (docs/github-issues.md "Automatic import").
-- A rule on the channel's linked repository turns matching issues into task cards, and (a separate
-- opt-in) starts an agent on them. Everything is off unless the owner turns it on. Polling, not
-- webhooks: a worker queues an `issue_scan` for the owner's host, whose `gh` answers it.

-- ─── The rule: columns of the link, so unlinking removes it ───
ALTER TABLE channel_github_repos
    -- off (default) | label (issues carrying import_label) | all (every new open issue)
    ADD COLUMN import_mode        VARCHAR(5) NOT NULL DEFAULT 'off' CHECK (import_mode IN ('off', 'label', 'all')),
    ADD COLUMN import_label       VARCHAR(50) CHECK (import_label ~ '^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,49}$'),
    -- GitHub logins (lower case); empty means any author
    ADD COLUMN import_authors     TEXT[] NOT NULL DEFAULT '{}',
    -- 'all' only takes issues opened after this: turning it on never imports the backlog
    ADD COLUMN import_since       TIMESTAMPTZ,
    -- Off (NULL) or the agent profile started on every card the rule creates
    ADD COLUMN autostart_profile_id CHAR(26) REFERENCES agent_profiles(id) ON DELETE SET NULL,
    -- The owner confirmed the warning for every-issue + no author filter + auto-start
    ADD COLUMN autostart_open_ack BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN poll_minutes       INTEGER NOT NULL DEFAULT 5 CHECK (poll_minutes BETWEEN 2 AND 1440),
    -- Comment the fixed text "Picked up in Agora" on the issue when the rule makes its card
    ADD COLUMN comment_on_pickup  BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN rule_updated_by    CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN rule_updated_at    TIMESTAMPTZ,
    -- When the worker (or Check now) last queued a scan
    ADD COLUMN last_poll_at       TIMESTAMPTZ,
    -- The last time a host answered a scan, how it went (ok, truncated, or a short code), and what it did
    ADD COLUMN last_checked_at    TIMESTAMPTZ,
    ADD COLUMN last_check_status  VARCHAR(40),
    ADD COLUMN last_check_found   INTEGER,
    ADD COLUMN last_check_created INTEGER,
    -- The error code already said in the channel, so one failure is one notice, not one per poll
    ADD COLUMN last_notice_code   VARCHAR(40),
    ADD CONSTRAINT github_rule_label_needed CHECK (import_mode <> 'label' OR import_label IS NOT NULL);

-- A host that polls with `?v=2` knows `issue_scan`; the server offers one only to a host that did so lately
ALTER TABLE agent_hosts ADD COLUMN github_scan_seen_at TIMESTAMPTZ;

ALTER TABLE github_commands DROP CONSTRAINT IF EXISTS github_commands_action_check;
ALTER TABLE github_commands ADD CONSTRAINT github_commands_action_check CHECK (action IN ('issue_list', 'issue_comment', 'issue_scan'));

-- ─── Cards made by a rule, and issues closed on GitHub ───
ALTER TABLE task_cards
    ADD COLUMN from_rule BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN issue_closed_at TIMESTAMPTZ,
    ADD COLUMN issue_state_checked_at TIMESTAMPTZ;

-- ─── Once an issue has become a card in a channel, a rule never makes it again ───
-- The row outlives its card (card_id goes NULL when a person deletes it, which means "do not bring
-- it back"), outlives an unlabel/relabel, and its primary key is what two racing polls collide on.
-- Importing by hand ignores it and updates it.
CREATE TABLE github_issue_imports (
    channel_id   CHAR(26) NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    issue_repo   VARCHAR(140) NOT NULL,   -- lower case
    issue_number INTEGER NOT NULL CHECK (issue_number > 0),
    card_id      CHAR(26) REFERENCES task_cards(id) ON DELETE SET NULL,
    source       VARCHAR(6) NOT NULL CHECK (source IN ('rule', 'manual')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (channel_id, issue_repo, issue_number)
);
ALTER TABLE github_issue_imports ENABLE ROW LEVEL SECURITY;
INSERT INTO github_issue_imports (channel_id, issue_repo, issue_number, card_id, source)
    SELECT channel_id, lower(issue_repo), issue_number, id, 'manual' FROM task_cards WHERE issue_number IS NOT NULL
    ON CONFLICT DO NOTHING;
