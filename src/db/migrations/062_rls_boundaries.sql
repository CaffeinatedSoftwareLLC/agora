-- Close the app_user boundaries found by SEC-01.rls-probe (#188).
-- Trusted registration/bootstrap/service work still runs as the table owner.

-- Explicitly put pg_temp last: otherwise a temporary table can shadow a
-- membership table inside these SECURITY DEFINER lookups.
ALTER FUNCTION public.is_server_member(CHAR, TEXT) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.is_bot_channel_member(CHAR, TEXT) SET search_path = pg_catalog, public, pg_temp;
REVOKE ALL ON FUNCTION public.is_server_member(CHAR, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_bot_channel_member(CHAR, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_server_member(CHAR, TEXT) TO app_user;
GRANT EXECUTE ON FUNCTION public.is_bot_channel_member(CHAR, TEXT) TO app_user;

CREATE FUNCTION public.rls_is_channel_member(p_channel_id CHAR(26))
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.channels c
        WHERE c.id = p_channel_id AND c.server_id IS NOT NULL
          AND (
              public.is_server_member(c.server_id, current_setting('app.current_user_id', true))
              OR public.is_bot_channel_member(c.id, current_setting('app.current_user_id', true))
          )
    );
$$;
REVOKE ALL ON FUNCTION public.rls_is_channel_member(CHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rls_is_channel_member(CHAR) TO app_user;

ALTER POLICY invite_select ON public.server_invites
    USING (public.is_server_member(server_id, current_setting('app.current_user_id', true)));
ALTER POLICY invite_insert_member ON public.server_invites
    WITH CHECK (
        creator_id = current_setting('app.current_user_id', true)
        AND public.is_server_member(server_id, current_setting('app.current_user_id', true))
    );
-- A member cannot rewrite limits, expiry, server, creator or counters either.
-- Only the join function below (or trusted owner work) updates use_count.
ALTER POLICY invite_update ON public.server_invites USING (false) WITH CHECK (false);

ALTER POLICY members_self_insert ON public.server_members
    WITH CHECK (
        user_id = current_setting('app.current_user_id', true)
        AND EXISTS (
            SELECT 1 FROM public.servers s
            WHERE s.id = server_members.server_id
              AND s.owner_id = current_setting('app.current_user_id', true)
        )
    );

-- The only app_user join path: possession of one exact code, not a caller
-- supplied user/server ID. The invite lock serializes last-use redemptions.
CREATE FUNCTION public.join_server_by_invite(p_code TEXT)
RETURNS TABLE (server_id CHAR(26), joined BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    actor TEXT := nullif(current_setting('app.current_user_id', true), '');
    invitation public.server_invites%ROWTYPE;
    inserted INTEGER;
BEGIN
    IF actor IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.id = actor AND u.bot = false AND u.account_status = 'active'
    ) THEN
        RETURN;
    END IF;

    SELECT i.* INTO invitation FROM public.server_invites i WHERE i.code = p_code FOR UPDATE;
    IF NOT FOUND THEN RETURN; END IF;

    -- Repeating an already successful join does not consume another use,
    -- including when that first join consumed the last use of the code.
    IF EXISTS (SELECT 1 FROM public.server_members m WHERE m.server_id = invitation.server_id AND m.user_id = actor) THEN
        RETURN QUERY SELECT invitation.server_id, false;
        RETURN;
    END IF;
    IF (invitation.expires_at IS NOT NULL AND invitation.expires_at <= clock_timestamp())
       OR (invitation.max_uses IS NOT NULL AND coalesce(invitation.use_count, 0) >= invitation.max_uses) THEN
        RETURN;
    END IF;

    INSERT INTO public.server_members (server_id, user_id)
        VALUES (invitation.server_id, actor) ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS inserted = ROW_COUNT;
    IF inserted > 0 THEN
        UPDATE public.server_invites i SET use_count = coalesce(i.use_count, 0) + 1 WHERE i.code = p_code;
    END IF;
    RETURN QUERY SELECT invitation.server_id, inserted > 0;
END;
$$;
REVOKE ALL ON FUNCTION public.join_server_by_invite(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.join_server_by_invite(TEXT) TO app_user;

ALTER POLICY channels_select ON public.channels
    USING (server_id IS NOT NULL AND public.is_server_member(server_id, current_setting('app.current_user_id', true)));
ALTER POLICY channels_insert ON public.channels
    WITH CHECK (server_id IS NOT NULL AND public.is_server_member(server_id, current_setting('app.current_user_id', true)));
ALTER POLICY channels_update ON public.channels
    USING (server_id IS NOT NULL AND public.is_server_member(server_id, current_setting('app.current_user_id', true)))
    WITH CHECK (server_id IS NOT NULL AND public.is_server_member(server_id, current_setting('app.current_user_id', true)));
-- channels_bot_select still grants only explicitly assigned bot channels.

ALTER POLICY files_select ON public.files
    USING (
        (channel_id IS NULL AND uploader_id = current_setting('app.current_user_id', true))
        OR EXISTS (
            SELECT 1 FROM public.channels c WHERE c.id = files.channel_id
              AND c.server_id IS NOT NULL
              AND public.is_server_member(c.server_id, current_setting('app.current_user_id', true))
        )
    );
ALTER POLICY files_insert ON public.files
    WITH CHECK (
        uploader_id = current_setting('app.current_user_id', true)
        AND channel_id IS NOT NULL AND public.rls_is_channel_member(channel_id)
    );
ALTER POLICY files_update ON public.files
    USING (
        uploader_id = current_setting('app.current_user_id', true)
        AND (channel_id IS NULL OR public.rls_is_channel_member(channel_id))
    )
    WITH CHECK (
        uploader_id = current_setting('app.current_user_id', true)
        AND channel_id IS NOT NULL AND public.rls_is_channel_member(channel_id)
    );
-- Existing channel-less rows become uploader-only. New rows and updates cannot
-- detach a file. files_bot_select and files_delete keep their existing rules.

-- Match the create route: an active human member may invite their own bot,
-- or any bot when they own/administer its server. DirectAgents is unrelated.
CREATE FUNCTION public.rls_can_create_agent_invite(p_bot_id CHAR(26), p_server_id CHAR(26))
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.users actor
        JOIN public.server_members m ON m.user_id = actor.id AND m.server_id = p_server_id
        JOIN public.servers s ON s.id = m.server_id
        JOIN public.users bot ON bot.id = p_bot_id AND bot.bot = true AND bot.server_id = s.id
        WHERE actor.id = current_setting('app.current_user_id', true)
          AND actor.bot = false AND actor.account_status = 'active'
          AND (
              bot.bot_owner_id = actor.id OR s.owner_id = actor.id
              OR EXISTS (
                  SELECT 1 FROM public.roles r
                  WHERE r.server_id = s.id AND (r.permissions & 1::BIGINT) <> 0
                    AND (r.id = s.everyone_role_id OR EXISTS (
                        SELECT 1 FROM public.member_roles mr
                        WHERE mr.role_id = r.id AND mr.server_id = s.id AND mr.user_id = actor.id
                    ))
              )
          )
    );
$$;
REVOKE ALL ON FUNCTION public.rls_can_create_agent_invite(CHAR, CHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rls_can_create_agent_invite(CHAR, CHAR) TO app_user;
ALTER POLICY agent_invites_creator ON public.agent_invites TO app_user
    USING (created_by = current_setting('app.current_user_id', true)::CHAR(26))
    WITH CHECK (
        created_by = current_setting('app.current_user_id', true)::CHAR(26)
        AND public.rls_can_create_agent_invite(bot_id, server_id)
    );
