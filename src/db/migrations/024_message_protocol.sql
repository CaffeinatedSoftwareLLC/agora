-- Parsed agora-collab protocol header ({ version, mode, state, yieldTo?, decision?, participants? }).
-- NULL for ordinary messages. Derived from content on insert/edit (src/lib/protocol.ts).
ALTER TABLE messages ADD COLUMN protocol JSONB;
