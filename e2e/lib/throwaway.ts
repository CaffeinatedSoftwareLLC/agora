/**
 * Throwaway users and instance-setting guards for the specs that change instance-wide state
 * (registration policy, file limits, bans, login locks).
 *
 * Registration is limited to 5 per hour per address, so every registration a spec makes goes
 * through `registerThrowaway` (or the UI, then `noteRegistration`), which counts it and adds a
 * `registered` annotation to the test, so a run's registrations can be read from its results.
 * Throwaway users are run-tagged and are never one of the shared e2e users
 * (owner-e2e, member-e2e, director-e2e, admin-e2e, outsider-e2e, fkdirector-e2e): bans have no
 * undo (there is no unban endpoint) and a login lock lasts 15 minutes.
 */
import crypto from 'node:crypto';
import { test } from '@playwright/test';
import { Api } from './api';
import { e2eEnv } from './env';
import type { Seed } from './seed-types';

export type Policy = 'open' | 'invite_only' | 'approval';

export interface Throwaway { id: string; username: string; email: string; password: string; status: 'active' | 'pending' }

const anon = () => new Api(e2eEnv().apiURL);

/** A run-tagged username, unique within the run. Max 32 chars (the register schema). */
export function throwawayName(seed: Seed, prefix: string) {
    return `${prefix}-${seed.runTag}-${crypto.randomBytes(2).toString('hex')}`.slice(0, 32);
}

/**
 * The throwaway's password, derived from its username and E2E_OWNER_PASSWORD (HMAC), so a later
 * test in the same run (even in a restarted worker) can log in as it without storing anything.
 * It stays in memory and is only sent in login/register requests.
 */
export function throwawayPassword(username: string) {
    const base = e2eEnv().raw.E2E_OWNER_PASSWORD;
    if (!base) throw new Error('.env.e2e lacks E2E_OWNER_PASSWORD');
    return 'tw-' + crypto.createHmac('sha256', base).update(`agora-e2e-throwaway:${username}`).digest('base64url').slice(0, 24);
}

/** Record a registration made by this test (API or UI). */
export function noteRegistration(username: string) {
    test.info().annotations.push({ type: 'registered', description: username });
}

/** Register a throwaway user through the API under whatever policy is current. */
export async function registerThrowaway(seed: Seed, prefix: string): Promise<Throwaway> {
    const username = throwawayName(seed, prefix);
    const email = `${username}@example.test`;
    const password = throwawayPassword(username);
    const r = await anon().req('POST', '/auth/register', { username, email, password });
    if (r.status === 429) throw new Error(`registering ${username}: rate limited (5 registrations per hour per address); rerun later`);
    if (r.status !== 201) throw new Error(`registering ${username} -> ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    noteRegistration(username);
    return { id: String(r.data.user.id).trim(), username, email, password, status: r.data.status === 'pending' ? 'pending' : 'active' };
}

/**
 * An active throwaway this run already registered with `prefix` (found by the admin user search),
 * or null. Lets a later test reuse it instead of spending another registration.
 */
export async function findThrowaway(owner: Api, seed: Seed, prefix: string, status: 'active' | 'pending' = 'active'): Promise<Throwaway | null> {
    const stem = `${prefix}-${seed.runTag}-`;
    const r = (await owner.ok('GET', `/admin/users?limit=100&status=${status}&search=${encodeURIComponent(stem)}`)) as any;
    const row = (r.users as any[]).find(u => u.username.startsWith(stem));
    if (!row) return null;
    return { id: row.id, username: row.username, email: row.email, password: throwawayPassword(row.username), status };
}

/** POST /auth/login through the API (Bearer flow): status, error code, token and Retry-After. */
export async function loginStatus(login: string, password: string) {
    const res = await fetch(`${e2eEnv().apiURL}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login, password }),
    });
    const data: any = await res.json().catch(() => ({}));
    return { status: res.status, error: data?.error as string | undefined, token: data?.accessToken as string | undefined, retryAfter: res.headers.get('retry-after') };
}

export async function currentPolicy(): Promise<Policy> {
    return ((await anon().ok('GET', '/instance/status')) as any).registrationPolicy;
}

/** Set the registration policy and read it back. */
export async function setPolicy(owner: Api, policy: Policy) {
    await owner.ok('PATCH', '/admin/instance', { registrationPolicy: policy });
    const now = await currentPolicy();
    if (now !== policy) throw new Error(`registration policy read back as ${now}, wanted ${policy}`);
}

/**
 * Run `fn` with the registration policy at `policy`, then put back whatever it was before,
 * even when `fn` throws. The original is read first and the restore is read back.
 */
export async function withPolicy<T>(owner: Api, policy: Policy, fn: () => Promise<T>): Promise<T> {
    const original = await currentPolicy();
    test.info().annotations.push({ type: 'setting', description: `registration_policy ${original} -> ${policy} (restored after)` });
    try {
        await setPolicy(owner, policy);
        return await fn();
    } finally {
        await setPolicy(owner, original);
    }
}

export const FILE_SETTING_KEYS = ['files.max_size_bytes', 'files.allowed_extensions', 'files.retention_days', 'files.storage_quota_bytes', 'files.exif_strip'] as const;

export async function fileSettings(owner: Api): Promise<Record<string, unknown>> {
    return owner.ok('GET', '/admin/settings/files');
}

/**
 * Put back every file setting that differs from `original`, one key at a time (one bad key
 * can't block the others), then check the read-back matches. A null original is never sent:
 * PATCH /admin/settings/files stores null as 0 (Ajv coercion inside the schema's oneOf), so
 * a changed null setting can't be restored through the API and is reported instead.
 */
export async function restoreFileSettings(owner: Api, original: Record<string, unknown>) {
    const now = await fileSettings(owner);
    const problems: string[] = [];
    for (const k of FILE_SETTING_KEYS) {
        if (!(k in original) || JSON.stringify(now[k]) === JSON.stringify(original[k])) continue;
        if (original[k] === null) { problems.push(`${k} is ${JSON.stringify(now[k])}, was null (not restorable through the API)`); continue; }
        const r = await owner.req('PATCH', '/admin/settings/files', { [k]: original[k] });
        if (r.status !== 200) problems.push(`restoring ${k} -> ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    }
    const back = await fileSettings(owner);
    for (const k of FILE_SETTING_KEYS) {
        if (JSON.stringify(back[k]) !== JSON.stringify(original[k]) && !problems.some(p => p.startsWith(k))) {
            problems.push(`${k} read back as ${JSON.stringify(back[k])}, wanted ${JSON.stringify(original[k])}`);
        }
    }
    if (problems.length) throw new Error(`file settings not restored: ${problems.join('; ')}`);
}
