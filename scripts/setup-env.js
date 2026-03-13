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
    const dbPassword = (await rl.question(`  Database password [${defaultDbPassword}]: `)).trim() || defaultDbPassword;

    let domain = '';
    while (!domain) {
        domain = (await rl.question('  Your domain (e.g., chat.example.com): ')).trim();
        if (!domain) console.log('  Domain is required.\n');
    }
    // Normalize: strip protocol if provided, we'll add https://
    domain = domain.replace(/^https?:\/\//, '');
    const corsOrigin = `https://${domain}`;

    console.log(`\n  Voice channels require LiveKit. Leave blank to skip (voice will be disabled).\n`);
    const livekitKey = (await rl.question('  LiveKit API key (Enter to skip): ')).trim();
    let livekitSecret = '';
    if (livekitKey) {
        livekitSecret = (await rl.question('  LiveKit API secret: ')).trim();
        if (!livekitSecret) {
            console.log('  Warning: LiveKit key provided without secret — voice will not work.');
        }
    }

    rl.close();

    // --- Auto-generated secrets ---

    const generated = {
        DB_PASSWORD: dbPassword,
        JWT_SECRET: hexSecret(),
        MINIO_ROOT_PASSWORD: strongPassword(),
        AGORA_ENCRYPTION_KEY: hexSecret(),
        CORS_ORIGIN: corsOrigin,
        LIVEKIT_API_KEY: livekitKey || 'your-livekit-api-key',
        LIVEKIT_API_SECRET: livekitSecret || 'your-livekit-api-secret',
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

    if (livekitKey && livekitSecret) {
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
    }

    // --- Summary ---

    console.log('\n  =====================================');
    console.log('  Setup complete! Summary:\n');
    console.log(`  Domain:          ${domain}`);
    console.log(`  CORS origin:     ${corsOrigin}`);
    console.log(`  Voice (LiveKit): ${livekitKey ? 'configured' : 'skipped (voice disabled)'}`);
    console.log(`\n  All secrets have been auto-generated and saved to .env.prod.`);
    console.log('\n  Next steps:');
    console.log('  1. Review .env.prod if you want to tweak anything');
    console.log('  2. Point your DNS to your server');
    console.log('  3. Run: docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build');
    console.log('');
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
