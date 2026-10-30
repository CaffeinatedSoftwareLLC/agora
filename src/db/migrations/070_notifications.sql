-- Notifications and app push devices (docs/notifications.md).
--
-- The server writes notifications as the service role, in the transaction of the action
-- that caused them; app_user can only read, mark read and delete its own.

CREATE TABLE notifications (
    id          CHAR(26) PRIMARY KEY,
    user_id     CHAR(26) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    server_id   CHAR(26) REFERENCES servers(id) ON DELETE CASCADE,
    channel_id  CHAR(26) REFERENCES channels(id) ON DELETE CASCADE,
    thread_id   CHAR(26) REFERENCES messages(id) ON DELETE CASCADE,
    type        TEXT NOT NULL CHECK (type IN ('approval', 'mention', 'session', 'review', 'collab')),
    -- A short label such as "Approval waiting in #general", never message text
    label       VARCHAR(120) NOT NULL,
    -- A UI path on this instance, e.g. /app/<channelId>?thread=<threadId>
    url         VARCHAR(200) NOT NULL,
    read_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX notifications_user_recent ON notifications (user_id, created_at DESC, id DESC);
CREATE INDEX notifications_user_unread ON notifications (user_id) WHERE read_at IS NULL;

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY notifications_select_own ON notifications FOR SELECT TO app_user
    USING (user_id = current_setting('app.current_user_id', true)::char(26));
CREATE POLICY notifications_update_own ON notifications FOR UPDATE TO app_user
    USING (user_id = current_setting('app.current_user_id', true)::char(26))
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::char(26));
CREATE POLICY notifications_delete_own ON notifications FOR DELETE TO app_user
    USING (user_id = current_setting('app.current_user_id', true)::char(26));
GRANT SELECT, DELETE ON notifications TO app_user;
GRANT UPDATE (read_at) ON notifications TO app_user;

-- One row per user; a missing row means every type on and app push on.
-- types maps a notification type to false when the user switched it off.
CREATE TABLE notification_preferences (
    user_id     CHAR(26) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    types       JSONB NOT NULL DEFAULT '{}'::jsonb,
    app_push    BOOLEAN NOT NULL DEFAULT true,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY notification_preferences_own ON notification_preferences FOR ALL TO app_user
    USING (user_id = current_setting('app.current_user_id', true)::char(26))
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::char(26));
GRANT SELECT, INSERT, UPDATE ON notification_preferences TO app_user;

-- Phones registered for app push through a push relay (mobile-apps.md section 8). The
-- handle is encrypted with AGORA_ENCRYPTION_KEY (src/lib/encryption.ts); handle_hash
-- (SHA-256) finds a re-registration of the same handle without decrypting.
-- instance_origin is the origin the app registered the handle for; it goes in every push.
CREATE TABLE push_devices (
    id               CHAR(26) PRIMARY KEY,
    user_id          CHAR(26) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    relay            VARCHAR(255) NOT NULL,
    instance_origin  VARCHAR(255) NOT NULL,
    handle_enc       TEXT NOT NULL,
    handle_iv        TEXT NOT NULL,
    handle_tag       TEXT NOT NULL,
    handle_hash      CHAR(64) NOT NULL,
    platform         TEXT NOT NULL CHECK (platform IN ('android', 'ios')),
    label            VARCHAR(100) NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_ok_at       TIMESTAMPTZ,
    UNIQUE (relay, handle_hash)
);
CREATE INDEX push_devices_user ON push_devices (user_id);
ALTER TABLE push_devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY push_devices_select_own ON push_devices FOR SELECT TO app_user
    USING (user_id = current_setting('app.current_user_id', true)::char(26));
CREATE POLICY push_devices_delete_own ON push_devices FOR DELETE TO app_user
    USING (user_id = current_setting('app.current_user_id', true)::char(26));
GRANT SELECT, DELETE ON push_devices TO app_user;

-- One pending send per device per notification, written with the notification and
-- drained by the push sender (src/workers/push-sender.ts). Service role only.
CREATE TABLE push_outbox (
    id               CHAR(26) PRIMARY KEY,
    device_id        CHAR(26) NOT NULL REFERENCES push_devices(id) ON DELETE CASCADE,
    notification_id  CHAR(26) NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
    attempts         INTEGER NOT NULL DEFAULT 0,
    next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX push_outbox_due ON push_outbox (next_attempt_at);
ALTER TABLE push_outbox ENABLE ROW LEVEL SECURITY;

-- Push relays devices may register with (https origins). Empty means app push is off.
INSERT INTO instance_settings (key, value) VALUES ('push.allowed_relays', '[]'::jsonb) ON CONFLICT DO NOTHING;
