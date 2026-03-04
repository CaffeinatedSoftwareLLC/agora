#!/usr/bin/env node
/**
 * Generate a .env file from .env.example with auto-generated secrets.
 *
 * Usage:
 *   node scripts/setup-env.js            # creates .env (fails if exists)
 *   node scripts/setup-env.js --force     # overwrites existing .env
 *
 * Generates random values for:
 *   - POSTGRES_PASSWORD  (random 24-char alphanumeric)
 *   - JWT_SECRET         (random 32-byte hex)
 *   - IP_ENCRYPTION_KEY  (random 32-byte hex)
 *   - AGORA_ENCRYPTION_KEY (random 32-byte hex)
 *
 * DATABASE_URL and TEST_DATABASE_URL are built from POSTGRES_* vars.
 * docker-compose.yml reads the same POSTGRES_* vars, so they stay in sync.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const EXAMPLE = path.join(ROOT, '.env.example');
const OUT = path.join(ROOT, '.env');

const force = process.argv.includes('--force');

if (fs.existsSync(OUT) && !force) {
    console.error('.env already exists. Use --force to overwrite.');
    process.exit(1);
}

if (!fs.existsSync(EXAMPLE)) {
    console.error('.env.example not found — run this script from the repo root.');
    process.exit(1);
}

const hexSecret = () => crypto.randomBytes(32).toString('hex');
const dbPassword = () => crypto.randomBytes(18).toString('base64url'); // 24-char URL-safe

// First pass: collect generated values so DATABASE_URL can reference them
const generated = {
    POSTGRES_PASSWORD: dbPassword(),
    JWT_SECRET: hexSecret(),
    IP_ENCRYPTION_KEY: hexSecret(),
    AGORA_ENCRYPTION_KEY: hexSecret(),
};

const lines = fs.readFileSync(EXAMPLE, 'utf8').split('\n');
const output = [];

// Track the Postgres vars so we can build the URL
let pgUser = 'accord';
let pgDb = 'accord_test';

for (const line of lines) {
    // Preserve comments and blank lines
    if (line.startsWith('#') || line.trim() === '') {
        output.push(line);
        continue;
    }

    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) {
        output.push(line);
        continue;
    }

    const key = line.slice(0, eqIdx);
    const value = line.slice(eqIdx + 1);

    if (generated[key] !== undefined) {
        output.push(`${key}=${generated[key]}`);
    } else if (key === 'POSTGRES_USER') {
        pgUser = value || 'accord';
        output.push(line);
    } else if (key === 'POSTGRES_DB') {
        pgDb = value || 'accord_test';
        output.push(line);
    } else if (key === 'DATABASE_URL' || key === 'TEST_DATABASE_URL') {
        // Build from the individual Postgres vars
        output.push(`${key}=postgres://${pgUser}:${generated.POSTGRES_PASSWORD}@localhost:5432/${pgDb}`);
    } else {
        output.push(line);
    }
}

fs.writeFileSync(OUT, output.join('\n'), 'utf8');
console.log(`Created ${path.relative(ROOT, OUT)} with generated secrets.`);
console.log(`\nPostgres password: ${generated.POSTGRES_PASSWORD}`);
console.log('docker-compose.yml reads POSTGRES_PASSWORD from .env, so everything stays in sync.');
