import { describe, it, expect } from 'vitest';
import { buildApiDoctorReport, redact } from '../../src/lib/doctor';

/** docs/agent-boxes.md §12.5: the API doctor names what is set, never what it is set to. */
const SECRET = 'f'.repeat(16) + '0123456789abcdef'.repeat(3);

describe('redact', () => {
    it('removes token-shaped strings and keeps ordinary text', () => {
        const input = [
            'Authorization: Bearer abc.def.ghi',
            'host token ah_01JABCDEFGHJKMNPQRSTVWXYZ0.s3cr3tS3cr3tS3cr3t',
            'bot bot_0123456789abcdefghij',
            'key sk-ant-api03-abcdefghijklmnop',
            `hex ${SECRET}`,
            'url postgres://accord:hunter2@postgres:5432/agora',
            'AGORA_EDGE_SECRET=deadbeef',
            'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlc2lnbmF0dXJl',
            'container agora-box-01jabcdefghjkmnpqrstvwxyz0 Up 3 minutes (runsc)',
            'path /var/lib/docker/volumes/agora_pgdata/_data',
        ].join('\n');
        const out = redact(input);
        for (const s of ['abc.def.ghi', 's3cr3t', 'bot_0123456789', 'sk-ant-api03', SECRET, 'hunter2', 'deadbeef', 'eyJhbGci']) expect(out).not.toContain(s);
        expect(out).toContain('agora-box-01jabcdefghjkmnpqrstvwxyz0 Up 3 minutes (runsc)');
        expect(out).toContain('/var/lib/docker/volumes/agora_pgdata/_data');
        expect(out).toContain('postgres:5432/agora');
    });
});

describe('buildApiDoctorReport', () => {
    const rows: Record<string, any[]> = {
        'SELECT version()': [{ v: 'PostgreSQL 16.4' }],
        'FROM schema_migrations': [{ v: '080_agent_boxes.sql', n: 80 }],
        'FROM users': [{ n: 1 }],
        'GROUP BY status': [{ status: 'done', n: 3 }],
        "status = 'queued'": [{ oldest: new Date(Date.UTC(2026, 10, 4, 11, 0)) }],
        'FROM agent_boxes': [{
            id: '01JABCDEFGHJKMNPQRSTVWXYZ0', state: 'failed', desired_state: 'running', pending_action: null, generation: 3,
            image_version: 1, login_state: 'none', failures: 5, last_error: `start refused: token ah_X.${SECRET}`,
            last_error_at: new Date(Date.UTC(2026, 10, 4, 11, 55)), last_seen_at: null, deleted_at: null,
        }],
        'FROM box_edge_requests': [{ kind: 'domain', status: 'pending', n: 2 }],
    };
    const query = async (sql: string) => ({ rows: Object.entries(rows).find(([k]) => sql.includes(k))?.[1] ?? [] });
    const now = () => Date.UTC(2026, 10, 4, 12, 0);

    it('reports each check, keys as set or not set, and no values', async () => {
        const env = { AGORA_INSTANCE: 'agora', AGORA_ENCRYPTION_KEY: SECRET, JWT_SECRET: 'jwt-CANARY-value', AGORA_EDGE_SECRET: SECRET, DATABASE_URL: 'postgres://accord:pw-CANARY@db/agora' };
        const redis = { ping: async () => 'PONG', get: async (k: string) => (k.includes('boxd') ? String(now() - 20_000) : null) };
        const report = await buildApiDoctorReport({ query, redis, env, now, version: '0.3.5' });
        expect(report).toContain('agora: 0.3.5');
        expect(report).toContain('AGORA_INSTANCE: agora');
        expect(report).toContain('AGORA_ENCRYPTION_KEY: set');
        expect(report).toContain('REDIS_URL: not set');
        expect(report).toContain('AGORA_EDGE_SECRET shape: ok (64 hex)');
        expect(report).toContain('migrations: 80 applied, latest 080_agent_boxes.sql');
        expect(report).toContain('runs in the last 24h: done=3');
        expect(report).toMatch(/oldest queued run: 60m ago/);
        expect(report).toMatch(/the runner may be down/);
        expect(report).toContain('boxd heartbeat: 20s ago');
        expect(report).toContain('edge heartbeat: never');
        expect(report).toContain('box 01JABCDEFGHJKMNPQRSTVWXYZ0: state=failed desired=running gen=3 image=1 login=none failures=5 seen=never');
        expect(report).toContain('edge requests (7 days): domain/pending=2');
        for (const s of [SECRET, 'jwt-CANARY', 'pw-CANARY']) expect(report).not.toContain(s);
    });

    it('turns a failing check into a line', async () => {
        const report = await buildApiDoctorReport({
            query: async (sql) => {
                if (sql.includes('agent_boxes')) throw Object.assign(new Error('relation "agent_boxes" does not exist'), { code: '42P01' });
                return query(sql);
            },
            redis: null,
            env: {},
            now,
        });
        expect(report).toContain('boxes: FAILED (42P01)');
        expect(report).toContain('redis: not connected');
        expect(report).toContain('database: ok');
    });
});
