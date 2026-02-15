-- Migration 007: Instance configuration table
-- Typed key/value store for instance-level settings

CREATE TABLE instance_config (
    key     VARCHAR(64) PRIMARY KEY,
    value   TEXT NOT NULL
);

-- Seed default configuration
INSERT INTO instance_config (key, value) VALUES
    ('setup_complete', 'false'),
    ('registration_policy', 'open'),
    ('instance_name', 'Agora');
