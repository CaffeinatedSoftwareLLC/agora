-- Self-service account deletion (docs/account-deletion.md).
--
-- What happens to a deleted person's messages is the instance admin's choice:
-- 'anonymize' keeps them with no author, 'remove' deletes them. The default keeps them.
INSERT INTO instance_settings (key, value) VALUES ('accounts.deleted_account_messages', '"anonymize"'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- The last foreign key to users with no ON DELETE action on a table people write to:
-- a workspace command (diff, commit, PR) kept its requester forever, so anyone who had
-- ever asked for one could not be deleted. The command stays; its requester becomes NULL,
-- as for every other "who asked for this" column.
ALTER TABLE agent_workspace_commands ALTER COLUMN requested_by DROP NOT NULL;
ALTER TABLE agent_workspace_commands DROP CONSTRAINT agent_workspace_commands_requested_by_fkey;
ALTER TABLE agent_workspace_commands ADD CONSTRAINT agent_workspace_commands_requested_by_fkey
    FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE SET NULL;
