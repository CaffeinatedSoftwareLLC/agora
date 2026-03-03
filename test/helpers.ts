import { buildApp } from '../src/app';
import supertest from 'supertest';
import { resetInitializedCache } from '../src/instance/check-initialized';

// ─── App lifecycle ───
// Each test FILE calls this in beforeAll / afterAll.
// Returns app (Fastify), db (Pool), request (supertest).
export async function setupTestApp() {
    const { app, db } = await buildApp({
        logger: false,
        jwtSecret: 'test-secret-do-not-use-in-prod',
        dbUrl: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
            ?? 'postgres://accord:accord@localhost:5432/accord_test',
        rateLimit: false,
    });
    await app.ready();
    return {
        app,
        db,
        request: supertest(app.server),
        async close() {
            await app.close();
            await db.end();
        },
    };
}

// ─── Shortcut: register + return auth context ───
export async function authedUser(
    req: supertest.Agent,
    name: string
) {
    const res = await req.post('/auth/register').send({
        username: name,
        email: `${name}@test.com`,
        password: 'TestPass123!',
    });
    if (res.status !== 201) {
        throw new Error(`authedUser(${name}) failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return {
        userId: res.body.user.id as string,
        token: res.body.accessToken as string,
        auth: { Authorization: `Bearer ${res.body.accessToken}` },
    };
}

// ─── Shortcut: create server + find #general ───
export async function createServer(
    req: supertest.Agent,
    auth: object,
    name: string
) {
    const server = await req.post('/servers').set(auth).send({ name });
    if (server.status !== 201) {
        throw new Error(`createServer(${name}) failed: ${server.status}`);
    }

    const channels = await req.get(`/servers/${server.body.id}/channels`).set(auth);

    // Explicit lookup — never assume array order
    const general = channels.body.find((c: any) => c.name === 'general');
    if (!general) {
        throw new Error('Server created without #general channel');
    }

    return {
        serverId: server.body.id as string,
        generalChannelId: general.id as string,
        everyoneRoleId: server.body.everyoneRoleId as string,
    };
}

// ─── Shortcut: invite + join ───
export async function joinViaInvite(
    req: supertest.Agent,
    ownerAuth: object,
    joinerAuth: object,
    serverId: string
) {
    const invite = await req
        .post(`/servers/${serverId}/invites`)
        .set(ownerAuth)
        .send({});

    const join = await req
        .post(`/invites/${invite.body.code}`)
        .set(joinerAuth);

    return join.body;
}

// ─── Database cleanup for test isolation ───
export async function cleanDatabase(db: any) {
    await db.query('TRUNCATE users, servers, roles, channels, server_invites, sessions, messages, message_reactions, message_mentions, channel_unreads, instance_config, audit_log, ip_bans, instance_settings, files, bot_tokens, bot_channel_access, bot_read_cursors CASCADE');
    // Re-seed instance_config so existing tests see an initialized instance
    await db.query(
        `INSERT INTO instance_config (key, value) VALUES
            ('setup_complete', 'true'),
            ('registration_policy', 'open'),
            ('instance_name', 'Agora')`
    );
    // Re-seed default file-sharing settings
    await db.query(
        `INSERT INTO instance_settings (key, value) VALUES
            ('files.max_size_bytes',      '26214400'::jsonb),
            ('files.allowed_extensions',  '["jpg","jpeg","png","gif","webp","pdf","txt","md","zip","mp3","mp4","mov","csv","json"]'::jsonb),
            ('files.retention_days',      'null'::jsonb),
            ('files.storage_quota_bytes', 'null'::jsonb),
            ('files.exif_strip',          'true'::jsonb)
        ON CONFLICT DO NOTHING`
    );
    // Reset the in-memory cache so the app re-reads from DB
    resetInitializedCache();
}

// ─── Shortcut: run POST /instance/setup for tests that need it ───
export async function setupInstance(
    req: supertest.Agent,
    opts?: { setupToken?: string; username?: string; email?: string; password?: string; instanceName?: string }
) {
    const token = opts?.setupToken ?? process.env.AGORA_SETUP_TOKEN ?? 'test-setup-token';
    const res = await req.post('/instance/setup').send({
        setupToken: token,
        username: opts?.username ?? 'admin',
        email: opts?.email ?? 'admin@test.com',
        password: opts?.password ?? 'TestPass123!',
        instanceName: opts?.instanceName ?? 'Test Instance',
    });
    if (res.status !== 201) {
        throw new Error(`setupInstance failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return {
        userId: res.body.user.id as string,
        token: res.body.accessToken as string,
        auth: { Authorization: `Bearer ${res.body.accessToken}` },
    };
}
