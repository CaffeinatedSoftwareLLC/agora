import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';
import { runtimeMaintenance, closeRuntimeClients } from '../../src/runtime/service';
import { generateUlid } from '../../src/utils/ulid';

/**
 * OP-01.code-retention (S0048 GET /admin/settings/runtime, S0049 PATCH /admin/settings/runtime,
 * S0496 the runner's hourly maintenance sweep).
 *
 * runner-main.ts calls `runtimeMaintenance(db)` (src/runtime/service.ts) on start and hourly;
 * it is exported and needs only the DB, so the sweep is driven directly here, no runner or
 * container involved. Runs are seeded straight into exec_runs with backdated created_at.
 */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let admin: Awaited<ReturnType<typeof authedUser>>;
let member: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let channelId: string;

async function seedRun(status: string, ageMinutes: number, code = `console.log(${JSON.stringify(status)})`): Promise<string> {
    const id = generateUlid();
    await ctx.db.query(
        `INSERT INTO exec_runs (id, server_id, channel_id, submitted_by, code, code_sha256, limits, gate_decision, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, '{}', 'auto_run', $7, NOW() - ($8 || ' minutes')::interval)`,
        [id, serverId, channelId, admin.userId, code, 'a'.repeat(64), status, String(ageMinutes)]
    );
    return id;
}
const DAY = 24 * 60;

const runRow = async (id: string) => (await ctx.db.query(
    'SELECT code, code_pruned_at, status, gate_reason, finished_at FROM exec_runs WHERE id = $1', [id])).rows[0];
const settingRows = async () => (await ctx.db.query(
    "SELECT value FROM instance_settings WHERE key = 'runtime.code_retention_days'")).rows;
const auditRows = async () => (await ctx.db.query(
    "SELECT actor_id, changes FROM audit_log WHERE action = 'runtime_settings_update' ORDER BY created_at")).rows;
const codeOf = (id: string) => ctx.request.get(`/runtime/runs/${id}/code`).set(admin.auth);

beforeAll(async () => { ctx = await setupTestApp(); });
afterAll(async () => { await closeRuntimeClients(); await ctx.close(); });

beforeEach(async () => {
    await cleanDatabase(ctx.db);
    admin = await authedUser(ctx.request, 'retadmin');
    member = await authedUser(ctx.request, 'retmember');
    ({ serverId, generalChannelId: channelId } = await createServer(ctx.request, admin.auth, 'Retention'));
    await joinViaInvite(ctx.request, admin.auth, member.auth, serverId);
    await ctx.db.query('UPDATE users SET is_instance_admin = true WHERE id = $1', [admin.userId]);
});

