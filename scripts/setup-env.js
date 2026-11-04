#!/usr/bin/env node
/**
 * Generate environment files with auto-generated secrets.
 *
 * Usage:
 *   node scripts/setup-env.js            # Dev: creates .env (no prompts)
 *   node scripts/setup-env.js --prod     # Prod: creates .env.prod (interactive; asks before starting)
 *   node scripts/setup-env.js --force    # Overwrite existing files
 *   node scripts/setup-env.js --prod --start      # Write .env.prod, then build and start the stack
 *   node scripts/setup-env.js --prod --non-interactive [--instance agora2] [--domain x]
 *        [--http-port 8080] [--https-port 8443] [--api-port 3001] [--telemetry on|off]
 *
 * Prod never starts Docker unless asked (--start, or "y" at the prompt; #209). It picks an
 * instance name (AGORA_INSTANCE, also COMPOSE_PROJECT_NAME) and ports that no other Agora
 * install on this Docker engine uses, so a second install doesn't collide with the first.
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
// Prod mode — prompts for user-specific values, picks a free instance name and ports
// ---------------------------------------------------------------------------

/** A flag's value: `--name value` or `--name=value`. */
function flag(name) {
    const args = process.argv;
    const i = args.indexOf(`--${name}`);
    if (i !== -1 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
    const eq = args.find(a => a.startsWith(`--${name}=`));
    return eq ? eq.slice(name.length + 3) : undefined;
}

const INSTANCE_RE = /^[a-z][a-z0-9-]{0,30}$/;

/** Run a command and return its stdout, or null when it fails or isn't installed. */
function capture(cmd, args) {
    const { spawnSync } = require('node:child_process');
    const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return r.status === 0 ? r.stdout : null;
}

/** Does this Docker engine already have anything of install `name` (#209)? */
function instanceInUse(name) {
    const containers = capture('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${name}`]);
    const volumes = capture('docker', ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${name}`]);
    const network = capture('docker', ['network', 'ls', '-q', '--filter', `name=^${name}_sandbox$`]);
    return [containers, volumes, network].some(out => out && out.trim() !== '');
}

/** Can this machine accept connections on `port`? Checked on every interface, as Docker publishes. */
function portFree(port) {
    const net = require('node:net');
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.listen({ port, host: '0.0.0.0' }, () => server.close(() => resolve(true)));
    });
}

/** The first free port from `start`, stepping by `step`, skipping `taken`. */
async function freePort(start, step, taken) {
    for (let port = start, i = 0; i < 50; port += step, i++) {
        if (!taken.has(port) && await portFree(port)) { taken.add(port); return port; }
    }
    throw new Error(`No free port found from ${start}`);
}

function dockerGid() {
    if (process.platform !== 'linux') return undefined;
    const line = capture('getent', ['group', 'docker']);
    const gid = line && line.split(':')[2];
    return gid && /^\d+$/.test(gid.trim()) ? gid.trim() : undefined;
}

async function setupProd() {
    const EXAMPLE = path.join(ROOT, '.env.prod.example');
    const OUT = path.join(ROOT, '.env.prod');
    const interactive = process.stdin.isTTY && !process.argv.includes('--non-interactive');

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
    let typedDbPassword = '';
    let typedDomain = flag('domain') ?? '';
    let rl;

    if (interactive) {
        typedDbPassword = (await hiddenQuestion(PASSWORD_PROMPT)).trim();
        // Domain is not secret — a normal echoing prompt is fine.
        const { createInterface } = require('node:readline/promises');
        rl = createInterface({ input: process.stdin, output: process.stdout });
        if (flag('domain') === undefined) typedDomain = (await rl.question(DOMAIN_PROMPT)).trim();
    } else if (!process.stdin.isTTY) {
        // Piped input (scripts, CI): one answer per line, read up front. Two separate
        // readers on a pipe would lose the second answer to the first reader's buffer.
        let lines = [];
        try { lines = fs.readFileSync(0, 'utf8').split(/\r?\n/); } catch { /* no input: take the defaults */ }
        typedDbPassword = (lines[0] ?? '').trim();
        if (flag('domain') === undefined) typedDomain = (lines[1] ?? '').trim();
    }
    const dbPassword = typedDbPassword || defaultDbPassword;
    // Bare host name: Caddy and the compose file both build https://<DOMAIN> from it
    const domain = typedDomain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

    // --- Instance name and ports (#209): a second install on this engine gets its own ---

    let instance = flag('instance');
    if (instance !== undefined && !INSTANCE_RE.test(instance)) {
        console.error('  --instance must be lowercase letters, digits and dashes, starting with a letter.');
        process.exit(1);
    }
    if (instance === undefined) {
        instance = 'agora';
        for (let n = 2; instanceInUse(instance); n++) instance = `agora${n}`;
        if (instance !== 'agora') console.log(`  This Docker engine already has an Agora install named "agora"; this one is "${instance}".`);
    } else if (instanceInUse(instance)) {
        console.log(`  Note: this Docker engine already has containers, volumes or a network of an install named "${instance}".`);
        console.log('  Starting will reuse them. Pick another --instance for a separate install.');
    }
    const taken = new Set();
    const pickPort = async (name, def, step) => {
        const given = flag(name);
        if (given !== undefined) {
            if (!/^\d+$/.test(given) || Number(given) < 1 || Number(given) > 65535) { console.error(`  --${name} must be a port number.`); process.exit(1); }
            taken.add(Number(given));
            return Number(given);
        }
        return freePort(def, step, taken);
    };
    const httpPort = await pickPort('http-port', 80, 8000);
    const httpsPort = await pickPort('https-port', 443, 8000);
    const apiPort = await pickPort('api-port', 3000, 1);

    // --- Auto-generated secrets ---

    const host = domain || 'localhost';
    const generated = {
        COMPOSE_PROJECT_NAME: instance,
        AGORA_INSTANCE: instance,
        DB_PASSWORD: dbPassword,
        JWT_SECRET: hexSecret(),
        AGORA_ENCRYPTION_KEY: hexSecret(),
        DOMAIN: domain,
        AGORA_HTTP_PORT: String(httpPort),
        AGORA_HTTPS_PORT: String(httpsPort),
        AGORA_API_PORT: String(apiPort),
    };
    const gid = dockerGid();
    if (gid) generated.DOCKER_GID = gid;
    const telemetry = flag('telemetry');
    if (telemetry === 'on' || telemetry === 'off') generated.AGORA_TELEMETRY = telemetry;
    // The browser's origin includes the port when it isn't 443
    const extra = {};
    if (httpsPort !== 443) extra.CORS_ORIGIN = `https://${host}:${httpsPort}`;

    // --- Write .env.prod ---

    const lines = fs.readFileSync(EXAMPLE, 'utf8').split(/\r?\n/);
    const output = [];
    const written = new Set();

    for (const line of lines) {
        // A commented default (`# CORS_ORIGIN=...`) becomes a real line when we set it
        const commented = /^#\s?([A-Z][A-Z0-9_]*)=/.exec(line);
        if (commented && extra[commented[1]] !== undefined && !written.has(commented[1])) {
            output.push(`${commented[1]}=${extra[commented[1]]}`);
            written.add(commented[1]);
            continue;
        }
        if (line.startsWith('#') || line.trim() === '') {
            output.push(line);
            continue;
        }
        const eqIdx = line.indexOf('=');
        if (eqIdx === -1) { output.push(line); continue; }

        const key = line.slice(0, eqIdx);
        const value = generated[key] ?? extra[key];
        if (value !== undefined) {
            output.push(`${key}=${value}`);
            written.add(key);
        } else {
            output.push(line);
        }
    }
    for (const [key, value] of Object.entries({ ...generated, ...extra })) {
        if (!written.has(key)) output.push(`${key}=${value}`);
    }

    fs.writeFileSync(OUT, output.join('\n'), { encoding: 'utf8', mode: 0o600 });
    console.log(`\n  Created .env.prod`);

    // --- Summary ---

    const url = `https://${host}${httpsPort === 443 ? '' : `:${httpsPort}`}`;
    const compose = ['compose', '-f', 'docker-compose.prod.yml', '--env-file', '.env.prod'];
    const upCommand = `docker ${compose.join(' ')} up -d --build`;
    console.log('\n  =====================================');
    console.log('  Config complete! Summary:\n');
    console.log(`  Instance:        ${instance}`);
    console.log(`  Domain:          ${domain || '(none — local mode)'}`);
    console.log(`  Browser:         ${url}`);
    console.log(`  Agents (local):  http://localhost:${apiPort}`);
    if (!gid && process.platform === 'linux') console.log('  DOCKER_GID:      not found; set it to `getent group docker | cut -d: -f3` before starting');
    console.log(`\n  All secrets have been auto-generated and saved to .env.prod.`);

    // --- Start? Only when asked (#209: writing the config used to start the stack too) ---

    let start = process.argv.includes('--start');
    if (!start && !noStart && interactive) {
        const answer = (await rl.question('\n  Start the stack now? [y/N] ')).trim().toLowerCase();
        start = answer === 'y' || answer === 'yes';
    }
    if (rl) rl.close();

    if (!start) {
        console.log('\n  Not starting Docker. Start it with:');
        console.log(`  ${upCommand}\n`);
        return;
    }

    // --- Build and start Docker ---

    const { spawnSync } = require('node:child_process');
    // Anything that existed before this start must survive a cleanup after a failed one
    const hadVolumes = (capture('docker', ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${instance}`]) ?? '').trim() !== '';

    console.log('\n  Building and starting Docker containers...');
    console.log('  This may take a few minutes on first run.\n');

    const up = spawnSync('docker', [...compose, 'up', '-d', '--build'], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });

    if (up.status !== 0) {
        console.error('\n  Docker Compose failed. Check the output above.');
        console.error('  Removing what this start created...');
        const downArgs = [...compose, 'down', '--remove-orphans', ...(hadVolumes ? [] : ['-v'])];
        const down = spawnSync('docker', downArgs, { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
        if (down.status === 0) console.error(`  Removed the containers${hadVolumes ? ' (volumes from before this start were kept)' : ' and volumes'}. Fix the problem above, then run:\n  ${upCommand}`);
        else console.error(`  Cleanup failed too. Remove it by hand with:\n  docker ${downArgs.join(' ')}`);
        process.exit(1);
    }

    // --- Wait for API and grab setup token ---

    console.log('\n  Waiting for API to start...');

    const maxAttempts = 30;
    let token = '';
    for (let i = 0; i < maxAttempts; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const logs = capture('docker', [...compose, 'logs', 'api']);
        const match = logs && logs.match(/AGORA SETUP TOKEN[^]*?\n[^\n]*?([a-f0-9]{64})/);
        if (match) {
            token = match[1];
            break;
        }
    }

    console.log('\n  =====================================');
    if (token) {
        console.log('  Agora is running!\n');
        console.log(`  Setup token: ${token}\n`);
        console.log(`  Open ${url} and paste the token to complete setup.`);
    } else {
        console.log('  Agora is starting but the setup token was not found yet.');
        console.log(`  Check manually with: docker ${compose.join(' ')} logs api | grep -A 2 "SETUP TOKEN"`);
    }
    console.log('  =====================================\n');
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
