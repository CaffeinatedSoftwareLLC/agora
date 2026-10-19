-- Voice in and out (cloud handoff C4): push-to-talk voice input in the composer and
-- agent replies read aloud. The engines are ordinary capability routes: `stt`
-- (speech-to-text, new here) and the existing `tts`. This table holds the per-server
-- switches on top of them. With no row, the defaults below apply.

ALTER TABLE ai_capability_routes DROP CONSTRAINT ai_capability_routes_capability_check;
ALTER TABLE ai_capability_routes ADD CONSTRAINT ai_capability_routes_capability_check
    CHECK (capability IN ('chat', 'search', 'image', 'tts', 'video', 'decide', 'stt'));

CREATE TABLE ai_voice_settings (
    server_id                CHAR(26) PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,

    -- Voice input: the `stt` route transcribes when it is on. Without it, browsers
    -- that have the Web Speech API may recognise speech themselves, but Chrome and
    -- Safari send that audio to Google's or Apple's servers, so it is opt-in.
    voice_input_enabled      BOOLEAN NOT NULL DEFAULT true,
    browser_stt_fallback     BOOLEAN NOT NULL DEFAULT false,
    -- Longest recording a member may send, and a language hint (ISO 639-1, e.g. "en")
    max_recording_seconds    SMALLINT NOT NULL DEFAULT 120 CHECK (max_recording_seconds BETWEEN 5 AND 600),
    stt_language             VARCHAR(16) CHECK (stt_language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$'),

    -- Read-aloud: the `tts` route also voices audio overviews, so reading replies
    -- with it is a separate opt-in. Without it, the browser's own (on-device) voices.
    read_aloud_enabled       BOOLEAN NOT NULL DEFAULT true,
    read_aloud_server        BOOLEAN NOT NULL DEFAULT false,
    browser_tts_fallback     BOOLEAN NOT NULL DEFAULT true,
    -- Voice name passed to the `tts` route (Kokoro "af_heart", OpenAI "alloy", Gemini "Kore")
    read_aloud_voice         VARCHAR(64) CHECK (read_aloud_voice ~ '^[A-Za-z0-9_.:+-]{1,64}$'),
    -- Longest text voiced per message; longer replies are cut at a sentence.
    -- OpenAI's speech endpoint takes at most 4096 characters.
    read_aloud_max_chars     INTEGER NOT NULL DEFAULT 1500 CHECK (read_aloud_max_chars BETWEEN 100 AND 4000),

    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_voice_settings TO app_user;
