-- 076: the age cap for a bot's first attention read in a channel (#327 follow-up).
-- Set once, when the cursor is created without an explicit `after`: attention whose
-- created_at is older than this is never delivered (24 hours before first use). Fixed for the
-- cursor's life, so acknowledging one page never hides the next. NULL (explicit `after`, and
-- every cursor made before this migration) means no age cap.
ALTER TABLE bot_attention_cursors ADD COLUMN replay_from TIMESTAMPTZ;
