import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import supertest from 'supertest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../../src/app';
import { problemReportRoutes } from '../../src/routes/problem-report';
import { authedUser, cleanDatabase } from '../helpers';

/**
 * Admin → Instance → Report setup problem (docs/agent-boxes.md §12.5): preview shows the
 * report, send forwards it only when asked, and only for instance admins.
 */
const sent: Array<{ url: string; body: any }> = [];
let collector: { status: number; body: unknown } | 'down' = { status: 201, body: { reportId: 'pr_AAAAAAAAAAAAAAAA' } };

let app: Awaited<ReturnType<typeof buildApp>>['app'];
let db: Awaited<ReturnType<typeof buildApp>>['db'];
let req: ReturnType<typeof supertest>;
let collectorServer: Server;
const savedUrl = process.env.AGORA_TELEMETRY_URL;

beforeAll(async () => {
    // A stand-in collector on localhost; the route reads AGORA_TELEMETRY_URL per request, so
    // this works whether app.ts registers the routes or this file does
    collectorServer = createServer((r, res) => {
        let raw = '';
        r.on('data', (c) => { raw += c; });
        r.on('end', () => {
            if (collector === 'down') { res.destroy(); return; }
            sent.push({ url: r.url ?? '', body: JSON.parse(raw) });
            res.writeHead(collector.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(collector.body));
        });
    });
    await new Promise<void>((resolve) => collectorServer.listen(0, '127.0.0.1', () => resolve()));
    process.env.AGORA_TELEMETRY_URL = `http://127.0.0.1:${(collectorServer.address() as AddressInfo).port}`;

    ({ app, db } = await buildApp({
        logger: false,
        jwtSecret: 'test-secret-do-not-use-in-prod',
        dbUrl: process.env.TEST_DATABASE_URL ?? 'postgres://accord:accord@localhost:5432/accord_test',
        rateLimit: false,
    }));
    // Until src/app.ts registers the routes, this file does
    if (!app.hasRoute({ method: 'POST', url: '/admin/problem-report/preview' })) await app.register(problemReportRoutes);
    await app.ready();
    req = supertest(app.server);
    await cleanDatabase(db);
});
afterAll(async () => {
    await app.close();
    await db.end();
    await new Promise<void>((resolve) => collectorServer.close(() => resolve()));
    if (savedUrl === undefined) delete process.env.AGORA_TELEMETRY_URL;
    else process.env.AGORA_TELEMETRY_URL = savedUrl;
});
beforeEach(() => {
    sent.length = 0;
    collector = { status: 201, body: { reportId: 'pr_AAAAAAAAAAAAAAAA' } };
});

async function admin(name: string) {
    const u = await authedUser(req as any, name);
    await db.query('UPDATE users SET is_instance_admin = true WHERE id = $1', [u.userId]);
    return u;
}

describe('problem report', () => {
    it('preview: the API doctor, with no secrets and nothing sent', async () => {
        const a = await admin('pr_admin1');
        const res = await req.post('/admin/problem-report/preview').set(a.auth);
        expect(res.status).toBe(200);
        const report: string = res.body.report;
        expect(report).toMatch(/^# Agora API doctor/);
        expect(report).toMatch(/database: ok/);
        expect(report).toMatch(/migrations: \d+ applied/);
        expect(report).toMatch(/boxes: none|box /);
        expect(report).toMatch(/JWT_SECRET: (set|not set)/);
        for (const v of [process.env.AGORA_ENCRYPTION_KEY, process.env.JWT_SECRET, 'test-secret-do-not-use-in-prod']) {
            if (v && v.length > 8) expect(report).not.toContain(v);
        }
        expect(sent).toEqual([]);
    });

    it('send: forwards the redacted text and returns the report id', async () => {
        const a = await admin('pr_admin2');
        const res = await req.post('/admin/problem-report/send').set(a.auth)
            .send({ report: 'runtime=runc\nAuthorization: Bearer abcdefghijklmnop\ntoken ah_01ABC.0123456789abcdef0123456789abcdef' });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ reportId: 'pr_AAAAAAAAAAAAAAAA' });
        expect(sent).toHaveLength(1);
        expect(sent[0].url).toBe('/telemetry/v1/problem');
        expect(Object.keys(sent[0].body).sort()).toEqual(['os', 'report', 'version']);
        expect(sent[0].body.report).toContain('runtime=runc');
        expect(sent[0].body.report).not.toContain('abcdefghijklmnop');
        expect(sent[0].body.report).not.toContain('0123456789abcdef0123456789abcdef');
        const audit = await db.query("SELECT changes FROM audit_log WHERE action = 'problem_report_sent' AND actor_id = $1", [a.userId]);
        expect(audit.rows[0].changes).toMatchObject({ reportId: 'pr_AAAAAAAAAAAAAAAA' });
    });

    it('send: 502 when the collector is down or refuses', async () => {
        const a = await admin('pr_admin3');
        collector = 'down';
        expect((await req.post('/admin/problem-report/send').set(a.auth).send({ report: 'x' })).body).toEqual({ error: 'collector_unreachable' });
        collector = { status: 400, body: { error: 'invalid_body' } };
        const res = await req.post('/admin/problem-report/send').set(a.auth).send({ report: 'x' });
        expect(res.status).toBe(502);
        expect(res.body.error).toBe('collector_refused');
    });

    it('instance admins only, and a strict body', async () => {
        const user = await authedUser(req as any, 'pr_member');
        expect((await req.post('/admin/problem-report/preview').set(user.auth)).status).toBe(403);
        expect((await req.post('/admin/problem-report/send').set(user.auth).send({ report: 'x' })).status).toBe(403);
        expect((await req.post('/admin/problem-report/preview')).status).toBe(401);
        const a = await admin('pr_admin4');
        expect((await req.post('/admin/problem-report/send').set(a.auth).send({})).status).toBe(400);
        expect((await req.post('/admin/problem-report/send').set(a.auth).send({ report: 'x'.repeat(256 * 1024 + 1) })).status).toBe(400);
        expect(sent).toEqual([]);
    });
});