describe('code retention', () => {
    it('[OP-01.code-retention] the default is 30 days; a non-admin can neither read nor change it', async () => {
        const get = await ctx.request.get('/admin/settings/runtime').set(admin.auth);
        expect(get.status).toBe(200);
        expect(get.body).toEqual({ codeRetentionDays: 30 });

        expect((await ctx.request.get('/admin/settings/runtime').set(member.auth)).status).toBe(403);
        const patch = await ctx.request.patch('/admin/settings/runtime').set(member.auth).send({ codeRetentionDays: 1, confirm: true });
        expect(patch.status).toBe(403);
        expect(await settingRows()).toEqual([]);
        expect(await auditRows()).toEqual([]);
    });

    it('[OP-01.code-retention] shortening without confirm gives 409 confirmation_required and nothing changes', async () => {
        const old20 = await seedRun('succeeded', 20 * DAY);
        const old10 = await seedRun('failed', 10 * DAY);
        await seedRun('succeeded', 3 * DAY);
        await seedRun('queued', 20 * DAY); // not finished: never pruned, not counted

        const res = await ctx.request.patch('/admin/settings/runtime').set(admin.auth).send({ codeRetentionDays: 7 });
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ error: 'confirmation_required', affectedRuns: 2 });
        expect(res.body.message).toContain('Code for 2 run(s) older than 7 day(s)');

        const withFalse = await ctx.request.patch('/admin/settings/runtime').set(admin.auth).send({ codeRetentionDays: 7, confirm: false });
        expect(withFalse.status).toBe(409);

        expect(await settingRows()).toEqual([]);
        expect(await auditRows()).toEqual([]);
        expect((await ctx.request.get('/admin/settings/runtime').set(admin.auth)).body).toEqual({ codeRetentionDays: 30 });
        // The sweep under the unchanged 30-day setting prunes nothing
        expect(await runtimeMaintenance(ctx.db)).toEqual({ pruned: 0, expired: 0 });
        for (const id of [old20, old10]) expect((await runRow(id)).code).not.toBeNull();
    });

    it('[OP-01.code-retention] with confirm, the next sweep prunes code only past the limit and expires stale approvals', async () => {
        const old20 = await seedRun('succeeded', 20 * DAY, 'old twenty');
        const old10 = await seedRun('timeout', 10 * DAY, 'old ten');
        const recent = await seedRun('succeeded', 3 * DAY, 'recent three');
        const unfinished = await seedRun('queued', 20 * DAY, 'still queued');
        const staleApproval = await seedRun('awaiting_approval', 45, 'stale approval');
        const freshApproval = await seedRun('awaiting_approval', 5, 'fresh approval');

        const ok = await ctx.request.patch('/admin/settings/runtime').set(admin.auth).send({ codeRetentionDays: 7, confirm: true });
        expect(ok.status).toBe(200);
        expect(ok.body).toEqual({ codeRetentionDays: 7 });
        expect(await settingRows()).toEqual([{ value: 7 }]);
        const audit = await auditRows();
        expect(audit).toHaveLength(1);
        expect(audit[0].changes).toEqual({ codeRetentionDays: 7, previous: 30 });
        expect(audit[0].actor_id.trim()).toBe(admin.userId);

        // Nothing is pruned until the sweep runs
        expect((await codeOf(old20)).status).toBe(200);

        expect(await runtimeMaintenance(ctx.db)).toEqual({ pruned: 2, expired: 1 });

        for (const id of [old20, old10]) {
            const res = await codeOf(id);
            expect(res.status).toBe(410);
            expect(res.body.error).toBe('Code for this run was deleted by the retention policy');
            expect(typeof res.body.prunedAt).toBe('string');
            expect(Number.isNaN(Date.parse(res.body.prunedAt))).toBe(false);
            const dto = await ctx.request.get(`/runtime/runs/${id}`).set(admin.auth);
            expect(dto.status).toBe(200);
            expect(dto.body.codePrunedAt).toBe(res.body.prunedAt);
            expect(dto.body.codeExpiresAt).toBeNull();
        }
        const kept = await codeOf(recent);
        expect(kept.status).toBe(200);
        expect(kept.text).toBe('recent three');
        expect((await runRow(unfinished)).code).toBe('still queued');

        const stale = await runRow(staleApproval);
        expect(stale).toMatchObject({ status: 'denied', gate_reason: 'Approval window expired', code: 'stale approval' });
        expect(stale.finished_at).not.toBeNull();
        expect(await runRow(freshApproval)).toMatchObject({ status: 'awaiting_approval', finished_at: null, code: 'fresh approval' });

        // A second sweep has nothing left to do
        expect(await runtimeMaintenance(ctx.db)).toEqual({ pruned: 0, expired: 0 });
    });

    it('[OP-01.code-retention] shortening with no run past the new limit needs no confirm; lengthening never does', async () => {
        await seedRun('succeeded', 3 * DAY);
        const shorter = await ctx.request.patch('/admin/settings/runtime').set(admin.auth).send({ codeRetentionDays: 7 });
        expect(shorter.status).toBe(200);
        const longer = await ctx.request.patch('/admin/settings/runtime').set(admin.auth).send({ codeRetentionDays: 90 });
        expect(longer.status).toBe(200);
        expect(await settingRows()).toEqual([{ value: 90 }]);
        expect((await auditRows()).map(r => r.changes)).toEqual([
            { codeRetentionDays: 7, previous: 30 },
            { codeRetentionDays: 90, previous: 7 },
        ]);
    });

    it('[OP-01.code-retention] retention off (null) keeps all code; the sweep still expires stale approvals', async () => {
        const ancient = await seedRun('succeeded', 400 * DAY, 'ancient');
        const stale = await seedRun('awaiting_approval', 60);
        const off = await ctx.request.patch('/admin/settings/runtime').set(admin.auth).send({ codeRetentionDays: null });
        expect(off.status).toBe(200);
        expect(await runtimeMaintenance(ctx.db)).toEqual({ pruned: 0, expired: 1 });
        expect((await codeOf(ancient)).text).toBe('ancient');
        expect((await runRow(stale)).status).toBe('denied');
    });

    it('[OP-01.code-retention] invalid values give 400 and change nothing', async () => {
        for (const body of [{}, { codeRetentionDays: 0 }, { codeRetentionDays: 3651 }, { codeRetentionDays: 1.5 }]) {
            const res = await ctx.request.patch('/admin/settings/runtime').set(admin.auth).send(body);
            expect(res.status, JSON.stringify(body)).toBe(400);
        }
        expect(await settingRows()).toEqual([]);
        expect(await auditRows()).toEqual([]);
    });
});
