-- 098: "Show live output" per agent profile (docs/live-output.md). On by default: the channel sees
-- an agent's text and steps as its run goes. An owner who does not want that turns it off for one
-- agent. Nothing about the stream is stored; this is only the switch.
-- (095 and 096 are taken by open pull requests #377 and #384.)
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS show_live_output BOOLEAN NOT NULL DEFAULT true;
