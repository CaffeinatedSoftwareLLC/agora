#!/usr/bin/env node
/**
 * Generate environment files with auto-generated secrets.
 *
 * Usage:
 *   node scripts/setup-env.js            # Dev: creates .env (no prompts)
 *   node scripts/setup-env.js --prod     # Prod: creates .env.prod (interactive)
 *   node scripts/setup-env.js --force    # Overwrite existing files
 *   node scripts/setup-env.js --prod --no-start   # Write .env.prod only, don't start Docker
 *
 * Dev mode generates random values for:
 *   - POSTGRES_PASSWORD, JWT_SECRET, AGORA_ENCRYPTION_KEY
 *   - DATABASE_URL and TEST_DATABASE_URL are built from POSTGRES_* vars
 *
 * Prod mode auto-generates secrets and prompts for:
 *   - DB_PASSWORD (with auto-generated default)
 *   - DOMAIN (Enter for localhost)
 *   - Writes .env.prod
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const force = process.argv.includes('--force');
const prod = process.argv.includes('--prod');
const noStart = process.argv.includes('--no-start');

const hexSecret = () => crypto.randomBytes(32).toString('hex');
const strongPassword = () => crypto.randomBytes(18).toString('base64url');

// Prompt for a secret without echoing it. On a TTY, typed characters are
// masked with '*'; falls back to a plain line read when input isn't a TTY.
function hiddenQuestion(query) {
    return new Promise((resolve) => {
        const stdin = process.stdin;
        const stdout = process.stdout;
        stdout.write(query);

        if (!stdin.isTTY) {
            let buf = '';
            const onData = (d) => {
                buf += d.toString('utf8');
                const nl = buf.indexOf('\n');
                if (nl !== -1) {
                    stdin.removeListener('data', onData);
                    stdin.pause();
                    resolve(buf.slice(0, nl).replace(/\r$/, ''));
                }
            };
            stdin.resume();
            stdin.on('data', onData);
            return;
        }

        let input = '';
        const wasRaw = stdin.isRaw;
        stdin.setRawMode(true);
        stdin.resume();
        const onData = (chunk) => {
            for (const ch of chunk.toString('utf8')) {
                if (ch === '\r' || ch === '\n') {          // Enter — done
                    stdin.setRawMode(wasRaw);
                    stdin.removeListener('data', onData);
                    stdin.pause();
                    stdout.write('\n');
                    resolve(input);
                    return;
                } else if (ch === '\u0003') {              // Ctrl-C
                    stdin.setRawMode(wasRaw);
                    stdout.write('\n');
                    process.exit(1);
                } else if (ch === '\u007f' || ch === '\b') { // Backspace / DEL
                    if (input.length > 0) { input = input.slice(0, -1); stdout.write('\b \b'); }
                } else if (ch >= ' ') {                    // printable char
                    input += ch;
                    stdout.write('*');
                }
            }
        };
        stdin.on('data', onData);
    });
}

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
        AGORA_ENCRYPTION_KEY: hexSecret(),
    };

    const lines = fs.readFileSync(EXAMPLE, 'utf8').split(/\r?\n/);
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

    if (fs.existsSync(OUT) && !force) {
        console.error('.env.prod already exists. Use --force to overwrite.');
        process.exit(1);
    }
    if (!fs.existsSync(EXAMPLE)) {
        console.error('.env.prod.example not found — run this script from the repo root.');
        process.exit(1);
    }

    console.log('\n  Agora — Production Environment Setup');
    console.log('  =====================================\n');
    console.log('  Auto-generated secrets will be created for you.');
    console.log('  Press Enter at a prompt to accept the auto-generated / default value.\n');

    // --- Prompts ---

    // Password is a secret: read it masked, and never echo the generated
    // default to the console (it still gets written to .env.prod).
    const PASSWORD_PROMPT = '  Database password — press Enter to auto-generate a strong one, or type your own (hidden): ';
    const DOMAIN_PROMPT = '  Domain — hit Enter to skip for local setup or enter your own (e.g., chat.example.com): ';
    const defaultDbPassword = strongPassword();
    let typedDbPassword;
    let typedDomain;

    if (process.stdin.isTTY) {
        typedDbPassword = (await hiddenQuestion(PASSWORD_PROMPT)).trim();

        // Domain is not secret — a normal echoing prompt is fine.
        const { createInterface } = require('node:readline/promises');
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        typedDomain = (await rl.question(DOMAIN_PROMPT)).trim();
        rl.close();
    } else {
        // Piped input (scripts, CI): one answer per line, read up front. Two separate
        // readers on a pipe would lose the second answer to the first reader's buffer.
        let lines = [];
        try { lines = fs.readFileSync(0, 'utf8').split(/\r?\n/); } catch { /* no input: take the defaults */ }
        typedDbPassword = (lines[0] ?? '').trim();
        typedDomain = (lines[1] ?? '').trim();
    }
    const dbPassword = typedDbPassword || defaultDbPassword;
    // Bare host name: Caddy and the compose file both build https://<DOMAIN> from it
    const domain = typedDomain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

    // --- Auto-generated secrets ---

    const generated = {
        DB_PASSWORD: dbPassword,
        JWT_SECRET: hexSecret(),
        AGORA_ENCRYPTION_KEY: hexSecret(),
        DOMAIN: domain,
    };

    // --- Write .env.prod ---

    const lines = fs.readFileSync(EXAMPLE, 'utf8').split(/\r?\n/);
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

    // --- Summary ---

    console.log('\n  =====================================');
    console.log('  Config complete! Summary:\n');
    console.log(`  Domain:          ${domain || '(none — local mode, https://localhost)'}`);
    console.log(`\n  All secrets have been auto-generated and saved to .env.prod.`);

    if (noStart) {
        console.log('\n  --no-start: not starting Docker. Start it with:');
        console.log('  docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build\n');
        return;
    }

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

    const url = domain ? `https://${domain}` : 'https://localhost';

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
