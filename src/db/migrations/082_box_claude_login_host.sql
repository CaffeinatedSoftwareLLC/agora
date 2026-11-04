-- Claude Code exchanges its login code at platform.claude.com (POST /v1/oauth/token), which the
-- default allowlist of Claude boxes didn't have, so Log in failed at the paste (seen live
-- 2026-11-04). Existing Claude boxes get it like new ones do (src/lib/boxes/contract.ts).
UPDATE agent_boxes b
   SET allowed_domains = array_append(b.allowed_domains, 'platform.claude.com'), updated_at = NOW()
  FROM agent_profiles p
 WHERE p.id = b.profile_id AND p.adapter = 'claude' AND NOT ('platform.claude.com' = ANY(b.allowed_domains));
