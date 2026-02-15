import { buildApp } from '../src/app';
import supertest from 'supertest';

// ─── App lifecycle ───
// Each test FILE calls this in beforeAll / afterAll.
// Returns app (Fastify), db (Pool), request (supertest).
export async function setupTestApp() {
    const { app, db } = await buildApp({
        logger: false,
        jwtSecret: 'test-secret-do-not-use-in-prod',
        dbUrl: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
            ?? 'postgres://accord:accord@localhost:5432/accord_test',
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
    await db.query('TRUNCATE users, servers, roles, channels, server_invites, sessions CASCADE');
}
