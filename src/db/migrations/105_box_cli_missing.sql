-- A box image built without one of its CLIs (the vendor's pinned download was not available, box/agora-optional-cli):
-- agora-host in the box reports it, Settings shows it and starting that agent is refused (docs/agent-boxes.md §6.1).
ALTER TABLE agent_boxes ADD COLUMN cli_missing_code VARCHAR(24);
ALTER TABLE agent_boxes ADD COLUMN cli_missing_detail VARCHAR(200);
