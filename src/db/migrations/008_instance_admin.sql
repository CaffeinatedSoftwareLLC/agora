-- Migration 008: Add instance admin flag to users
ALTER TABLE users ADD COLUMN is_instance_admin BOOLEAN NOT NULL DEFAULT false;
