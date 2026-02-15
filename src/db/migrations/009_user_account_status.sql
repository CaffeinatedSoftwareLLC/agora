-- Migration 009: Add account_status column to users
-- Supports registration policies: open (active), approval (pending), suspended
ALTER TABLE users ADD COLUMN account_status VARCHAR(20) NOT NULL DEFAULT 'active';
ALTER TABLE users ADD CONSTRAINT users_account_status_check CHECK (account_status IN ('active', 'pending', 'suspended'));
