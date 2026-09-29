-- Bot read cursors for threads. Channel cursors (bot_read_cursors) only cover
-- top-level messages; thread replies are tracked per thread parent.
CREATE TABLE bot_thread_cursors (
    bot_id          CHAR(26) REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    thread_id       CHAR(26) REFERENCES messages(id) ON DELETE CASCADE NOT NULL,
    channel_id      CHAR(26) REFERENCES channels(id) ON DELETE CASCADE NOT NULL,
    last_read_id    CHAR(26) NOT NULL,
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (bot_id, thread_id)
);

GRANT SELECT, INSERT, UPDATE ON bot_thread_cursors TO app_user;
