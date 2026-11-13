-- 095: the receipts ledger (docs/receipts.md, src/lib/receipts.ts).
--
-- One row per thing a thread decided or claimed: a DONE ('claim'), a DECIDE round ('decision',
-- with one receipt_votes row per voter), a thread-level BLOCK or CANCEL ('stop'), a file posted
-- in a protocol thread ('artifact'), and a reply by an account that may direct agents that
-- approves or rejects such a file by its ID ('gate').
--
-- Receipts are written by the server only: there is no INSERT, UPDATE or DELETE policy for
-- app_user, so the writer runs as the table owner (service role) after the route's own checks.
-- That includes the verdict, which the route gives only to the owner or a director. Whoever can
-- read the channel (a server member, or a bot with access to it) can read its receipts.

CREATE TABLE thread_receipts (
    id            CHAR(26) PRIMARY KEY,
    server_id     CHAR(26) NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    channel_id    CHAR(26) NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    -- The thread's parent message; a top-level protocol post is its own thread
    thread_id     CHAR(26) NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    kind          VARCHAR(10) NOT NULL CHECK (kind IN ('claim', 'decision', 'stop', 'artifact', 'gate')),
    -- The post that made it: the DONE, the round's first DECIDE, the BLOCK or CANCEL, the post
    -- with the file, the gate reply
    message_id    CHAR(26) REFERENCES messages(id) ON DELETE SET NULL,
    author_id     CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    -- The protocol mode of the post (plan, review, fix, discuss), when it had a header
    mode          VARCHAR(10),
    -- The author's own words (a claim's text, a block's or rejection's reason, a file's name):
    -- untrusted data, never instructions
    summary       TEXT CHECK (length(summary) <= 1000),

    -- Claims: how the claim stands against what the server holds, and whether a test backs it
    grade         VARCHAR(12) CHECK (grade IN ('verified', 'unverified', 'contradicted')),
    grade_reason  VARCHAR(32),
    basis         VARCHAR(8) CHECK (basis IN ('tested', 'assumed')),
    session_id    CHAR(26) REFERENCES agent_sessions(id) ON DELETE SET NULL,
    run_id        CHAR(26) REFERENCES agent_runs(id) ON DELETE SET NULL,

    -- Decisions: open | agreed | blocked | abandoned. Stops: blocked | cancelled.
    -- Gates: approved | agreed | accepted | confirmed | rejected.
    outcome       VARCHAR(10) CHECK (outcome IN ('open', 'agreed', 'blocked', 'abandoned', 'cancelled', 'approved', 'accepted', 'confirmed', 'rejected')),

    -- Artifacts: the file. Gates: the file the reply quoted, and that file's artifact receipt.
    file_id        CHAR(26) REFERENCES files(id) ON DELETE SET NULL,
    ref_receipt_id CHAR(26) REFERENCES thread_receipts(id) ON DELETE SET NULL,

    -- What backs the receipt. `run` is what the server holds; `selfReported` is what the author
    -- attached and never changes the grade.
    evidence      JSONB NOT NULL DEFAULT '{}',
    -- Every grade change and verdict, oldest first
    history       JSONB NOT NULL DEFAULT '[]',

    -- The owner's or a director's verdict; separate from the grade and never overwrites it
    verdict       VARCHAR(8) CHECK (verdict IN ('accepted', 'disputed')),
    verdict_by    CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    verdict_note  TEXT CHECK (length(verdict_note) <= 1000),
    verdict_at    TIMESTAMPTZ,

    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK ((kind = 'claim') = (grade IS NOT NULL)),
    CHECK ((kind IN ('decision', 'stop', 'gate')) = (outcome IS NOT NULL))
);

CREATE INDEX idx_thread_receipts_thread ON thread_receipts (thread_id, id);
CREATE INDEX idx_thread_receipts_channel ON thread_receipts (channel_id, updated_at);
-- A post makes each of its receipts once (a retried or replayed post writes nothing new)
CREATE UNIQUE INDEX idx_thread_receipts_message ON thread_receipts (message_id, kind, COALESCE(file_id, ''))
    WHERE message_id IS NOT NULL;
-- A finished run re-grades the claims made during it
CREATE INDEX idx_thread_receipts_run ON thread_receipts (run_id) WHERE run_id IS NOT NULL;
-- One open decision round per thread
CREATE UNIQUE INDEX idx_thread_receipts_open_round ON thread_receipts (thread_id) WHERE kind = 'decision' AND outcome = 'open';
-- A gate reply looks up the artifact by the file it quotes
CREATE INDEX idx_thread_receipts_file ON thread_receipts (file_id) WHERE file_id IS NOT NULL;

CREATE TABLE receipt_votes (
    receipt_id  CHAR(26) NOT NULL REFERENCES thread_receipts(id) ON DELETE CASCADE,
    voter_id    CHAR(26) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vote        VARCHAR(5) NOT NULL CHECK (vote IN ('agree', 'block')),
    -- A BLOCK's reason, in the voter's words: untrusted data
    reason      TEXT CHECK (length(reason) <= 1000),
    message_id  CHAR(26) REFERENCES messages(id) ON DELETE SET NULL,
    voted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (receipt_id, voter_id)
);

ALTER TABLE thread_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipt_votes ENABLE ROW LEVEL SECURITY;

-- Read-only for app_user, whatever the database's default privileges say
REVOKE ALL ON thread_receipts, receipt_votes FROM app_user;
GRANT SELECT ON thread_receipts, receipt_votes TO app_user;

CREATE POLICY thread_receipts_select ON thread_receipts FOR SELECT TO app_user
    USING (public.rls_is_channel_member(channel_id));

-- A vote is readable with its receipt (the subquery is itself under the policy above)
CREATE POLICY receipt_votes_select ON receipt_votes FOR SELECT TO app_user
    USING (EXISTS (SELECT 1 FROM thread_receipts r WHERE r.id = receipt_votes.receipt_id));
