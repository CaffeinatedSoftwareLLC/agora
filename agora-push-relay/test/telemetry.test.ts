import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PROBLEM_MAX_BYTES, pruneProblems } from '../src/telemetry.js';
import { PgTelemetryStore, SqliteTelemetryStore, type TelemetryStore } from '../src/telemetry-store.js';
import { PG_URL } from './backends.js';
import { makeRelay, type TestRelay } from './helpers.js';

// docs/telemetry.md and docs/agent-boxes.md §12.4–12.5.
const ADMIN = 'a'.repeat(40);
const IP = '198.51.100.77';
const UA = 'UA-CANARY-curl/8.5.0-4e1d';
const INSTALL = { result: 'failed', step: 'docker.install', version: '0.9.0', os: 'ubuntu', osVersion: '24.04' };

let relay: TestRelay;
let telemetry: TelemetryStore;
let dir: string;

beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'agora-telemetry-'));
    telemetry = new SqliteTelemetryStore(join(dir, 'telemetry.db'));
    relay = await makeRelay({ telemetry: { store: telemetry, adminToken: ADMIN, problemsPerMinute: 5, maxStoredBytes: 2 * PROBLEM_MAX_BYTES } });
});
afterEach(async () => {
    await relay.close();
    await telemetry.close();
    rmSync(dir, { recursive: true, force: true });
});

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
    relay.app.inject({ method: 'POST', url, remoteAddress: IP, headers: { 'user-agent': UA, ...headers }, payload: payload as object });
const get = (url: string, token: string | null = ADMIN) =>
    relay.app.inject({ method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {} });

describe('POST /telemetry/v1/install', () => {
    it('204, and only the five fields and the date are stored', async () => {
        expect((await post('/telemetry/v1/install', INSTALL)).statusCode).toBe(204);
        expect((await post('/telemetry/v1/install', { ...INSTALL, result: 'ok', step: null })).statusCode).toBe(204);
        const res = await get('/telemetry/v1/installs');
        expect(res.statusCode).toBe(200);
        expect(res.json().installs).toEqual(expect.arrayContaining([
            { day: '2026-10-24', result: 'failed', step: 'docker.install', version: '0.9.0', os: 'ubuntu', osVersion: '24.04', count: 1 },
            { day: '2026-10-24', result: 'ok', step: null, version: '0.9.0', os: 'ubuntu', osVersion: '24.04', count: 1 },
        ]));
    });

    it('400 for an extra key, a missing key, a wrong type or a malformed step', async () => {
        for (const body of [
            { ...INSTALL, hostname: 'my-laptop' },
            { ...INSTALL, ip: '10.0.0.1' },
            { result: 'ok', step: null, version: '1', os: 'ubuntu' },
            { ...INSTALL, result: 'maybe' },
            { ...INSTALL, step: 'Has Spaces' },
            { ...INSTALL, step: 3 },
            { ...INSTALL, version: 'x'.repeat(65) },
            { ...INSTALL, os: 'tab\there' },
            [INSTALL],
        ]) {
            const res = await post('/telemetry/v1/install', body);
            expect(res.statusCode, JSON.stringify(body)).toBe(400);
            expect(res.json()).toEqual({ error: 'invalid_body' });
        }
        expect((await get('/telemetry/v1/installs')).json().installs).toEqual([]);
    });
});

describe('POST /telemetry/v1/problem', () => {
    it('201 with a report id; the admin can read it back', async () => {
        const res = await post('/telemetry/v1/problem', { report: 'doctor output\nruntime: runc', version: '0.9.0', os: 'ubuntu 24.04' });
        expect(res.statusCode).toBe(201);
        const { reportId } = res.json();
        expect(reportId).toMatch(/^pr_[A-Za-z0-9_-]{16}$/);
        const one = await get(`/telemetry/v1/problems/${reportId}`);
        expect(one.json().problem).toEqual({ id: reportId, day: '2026-10-24', version: '0.9.0', os: 'ubuntu 24.04', report: 'doctor output\nruntime: runc' });
        expect((await get('/telemetry/v1/problems')).json().problems).toEqual([{ id: reportId, day: '2026-10-24', version: '0.9.0', os: 'ubuntu 24.04', bytes: 27 }]);
    });

    it('takes a 256 KB report, refuses a larger one and extra keys', async () => {
        expect((await post('/telemetry/v1/problem', { report: 'x'.repeat(PROBLEM_MAX_BYTES) })).statusCode).toBe(201);
        expect((await post('/telemetry/v1/problem', { report: 'x'.repeat(PROBLEM_MAX_BYTES + 1) })).statusCode).toBe(400);
        // Within the character limit but over the byte limit
        expect((await post('/telemetry/v1/problem', { report: 'é'.repeat(PROBLEM_MAX_BYTES / 2 + 1) })).statusCode).toBe(413);
        expect((await post('/telemetry/v1/problem', { report: 'x', email: 'me@example.com' })).statusCode).toBe(400);
        expect((await post('/telemetry/v1/problem', { report: '' })).statusCode).toBe(400);
    });

    it('stops storing past the total size cap', async () => {
        expect((await post('/telemetry/v1/problem', { report: 'x'.repeat(PROBLEM_MAX_BYTES) })).statusCode).toBe(201);
        expect((await post('/telemetry/v1/problem', { report: 'x'.repeat(PROBLEM_MAX_BYTES) })).statusCode).toBe(201);
        expect((await post('/telemetry/v1/problem', { report: 'x' })).statusCode).toBe(503);
    });

    it('limits reports globally, not per address', async () => {
        for (let i = 0; i < 5; i++) expect((await post('/telemetry/v1/problem', { report: `r${i}` })).statusCode).toBe(201);
        const res = await relay.app.inject({ method: 'POST', url: '/telemetry/v1/problem', remoteAddress: '203.0.113.9', payload: { report: 'other address' } });
        expect(res.statusCode).toBe(429);
        relay.clock.now += 60_000;
        expect((await post('/telemetry/v1/problem', { report: 'later' })).statusCode).toBe(201);
    });

    it('keeps reports 90 days', async () => {
        await post('/telemetry/v1/problem', { report: 'old' });
        relay.clock.now += 89 * 86_400_000;
        await post('/telemetry/v1/problem', { report: 'new' });
        expect(await pruneProblems(telemetry, relay.clock.now)).toBe(0);
        relay.clock.now += 2 * 86_400_000;
        expect(await pruneProblems(telemetry, relay.clock.now)).toBe(1);
        expect((await get('/telemetry/v1/problems')).json().problems.map((p: { bytes: number }) => p.bytes)).toEqual([3]);
    });
});

