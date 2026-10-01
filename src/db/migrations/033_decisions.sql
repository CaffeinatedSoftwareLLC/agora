-- Decision model (the `decide` capability; first adapter: TypeSafe Jev). Optional:
-- with no row here, or every switch off, Agora makes no decision calls at all.
-- See docs/planning/jev-wbs.md.

-- ─── Per-server switches, budget shares and thresholds ───
-- One switch per use. A use's share is the part of the `decide` route's daily budget
-- it may spend; shares are not borrowed between uses, so a tagging backfill cannot
-- use up what routing or search screening need. A share of 0 switches the use off.
CREATE TABLE ai_decision_settings (
    server_id                    CHAR(26) PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,

    routing_enabled              BOOLEAN NOT NULL DEFAULT false,
    screening_enabled            BOOLEAN NOT NULL DEFAULT false,
    tagging_enabled              BOOLEAN NOT NULL DEFAULT false,
    ranking_enabled              BOOLEAN NOT NULL DEFAULT false,

    routing_share_pct            SMALLINT NOT NULL DEFAULT 25 CHECK (routing_share_pct BETWEEN 0 AND 100),
    screening_share_pct          SMALLINT NOT NULL DEFAULT 25 CHECK (screening_share_pct BETWEEN 0 AND 100),
    tagging_share_pct            SMALLINT NOT NULL DEFAULT 25 CHECK (tagging_share_pct BETWEEN 0 AND 100),
    ranking_share_pct            SMALLINT NOT NULL DEFAULT 25 CHECK (ranking_share_pct BETWEEN 0 AND 100),

    -- Optional hard request caps per use and day (NULL = none). A route with no
    -- daily limits has nothing to take a share of, so these are what isolates uses there.
    routing_daily_requests       INTEGER CHECK (routing_daily_requests > 0),
    screening_daily_requests     INTEGER CHECK (screening_daily_requests > 0),
    tagging_daily_requests       INTEGER CHECK (tagging_daily_requests > 0),
    ranking_daily_requests       INTEGER CHECK (ranking_daily_requests > 0),

    -- Routing: below this confidence the assistant answers as plain chat
    routing_min_confidence       REAL NOT NULL DEFAULT 0.6 CHECK (routing_min_confidence BETWEEN 0 AND 1),
    -- Search screening: at or above `flag` text is withheld; between `suspect` and `flag` it is marked
    screening_flag_threshold     REAL NOT NULL DEFAULT 0.7 CHECK (screening_flag_threshold BETWEEN 0 AND 1),
    screening_suspect_threshold  REAL NOT NULL DEFAULT 0.35 CHECK (screening_suspect_threshold BETWEEN 0 AND 1),
    -- Strict: a search whose results could not be screened is refused
    screening_strict             BOOLEAN NOT NULL DEFAULT false,
    -- File tagging: a tag applies to a file at or above this probability
    tag_threshold                REAL NOT NULL DEFAULT 0.5 CHECK (tag_threshold BETWEEN 0 AND 1),

    created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (routing_share_pct + screening_share_pct + tagging_share_pct + ranking_share_pct <= 100),
    CHECK (screening_suspect_threshold <= screening_flag_threshold)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_decision_settings TO app_user;

-- ─── Usage ledger: which use a decision call was for ───
-- NULL on every other capability and on rows written before this migration; those
-- count toward the route's total only.
ALTER TABLE ai_usage_events
    ADD COLUMN decision_use VARCHAR(20)
        CHECK (decision_use IN ('routing', 'search_screening', 'file_tagging', 'file_ranking'));

CREATE INDEX idx_ai_usage_decision_use ON ai_usage_events(server_id, capability, decision_use, created_at)
    WHERE decision_use IS NOT NULL;
