-- 014: Add system_event column to messages for call history (missed, declined, ended)
ALTER TABLE messages ADD COLUMN system_event VARCHAR(50);
