CREATE TABLE terms_documents (
    id CHAR(26) PRIMARY KEY,
    name VARCHAR(160) NOT NULL,
    provider VARCHAR(20) NOT NULL DEFAULT 'other' CHECK (provider IN ('anthropic','openai','google','other')),
    url TEXT NOT NULL UNIQUE,
    allowed_hosts TEXT[] NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    snapshot_text TEXT,
    snapshot_hash TEXT,
    fetched_at TIMESTAMPTZ,
    checked_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ok','error')),
    error TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE terms_changes (
    id CHAR(26) PRIMARY KEY,
    document_id CHAR(26) NOT NULL REFERENCES terms_documents(id) ON DELETE CASCADE,
    previous_hash TEXT NOT NULL,
    current_hash TEXT NOT NULL,
    diff TEXT NOT NULL,
    summary TEXT NOT NULL,
    impact TEXT NOT NULL CHECK (impact IN ('none','low','review','high')),
    analysis_status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    acknowledged_at TIMESTAMPTZ,
    acknowledged_by CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    notice_id CHAR(26) REFERENCES messages(id) ON DELETE SET NULL
);
CREATE INDEX terms_changes_document_date ON terms_changes(document_id, created_at DESC, id DESC);
ALTER TABLE terms_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE terms_changes ENABLE ROW LEVEL SECURITY;
CREATE POLICY terms_documents_admin ON terms_documents FOR ALL TO app_user
    USING (EXISTS (SELECT 1 FROM users WHERE id = current_setting('app.current_user_id', true)::char(26) AND is_instance_admin))
    WITH CHECK (EXISTS (SELECT 1 FROM users WHERE id = current_setting('app.current_user_id', true)::char(26) AND is_instance_admin));
CREATE POLICY terms_changes_admin ON terms_changes FOR ALL TO app_user
    USING (EXISTS (SELECT 1 FROM users WHERE id = current_setting('app.current_user_id', true)::char(26) AND is_instance_admin))
    WITH CHECK (EXISTS (SELECT 1 FROM users WHERE id = current_setting('app.current_user_id', true)::char(26) AND is_instance_admin));
GRANT SELECT, INSERT, UPDATE, DELETE ON terms_documents, terms_changes TO app_user;
INSERT INTO instance_settings (key, value) VALUES
    ('terms_watch.interval_hours','24'), ('terms_watch.channel_id','null'),
    ('terms_watch.requested','false'), ('terms_watch.last_run_at','null') ON CONFLICT DO NOTHING;

INSERT INTO terms_documents (id, name, provider, url, allowed_hosts) VALUES
    (gen_ulid(), 'Claude Code legal and compliance', 'anthropic', 'https://code.claude.com/docs/en/legal-and-compliance', ARRAY['code.claude.com','www.anthropic.com','anthropic.com']),
    (gen_ulid(), 'Claude Agent SDK overview', 'anthropic', 'https://code.claude.com/docs/en/agent-sdk/overview', ARRAY['code.claude.com','platform.claude.com','docs.claude.com']),
    (gen_ulid(), 'Anthropic consumer terms', 'anthropic', 'https://www.anthropic.com/legal/consumer-terms', ARRAY['www.anthropic.com','anthropic.com']),
    (gen_ulid(), 'Claude Code channels', 'anthropic', 'https://code.claude.com/docs/en/channels', ARRAY['code.claude.com']),
    (gen_ulid(), 'Claude subscription support (15036540)', 'anthropic', 'https://support.claude.com/en/articles/15036540', ARRAY['support.claude.com','support.anthropic.com']),
    (gen_ulid(), 'Codex authentication', 'openai', 'https://learn.chatgpt.com/docs/auth', ARRAY['learn.chatgpt.com','developers.openai.com']),
    (gen_ulid(), 'Codex non-interactive mode', 'openai', 'https://learn.chatgpt.com/docs/non-interactive-mode', ARRAY['learn.chatgpt.com','developers.openai.com']),
    (gen_ulid(), 'Sign in with ChatGPT', 'openai', 'https://learn.chatgpt.com/docs/sign-in-with-chatgpt', ARRAY['learn.chatgpt.com','developers.openai.com']),
    (gen_ulid(), 'OpenAI terms of use', 'openai', 'https://openai.com/policies/terms-of-use/', ARRAY['openai.com','www.openai.com']),
    (gen_ulid(), 'Antigravity terms', 'google', 'https://antigravity.google/terms', ARRAY['antigravity.google','www.antigravity.google']),
    (gen_ulid(), 'Gemini CLI terms and privacy', 'google', 'https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/resources/tos-privacy.md', ARRAY['raw.githubusercontent.com']),
    (gen_ulid(), 'Antigravity headless mode', 'google', 'https://antigravity.google/docs/cli/headless/', ARRAY['antigravity.google','www.antigravity.google']),
    (gen_ulid(), 'Gemini API terms', 'google', 'https://ai.google.dev/gemini-api/terms', ARRAY['ai.google.dev']);
