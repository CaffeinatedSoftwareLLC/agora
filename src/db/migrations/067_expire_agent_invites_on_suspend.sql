-- Suspending an account expires the unredeemed agent invites of the account (if it is a
-- bot) and of every bot it owns. app_user may only read and create its own invites, so the
-- admin ban handler calls this instead. It acts only for an instance admin and only on an
-- account that is no longer active.
CREATE FUNCTION public.expire_agent_invites_for_suspended(p_target CHAR(26))
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    expired INTEGER;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.users
        WHERE id = current_setting('app.current_user_id', true) AND is_instance_admin AND NOT bot
    ) THEN
        RAISE EXCEPTION 'Only an instance admin may expire agent invites' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM public.users WHERE id = p_target AND account_status = 'active') THEN
        RAISE EXCEPTION 'The account is still active' USING ERRCODE = '42501';
    END IF;
    UPDATE public.agent_invites SET expires_at = clock_timestamp()
    WHERE redeemed_at IS NULL AND expires_at > clock_timestamp()
      AND bot_id IN (SELECT id FROM public.users WHERE bot AND (id = p_target OR bot_owner_id = p_target));
    GET DIAGNOSTICS expired = ROW_COUNT;
    RETURN expired;
END;
$$;
REVOKE ALL ON FUNCTION public.expire_agent_invites_for_suspended(CHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expire_agent_invites_for_suspended(CHAR) TO app_user;
