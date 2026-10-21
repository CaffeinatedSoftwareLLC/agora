-- 060: approving a pending user adds them to the instance server (#158).
--
-- POST /admin/approve-user/:id runs as app_user with the admin's id, and the only INSERT
-- policy on server_members (members_self_insert, 006) lets a user add only themselves, so the
-- approval failed with an RLS error. This function is the one way past that policy: it adds a
-- user to the instance server, and only when the caller (app.current_user_id) is an instance
-- admin and the user is active. The policy itself is not widened.
CREATE OR REPLACE FUNCTION admin_join_instance_server(p_user_id CHAR(26))
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_server_id CHAR(26);
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM users
        WHERE id = current_setting('app.current_user_id', true)::char(26)
          AND is_instance_admin AND account_status = 'active'
    ) THEN
        RAISE EXCEPTION 'only an instance admin may add users to the instance server'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT value INTO v_server_id FROM instance_config WHERE key = 'instance_server_id';
    IF v_server_id IS NULL OR NOT EXISTS (SELECT 1 FROM servers WHERE id = v_server_id) THEN
        RETURN false;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_user_id AND account_status = 'active') THEN
        RAISE EXCEPTION 'user % is not active', p_user_id USING ERRCODE = 'check_violation';
    END IF;

    INSERT INTO server_members (server_id, user_id) VALUES (v_server_id, p_user_id)
    ON CONFLICT DO NOTHING;
    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION admin_join_instance_server(CHAR(26)) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_join_instance_server(CHAR(26)) TO app_user;
