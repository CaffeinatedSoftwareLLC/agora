-- Per-account UI preferences (the theme first), so a phone and a PC show the same thing.
-- Written only through PATCH /users/@me/preferences, which accepts known keys only.
ALTER TABLE users ADD COLUMN preferences JSONB NOT NULL DEFAULT '{}'::jsonb;
