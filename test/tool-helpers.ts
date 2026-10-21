import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client, Pool } from 'pg';
import { runMigrations } from '../src/db/migrate';

/**
 * Helpers for tests that run the operator CLI tools (src/tools/*) as child processes.
 * Each such test gets its own throwaway database, named after the test DB plus a suffix,
 * so a tool that walks every row never sees data from other test files.
 */

export const REPO_ROOT = path.resolve(__dirname, '..');

function baseUrl(): URL {
    return new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://accord:accord@localhost:5432/accord_test');
}

function adminUrl(): string {
    const url = baseUrl();
    url.pathname = '/postgres';
    return url.toString();
}

/** Create (or recreate) `<test db>_<suffix>`, migrate it, and return its URL. */
export async function createPrivateDb(suffix: string): Promise<string> {
    const url = baseUrl();
    const name = `${url.pathname.slice(1)}_${suffix}`;
    if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`bad database name ${name}`);
    const admin = new Client({ connectionString: adminUrl() });
    await admin.connect();
    try {
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        await admin.query(`CREATE DATABASE ${name}`);
    } finally {
        await admin.end();
    }
    url.pathname = `/${name}`;
    const pool = new Pool({ connectionString: url.toString() });
    try {
        await runMigrations(pool);
    } finally {
        await pool.end();
    }
    return url.toString();
}

export async function dropPrivateDb(dbUrl: string): Promise<void> {
    const name = new URL(dbUrl).pathname.slice(1);
    const admin = new Client({ connectionString: adminUrl() });
    await admin.connect();
    try {
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
        await admin.end();
    }
}

export interface ToolResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

/**
 * Run a TypeScript entrypoint the way `npm run <tool>` does (tsx), but as a direct node
 * child so killing it really stops it. `env` is layered over a copy of process.env with
 * the connection settings tests must never inherit removed.
 */
export function startTool(script: string, env: Record<string, string>): { child: ReturnType<typeof spawn>; done: Promise<ToolResult> } {
    const base = { ...process.env };
    for (const k of ['DATABASE_URL', 'TEST_DATABASE_URL', 'STORAGE_DIR', 'STORAGE_DRIVER', 'AGORA_ENCRYPTION_KEY', 'AGORA_NEW_ENCRYPTION_KEY',
        'S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_BUCKET', 'S3_REGION', 'MINIO_ENDPOINT', 'MINIO_ROOT_USER', 'MINIO_ROOT_PASSWORD',
        'PORT', 'HOST', 'AGORA_ACCEPT_NEW_ENCRYPTION_KEY']) delete base[k];
    const child = spawn(process.execPath, ['--import', 'tsx', script], {
        cwd: REPO_ROOT,
        env: { ...base, NODE_ENV: 'test', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', d => { stdout += d; });
    child.stderr!.on('data', d => { stderr += d; });
    const done = new Promise<ToolResult>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    return { child, done };
}

export function runTool(script: string, env: Record<string, string>): Promise<ToolResult> {
    return startTool(script, env).done;
}

/** Every path under `root`, relative, with forward slashes. */
export async function listTree(root: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string) => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) await walk(full);
            else out.push(path.relative(root, full).split(path.sep).join('/'));
        }
    };
    await walk(root);
    return out.sort();
}
