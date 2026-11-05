-- Codex fetches content from regional *.oaiusercontent.com hosts on its first start (seen live
-- 2026-11-04: three regions, one approval card each). New Codex boxes have the wildcard in their
-- default allowlist (src/lib/boxes/contract.ts); existing ones get it too, unless a box is already
-- at the 200 entries the settings route accepts (the owner adds it there, or on the card).
UPDATE agent_boxes b
   SET allowed_domains = array_append(b.allowed_domains, '*.oaiusercontent.com'), updated_at = NOW()
  FROM agent_profiles p
 WHERE p.id = b.profile_id AND p.adapter = 'codex'
   AND NOT ('*.oaiusercontent.com' = ANY(b.allowed_domains))
   AND cardinality(b.allowed_domains) < 200;
