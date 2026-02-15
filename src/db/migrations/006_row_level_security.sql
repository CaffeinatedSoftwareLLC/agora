-- ============================================================
-- 006_row_level_security.sql
-- Row Level Security policies for defense-in-depth authorization
-- ============================================================

-- Create a non-login role that the application SET ROLEs into.
-- Table owner (accord) bypasses RLS; app_user does not.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
        CREATE ROLE app_user NOLOGIN;
    END IF;
END $$;

-- Grant app_user to the connection role so SET LOCAL ROLE works
GRANT app_user TO current_user;

-- Grant table access to app_user
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;

-- ─── Helper: SECURITY DEFINER to avoid circular RLS lookups ───
CREATE OR REPLACE FUNCTION is_server_member(p_server_id CHAR(26), p_user_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM server_members
        WHERE server_id = p_server_id AND user_id = p_user_id
    );
$$;

-- ═══════════════════════════════════════════════════════════════
-- server_invites — only server members may mint invites
-- ═══════════════════════════════════════════════════════════════
ALTER TABLE server_invites ENABLE ROW LEVEL SECURITY;

CREATE POLICY invite_select ON server_invites
    FOR SELECT TO app_user
    USING (true);  -- anyone can look up an invite code to consume it

CREATE POLICY invite_insert_member ON server_invites
    FOR INSERT TO app_user
    WITH CHECK (
        is_server_member(server_id, current_setting('app.current_user_id', true))
    );

CREATE POLICY invite_update ON server_invites
    FOR UPDATE TO app_user
    USING (true);  -- use_count increment allowed for invite consumption

-- ═══════════════════════════════════════════════════════════════
-- server_members — self-insert only; members can read co-members
-- ═══════════════════════════════════════════════════════════════
ALTER TABLE server_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY members_self_insert ON server_members
    FOR INSERT TO app_user
    WITH CHECK (
        user_id = current_setting('app.current_user_id', true)
    );

CREATE POLICY members_select ON server_members
    FOR SELECT TO app_user
    USING (
        user_id = current_setting('app.current_user_id', true)
        OR is_server_member(server_id, current_setting('app.current_user_id', true))
    );

-- ═══════════════════════════════════════════════════════════════
-- channels — server members can read/create server channels;
--            DM channels (server_id IS NULL) handled separately
-- ═══════════════════════════════════════════════════════════════
ALTER TABLE channels ENABLE ROW LEVEL SECURITY;

CREATE POLICY channels_select ON channels
    FOR SELECT TO app_user
    USING (
        server_id IS NULL
        OR is_server_member(server_id, current_setting('app.current_user_id', true))
    );

CREATE POLICY channels_insert ON channels
    FOR INSERT TO app_user
    WITH CHECK (
        server_id IS NULL
        OR is_server_member(server_id, current_setting('app.current_user_id', true))
    );