describe('reading telemetry', () => {
    it('404 without the admin token, with a wrong one, or when none is configured', async () => {
        for (const token of [null, 'b'.repeat(40), ADMIN.slice(1)]) {
            expect((await get('/telemetry/v1/problems', token)).statusCode).toBe(404);
            expect((await get('/telemetry/v1/installs', token)).statusCode).toBe(404);
        }
        const bare = await makeRelay({ telemetry: { store: telemetry } });
        try {
            const res = await bare.app.inject({ method: 'GET', url: '/telemetry/v1/problems', headers: { authorization: `Bearer ${ADMIN}` } });
            expect(res.statusCode).toBe(404);
        } finally {
            await bare.close();
        }
    });

    it('relays built without telemetry have no telemetry routes', async () => {
        const plain = await makeRelay();
        try {
            expect((await plain.app.inject({ method: 'POST', url: '/telemetry/v1/install', payload: INSTALL })).statusCode).toBe(404);
        } finally {
            await plain.close();
        }
    });
});

describe('privacy of the collector', () => {
    it('logs and the database hold no IP, user agent or report text', async () => {
        await post('/telemetry/v1/install', INSTALL, { 'x-forwarded-for': '192.0.2.44' });
        await post('/telemetry/v1/install', { ...INSTALL, extra: 'EXTRA-CANARY' });
        await post('/telemetry/v1/problem', { report: 'REPORT-CANARY-77aa' });
        await post('/telemetry/v1/problem', { report: 'REPORT-CANARY-77aa', bad: 1 });
        const logs = relay.logs.join('');
        expect(relay.logs.length).toBeGreaterThan(3);
        for (const s of [IP, '192.0.2.44', UA, 'UA-CANARY', 'EXTRA-CANARY', 'REPORT-CANARY']) expect(logs).not.toContain(s);
        const outcomes = relay.logs.map((l) => JSON.parse(l)).filter((l) => l.msg === 'request').map((l) => l.outcome);
        expect(outcomes).toEqual(expect.arrayContaining(['install_failed', 'invalid_body', 'problem_stored']));
        await telemetry.close();
        const bytes = [join(dir, 'telemetry.db'), join(dir, 'telemetry.db-wal')].map((p) => {
            try {
                return readFileSync(p).toString('latin1');
            } catch {
                return '';
            }
        }).join('');
        for (const s of [IP, '192.0.2.44', UA, 'UA-CANARY', 'EXTRA-CANARY']) expect(bytes).not.toContain(s);
    });
});

// The same store against Postgres (Heroku), when the test database is reachable.
describe.skipIf(!PG_URL)('PgTelemetryStore', () => {
    const name = `agora_relay_tel_${randomBytes(6).toString('hex')}`;
    let admin: pg.Client;
    let url = '';
    let store: PgTelemetryStore;
    beforeAll(async () => {
        admin = new pg.Client({ connectionString: PG_URL });
        await admin.connect();
        await admin.query(`CREATE DATABASE ${name}`);
        const u = new URL(PG_URL);
        u.pathname = `/${name}`;
        url = u.toString();
        store = await PgTelemetryStore.open(url, { ssl: false });
    });
    afterAll(async () => {
        await store?.close();
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        await admin.end();
    });

    it('stores, lists, counts and prunes like SQLite', async () => {
        await store.recordInstall({ result: 'ok', step: null, version: '1', os: 'ubuntu', osVersion: '24.04' }, '2026-11-01');
        await store.recordInstall({ result: 'ok', step: null, version: '1', os: 'ubuntu', osVersion: '24.04' }, '2026-11-01');
        expect(await store.installCounts('2026-10-01')).toEqual([{ day: '2026-11-01', result: 'ok', step: null, version: '1', os: 'ubuntu', osVersion: '24.04', count: 2 }]);
        await store.recordProblem({ id: 'pr_aaaaaaaaaaaaaaaa', day: '2026-08-01', version: null, os: null, report: 'old' });
        await store.recordProblem({ id: 'pr_bbbbbbbbbbbbbbbb', day: '2026-11-01', version: '1', os: 'ubuntu', report: 'new é' });
        expect(await store.problemUsage()).toEqual({ count: 2, bytes: 3 + 6 });
        expect((await store.getProblem('pr_bbbbbbbbbbbbbbbb'))?.report).toBe('new é');
        expect(await store.pruneProblemsBefore('2026-09-01')).toBe(1);
        expect((await store.listProblems(10)).map((p) => p.id)).toEqual(['pr_bbbbbbbbbbbbbbbb']);
        // Reopening keeps the tables
        await store.close();
        store = await PgTelemetryStore.open(url, { ssl: false });
        expect(await store.problemUsage()).toEqual({ count: 1, bytes: 6 });
    });
});
