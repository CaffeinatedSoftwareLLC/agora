-- Host mode follows the host (docs/agent-boxes.md §10).
-- A profile on a machine host runs unboxed, so it is host mode (owner-only whatever its auth);
-- a box's profile never is. The routes require the owner's hostModeAck for a machine-host
-- profile; this guarantees the flag even for a row written some other way, so the owner-only
-- wake rule (src/lib/provider-terms.ts) never depends on the route alone.

UPDATE agent_profiles p SET host_mode = true
  FROM agent_hosts h
 WHERE h.id = p.host_id AND h.kind = 'machine' AND NOT p.host_mode;

UPDATE agent_profiles p SET host_mode = false
  FROM agent_hosts h
 WHERE h.id = p.host_id AND h.kind = 'box' AND p.host_mode;

-- SECURITY DEFINER: the trigger reads agent_hosts, which app_user may not see under RLS
CREATE OR REPLACE FUNCTION agent_profiles_host_mode_from_host()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    host_kind TEXT;
BEGIN
    SELECT kind INTO host_kind FROM public.agent_hosts WHERE id = NEW.host_id;
    IF host_kind = 'machine' THEN
        NEW.host_mode := true;
    ELSIF host_kind = 'box' THEN
        NEW.host_mode := false;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_agent_profiles_host_mode
    BEFORE INSERT OR UPDATE OF host_id, host_mode ON agent_profiles
    FOR EACH ROW EXECUTE FUNCTION agent_profiles_host_mode_from_host();
