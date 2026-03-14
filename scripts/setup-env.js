#!/usr/bin/env node
/**
 * Generate environment files with auto-generated secrets.
 *
 * Usage:
 *   node scripts/setup-env.js            # Dev: creates .env (no prompts)
 *   node scripts/setup-env.js --prod     # Prod: creates .env.prod (interactive)
 *   node scripts/setup-env.js --force    # Overwrite existing files
 *
 * Dev mode generates random values for:
 *   - POSTGRES_PASSWORD, JWT_SECRET, IP_ENCRYPTION_KEY, AGORA_ENCRYPTION_KEY
 *   - DATABASE_URL and TEST_DATABASE_URL are built from POSTGRES_* vars
 *
 * Prod mode auto-generates secrets and prompts for:
 *   - DB_PASSWORD (with auto-generated default)
 *   - CORS_ORIGIN / domain (required)
 *   - LiveKit API key + secret (optional — skip to disable voice)
 *   - Writes .env.prod + optionally livekit.prod.yaml
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const force = process.argv.includes('--force');
const prod = process.argv.includes('--prod');

const hexSecret = () => crypto.randomBytes(32).toString('hex');
const strongPassword = () => crypto.randomBytes(18).toString('base64url');

// ---------------------------------------------------------------------------
// Dev mode — zero prompts, same behavior as before
// ---------------------------------------------------------------------------

function setupDev() {
    const EXAMPLE = path.join(ROOT, '.env.example');
    const OUT = path.join(ROOT, '.env');

    if (fs.existsSync(OUT) && !force) {
        console.error('.env already exists. Use --force to overwrite.');
        process.exit(1);
    }
    if (!fs.existsSync(EXAMPLE)) {
        console.error('.env.example not found — run this script from the repo root.');
        process.exit(1);
    }

    const generated = {
        POSTGRES_PASSWORD: strongPassword(),
        JWT_SECRET: hexSecret(),
        IP_ENCRYPTION_KEY: hexSecret(),
        AGORA_ENCRYPTION_KEY: hexSecret(),
    };

    const lines = fs.readFileSync(EXAMPLE, 'utf8').split('\n');
    const output = [];
    let pgUser = 'accord';
    let pgDb = 'accord_test';

    for (const line of lines) {
        if (line.startsWith('#') || line.trim() === '') {
            output.push(line);
            continue;
        }
        const eqIdx = line.indexOf('=');
        if (eqIdx === -1) { output.push(line); continue; }

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
            output.push(`${key}=postgres://${pgUser}:${generated.POSTGRES_PASSWORD}@localhost:5432/${pgDb}`);
        } else {
            output.push(line);
        }
    }

    fs.writeFileSync(OUT, output.join('\n'), 'utf8');
    console.log('Created .env with generated secrets.\n');
    console.log('docker-compose.yml reads POSTGRES_PASSWORD from .env, so everything stays in sync.');
}

// ---------------------------------------------------------------------------
// Prod mode — interactive prompts for user-specific values
// ---------------------------------------------------------------------------

async function setupProd() {
    const EXAMPLE = path.join(ROOT, '.env.prod.example');
    const OUT = path.join(ROOT, '.env.prod');
    const LIVEKIT_YAML = path.join(ROOT, 'livekit.prod.yaml');

    if (fs.existsSync(OUT) && !force) {
        console.error('.env.prod already exists. Use --force to overwrite.');
        process.exit(1);
    }
    if (!fs.existsSync(EXAMPLE)) {
        console.error('.env.prod.example not found — run this script from the repo root.');
        process.exit(1);
    }

    const { createInterface } = require('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    console.log('\n  Agora — Production Environment Setup');
    console.log('  =====================================\n');
    console.log('  Auto-generated secrets will be created for you.');
    console.log('  Press Enter to accept defaults shown in [brackets].\n');

    // --- Prompts ---

    const defaultDbPassword = strongPassword();
    const dbPassword = (await rl.question(`  Database password — hit Enter to accept or enter your own [${defaultDbPassword}]: `)).trim() || defaultDbPassword;

    const domain = (await rl.question('  Domain — hit Enter to skip for local setup or enter your own (e.g., chat.example.com): ')).trim();
    const corsOrigin = domain ? `https://${domain.replace(/^https?:\/\//, '')}` : '';

    const defaultLivekitKey = crypto.randomBytes(16).toString('hex');
    const defaultLivekitSecret = crypto.randomBytes(32).toString('hex');
    const livekitKey = (await rl.question(`  LiveKit API key — hit Enter to accept or enter your own [${defaultLivekitKey}]: `)).trim() || defaultLivekitKey;
    const livekitSecret = (await rl.question(`  LiveKit API secret — hit Enter to accept or enter your own [${defaultLivekitSecret}]: `)).trim() || defaultLivekitSecret;

    rl.close();

    // --- Auto-generated secrets ---

    const generated = {
        DB_PASSWORD: dbPassword,
        JWT_SECRET: hexSecret(),
        MINIO_ROOT_PASSWORD: strongPassword(),
        AGORA_ENCRYPTION_KEY: hexSecret(),
        CORS_ORIGIN: corsOrigin,
        LIVEKIT_API_KEY: livekitKey,
        LIVEKIT_API_SECRET: livekitSecret,
    };

    // --- Write .env.prod ---

    const lines = fs.readFileSync(EXAMPLE, 'utf8').split('\n');
    const output = [];

    for (const line of lines) {
        if (line.startsWith('#') || line.trim() === '') {
            output.push(line);
            continue;
        }
        const eqIdx = line.indexOf('=');
        if (eqIdx === -1) { output.push(line); continue; }

        const key = line.slice(0, eqIdx);

        if (generated[key] !== undefined) {
            output.push(`${key}=${generated[key]}`);
        } else {
            output.push(line);
        }
    }

    fs.writeFileSync(OUT, output.join('\n'), 'utf8');
    console.log(`\n  Created .env.prod`);

    // --- Write livekit.prod.yaml if keys were provided ---

    const yamlContent = [
        '# LiveKit server configuration — keys must match .env.prod',
        '# See https://docs.livekit.io/home/self-hosting/deployment/',
        'port: 7880',
        'rtc:',
        '  use_external_ip: true',
        'keys:',
        `  ${livekitKey}: ${livekitSecret}`,
        '',
    ].join('\n');
    fs.writeFileSync(LIVEKIT_YAML, yamlContent, 'utf8');
    console.log('  Created livekit.prod.yaml');

    // --- Summary ---

    console.log('\n  =====================================');
    console.log('  Config complete! Summary:\n');
    console.log(`  Domain:          ${domain || '(none — local mode)'}`);
    console.log(`  CORS origin:     ${corsOrigin || '(not set — same-origin only)'}`);
    console.log(`  Voice (LiveKit): configured`);
    console.log(`\n  All secrets have been auto-generated and saved to .env.prod.`);

    // --- Build and start Docker ---

    const { spawnSync, execSync } = require('node:child_process');

    console.log('\n  Building and starting Docker containers...');
    console.log('  This may take a few minutes on first run.\n');

    const compose = spawnSync(
        'docker', ['compose', '-f', 'docker-compose.prod.yml', '--env-file', '.env.prod', 'up', '-d', '--build'],
        { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] }
    );

    if (compose.status !== 0) {
        console.error('\n  Docker Compose failed. Check the output above.');
        process.exit(1);
    }

    // --- Wait for API and grab setup token ---

    console.log('\n  Waiting for API to start...');

    const maxAttempts = 30;
    let token = '';
    for (let i = 0; i < maxAttempts; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
            const logs = execSync('docker logs agora-api-1 2>&1', { cwd: ROOT, encoding: 'utf8' });
            const match = logs.match(/AGORA SETUP TOKEN[^]*?\n\s+([a-f0-9]{64})/);
            if (match) {
                token = match[1];
                break;
            }
        } catch { /* container not ready yet */ }
    }

    const url = domain ? `https://${domain}` : 'http://localhost';

    console.log('\n  =====================================');
    if (token) {
        console.log('  Agora is running!\n');
        console.log(`  Setup token: ${token}\n`);
        console.log(`  Open ${url} and paste the token to complete setup.`);
    } else {
        console.log('  Agora is starting but the setup token was not found yet.');
        console.log('  Check manually with: docker logs agora-api-1 2>&1 | grep -A 2 "SETUP TOKEN"');
    }
    console.log('  =====================================\n');

    // --- Done — user opens browser themselves ---
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (prod) {
    setupProd().catch((err) => {
        console.error(err);
        process.exit(1);
    });
} else {
    setupDev();
}
