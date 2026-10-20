import { chmod, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where Sign in with ChatGPT credentials live: only on this host, never sent to Agora, never
 * logged (docs/codex-chatgpt-plan.md, "Where the tokens are").
 *
 * <dir>/host.json            this host's stable ext_agent_host_id (urn:uuid:…), made once
 * <dir>/profiles/<name>.json one credential record per profile, in OpenAI's documented shape
 *
 * No OS credential-store library is a dependency of the host, so records are files written
 * atomically (temp file + rename) with owner-only permissions: 0600 files in a 0700
 * directory on Linux and macOS. On Windows the mode bits don't apply; the default directory
 * is in the user's profile, which only that user (and administrators) can read.
 */

export const DEFAULT_DIR = join(homedir(), '.agora-host', 'siwc');

export interface CredentialRecord {
    version: 1;
    issuer: string;
    subject: string;
    email?: string;
    /** The issued client id (oaiapp_…), never dynamic_agent_client. */
    client_id: string;
    ext_agent_host_id: string;
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    token_type?: string;
    expires_in?: number;
    /** Epoch ms when the access token expires. */
    expires_at?: number;
    earliest_refresh_at?: string | number;
    scopes: string[];
    saved_at: string;
    /** The Agora user whose plan this is, once Agora has bound it (provider-terms). */
    agora_user_id?: string;
}

/** Only the client registration survives a sign-out (OpenAI: keep the account/client mapping). */
export interface Registration { client_id: string; subject?: string; email?: string }

const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
function profilePath(dir: string, profile: string): string {
    if (!NAME.test(profile)) throw new Error('invalid_profile_name');
    return join(dir, 'profiles', `${profile}.json`);
}

async function ensureDir(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(path, 0o700);
}

/** Write a file atomically with owner-only permissions. */
export async function writeSecret(path: string, data: unknown): Promise<void> {
    const dir = join(path, '..');
    await ensureDir(dir);
    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    const handle = await open(tmp, 'wx', 0o600);
    try {
        await handle.writeFile(JSON.stringify(data, null, 2), 'utf8');
        await handle.sync();
    } finally { await handle.close(); }
    try {
        if (process.platform !== 'win32') await chmod(tmp, 0o600);
        await rename(tmp, path);
    } catch (err) { await unlink(tmp).catch(() => {}); throw err; }
}

async function readJson<T>(path: string): Promise<T | null> {
    try { return JSON.parse(await readFile(path, 'utf8')) as T; }
    catch (err: any) { if (err?.code === 'ENOENT') return null; throw new Error('siwc_store_unreadable'); }
}

/**
 * This host's ext_agent_host_id, made before its first sign-in and reused for every later
 * one, across profiles and accounts. Opaque (a UUIDv4 URN), never user-identifying.
 */
export async function hostId(dir: string): Promise<string> {
    const path = join(dir, 'host.json');
    const existing = await readJson<{ ext_agent_host_id?: string }>(path);
    if (existing?.ext_agent_host_id && /^urn:uuid:[0-9a-f-]{36}$/.test(existing.ext_agent_host_id)) return existing.ext_agent_host_id;
    const id = `urn:uuid:${randomUUID()}`;
    await writeSecret(path, { ext_agent_host_id: id, created_at: new Date().toISOString() });
    return id;
}

export async function readRecord(dir: string, profile: string): Promise<CredentialRecord | null> {
    const r = await readJson<CredentialRecord>(profilePath(dir, profile));
    if (!r) return null;
    if (r.version !== 1 || typeof r.client_id !== 'string' || !Array.isArray(r.scopes)) throw new Error('siwc_store_unreadable');
    return r;
}

export async function writeRecord(dir: string, profile: string, record: CredentialRecord): Promise<void> {
    await writeSecret(profilePath(dir, profile), record);
}

/** Sign out locally: clear the tokens, keep the client registration and identity for a later sign-in. */
export async function clearTokens(dir: string, profile: string): Promise<void> {
    const r = await readRecord(dir, profile);
    if (!r) return;
    const { access_token: _a, refresh_token: _r, id_token: _i, expires_at: _e, expires_in: _x, earliest_refresh_at: _f, ...kept } = r;
    await writeRecord(dir, profile, { ...kept, scopes: [], saved_at: new Date().toISOString() });
}

/** The registration a returning sign-in reuses, saved as soon as the callback issues it. */
export async function saveRegistration(dir: string, profile: string, hostIdValue: string, clientId: string): Promise<void> {
    const r = await readRecord(dir, profile);
    if (r?.client_id === clientId) return;
    await writeRecord(dir, profile, { version: 1, issuer: '', subject: '', client_id: clientId, ext_agent_host_id: hostIdValue, scopes: [], saved_at: new Date().toISOString() });
}

/**
 * Serialise refreshes of one profile's rotating refresh token across processes (the host
 * and `agora-host siwc …`): an exclusive lock file, taken over when older than a minute.
 */
export async function withLock<T>(dir: string, profile: string, fn: () => Promise<T>, waitMs = 30000): Promise<T> {
    const path = `${profilePath(dir, profile)}.lock`;
    await ensureDir(join(path, '..'));
    const deadline = Date.now() + waitMs;
    for (;;) {
        try {
            const h = await open(path, 'wx', 0o600);
            await h.close();
            break;
        } catch (err: any) {
            if (err?.code !== 'EEXIST') throw err;
            const age = await stat(path).then(s => Date.now() - s.mtimeMs).catch(() => 0);
            if (age > 60000) { await unlink(path).catch(() => {}); continue; }
            if (Date.now() > deadline) throw new Error('siwc_lock_timeout');
            await new Promise(r => setTimeout(r, 100));
        }
    }
    try { return await fn(); } finally { await unlink(path).catch(() => {}); }
}
