-- Creating a channel now needs ManageChannels (bit 2), which new servers' @everyone
-- role holds by default. Give it to every existing server's @everyone role too, so
-- members keep creating channels. Only the role changes: channel overrides that deny
-- the bit stay as they are. Running it again changes nothing.
UPDATE roles r
   SET permissions = COALESCE(r.permissions, 0) | 4
  FROM servers s
 WHERE r.id = s.everyone_role_id
   AND (COALESCE(r.permissions, 0) & 4) = 0;
