-- Trust is an explicit owner decision, never inferred from uploader or director status.
ALTER TABLE public.files
    ADD COLUMN trusted_by CHAR(26) REFERENCES public.users(id),
    ADD COLUMN trusted_at TIMESTAMPTZ,
    ADD CONSTRAINT files_trust_pair CHECK ((trusted_by IS NULL) = (trusted_at IS NULL));

-- Owners must be able to update a member's file; existing uploader policies remain.
CREATE POLICY files_owner_trust_update ON public.files
    FOR UPDATE TO app_user
    USING (EXISTS (
        SELECT 1 FROM public.channels c JOIN public.servers s ON s.id = c.server_id
        WHERE c.id = files.channel_id AND s.owner_id = current_setting('app.current_user_id', true)
          AND public.is_server_member(s.id, current_setting('app.current_user_id', true))
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.channels c JOIN public.servers s ON s.id = c.server_id
        WHERE c.id = files.channel_id AND s.owner_id = current_setting('app.current_user_id', true)
          AND public.is_server_member(s.id, current_setting('app.current_user_id', true))
    ));

-- RLS governs rows, not individual columns. An uploader who may bind/delete a file
-- still must not set OR clear trust. Enforce that boundary even for direct app_user SQL.
CREATE FUNCTION public.guard_file_owner_trust() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    actor TEXT := current_setting('app.current_user_id', true);
    owner_id CHAR(26);
    trust_changed BOOLEAN;
BEGIN
    IF TG_OP = 'INSERT' THEN
        trust_changed := NEW.trusted_by IS NOT NULL OR NEW.trusted_at IS NOT NULL;
    ELSE
        trust_changed := NEW.trusted_by IS DISTINCT FROM OLD.trusted_by
            OR NEW.trusted_at IS DISTINCT FROM OLD.trusted_at;
    END IF;
    IF trust_changed THEN
        SELECT s.owner_id INTO owner_id FROM public.channels c JOIN public.servers s ON s.id = c.server_id
            WHERE c.id = CASE WHEN TG_OP = 'INSERT' THEN NEW.channel_id ELSE OLD.channel_id END;
        IF owner_id IS NULL OR owner_id::TEXT IS DISTINCT FROM actor
            OR NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = actor AND NOT u.bot)
            OR NOT public.is_server_member((SELECT c.server_id FROM public.channels c WHERE c.id = NEW.channel_id), actor)
        THEN
            RAISE EXCEPTION 'Only the server owner may change file trust' USING ERRCODE = '42501';
        END IF;
        IF NEW.trusted_by IS NOT NULL AND NEW.trusted_by IS DISTINCT FROM owner_id THEN
            RAISE EXCEPTION 'File trust must identify the server owner' USING ERRCODE = '42501';
        END IF;
        IF TG_OP = 'UPDATE' AND NEW.channel_id IS DISTINCT FROM OLD.channel_id THEN
            RAISE EXCEPTION 'Cannot move a file while changing trust' USING ERRCODE = '42501';
        END IF;
    END IF;
    -- A trust decision covers these exact encrypted bytes and their shared location.
    IF TG_OP = 'UPDATE' AND OLD.trusted_by IS NOT NULL AND (
        NEW.channel_id IS DISTINCT FROM OLD.channel_id OR NEW.message_id IS DISTINCT FROM OLD.message_id
        OR NEW.storage_key IS DISTINCT FROM OLD.storage_key OR NEW.encryption_iv IS DISTINCT FROM OLD.encryption_iv
        OR NEW.encryption_tag IS DISTINCT FROM OLD.encryption_tag
    ) THEN
        NEW.trusted_by := NULL;
        NEW.trusted_at := NULL;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER files_owner_trust_guard BEFORE INSERT OR UPDATE ON public.files
    FOR EACH ROW EXECUTE FUNCTION public.guard_file_owner_trust();
