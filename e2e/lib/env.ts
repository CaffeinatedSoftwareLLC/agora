import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SECRETS_DIR = path.join(E2E_DIR, 'secrets');
export const ARTIFACTS_ROOT = path.join(E2E_DIR, 'artifacts');
export const ENV_FILE = path.join(E2E_DIR, '.env.e2e');

export function readEnvFile(file = ENV_FILE): Record<string, string> {
    if (!fs.existsSync(file)) {
        throw new Error(`${file} not found. Run e2e/up.sh first (it writes the e2e env).`);
    }
    const out: Record<string, string> = {};
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (m) out[m[1]] = m[2];
    }
    return out;
}

export function e2eEnv() {
    const env = readEnvFile();
    const webPort = env.E2E_WEB_PORT ?? '8280';
    const apiPort = env.E2E_API_PORT ?? '3200';
    const baseURL = env.E2E_BASE_URL ?? `http://localhost:${webPort}`;
    // Hard guard: never point the harness at the live stack.
    for (const live of [':3000', ':8080', 'localhost/', ':443', ':80/']) {
        if ((baseURL + '/').includes(live)) throw new Error(`refusing live-looking base URL ${baseURL}`);
    }
    if (['3000', '8080', '80', '443'].includes(webPort) || ['3000', '8080', '80', '443'].includes(apiPort)) {
        throw new Error('refusing live-stack port');
    }
    return { baseURL, apiURL: `http://localhost:${apiPort}`, setupToken: env.AGORA_SETUP_TOKEN, raw: env };
}

export function runId(): string {
    if (!process.env.E2E_RUN_ID) {
        process.env.E2E_RUN_ID = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', 'Z');
    }
    return process.env.E2E_RUN_ID;
}

export function artifactsDir(): string {
    return path.join(ARTIFACTS_ROOT, runId());
}

export function storageStatePath(user: string): string {
    return path.join(SECRETS_DIR, `state-${user}.json`);
}

export const SEED_FILE = path.join(SECRETS_DIR, 'seed.json');
