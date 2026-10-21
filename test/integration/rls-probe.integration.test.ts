import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';

/**
 * SEC-01.rls-probe: row-level security tested on its own, apart from the routes.
 *
 * Every route checks membership before it queries, so a route returning 403 still
 * passes with a broken policy. These tests skip the routes: they open a transaction on
 * the owner pool, switch to the role and setting the request preHandler uses
 * (src/app.ts: SET LOCAL ROLE app_user + set_config('app.current_user_id', id, true);
 * there is no other GUC), run one statement and roll back. Each probe is its own
 * transaction, so a raised error never aborts the next probe.
 *
 * Cast:
 *   owner    owns server S (channels #general and #second); bot B has access to #general only
 *   member   a member of S (not its owner)
 *   other    owns server S2 (bot B2); every table gets a row in S2 too, so "member sees
 *            exactly S's rows" also proves S2's rows stay hidden
 *   outsider a member of no server
 *   admin    an instance admin in no server (terms watch tables are admin-only)
 *
 * Expected counts are taken from the owner connection (role accord, bypasses RLS) with
 * the filter the policy is meant to apply, and each one is checked to be non-zero.
 *
 * Policy state probed is the state after all migrations (pg_policies), not the 006-058
 * files alone: 016 and 057 add bot SELECT policies to channels and files, 018 adds
 * channels UPDATE. 062 hardens these boundaries; the original seven regressions below must pass.
 */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
type User = Awaited<ReturnType<typeof authedUser>>;
let owner: User, member: User, other: User, outsider: User, admin: User;
let botId: string, bot2Id: string;

interface Seed {
    serverId: string;
    channelId: string;
    messageId: string;
    fileId: string;
    tagDefId: string;
    hostId: string;
    profileId: string;
    sessionId: string;
    batchId: string;
    runId: string;
    reservationId: string;
    toolRequestId: string;
    approvalId: string;
    commandId: string;
    checkpointId: string;
    relayId: string;
    cardId: string;
    artifactId: string;
    previewId: string;
    handoffId: string;
    inboxId: string;
}
let S: Seed, S2: Seed;
let secondChannelId: string;
let memberFileId: string, ownerSecondFileId: string;
let memberAgentInviteId: string, ownerAgentInviteId: string;
let memberPasskeyId: string, ownerPasskeyId: string;
let termsDocId: string, termsChangeId: string;

// ─── Probe helpers ───

type ProbeResult =
    | { ok: true; rows: any[]; rowCount: number }
    | { ok: false; code: string; message: string };

/** Run one statement as app_user acting for `userId`, then roll back. */
async function probe(userId: string, sql: string, params: unknown[] = []): Promise<ProbeResult> {
    const client = await ctx.db.connect();
    try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE app_user');
        await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
        try {
            const r = await client.query(sql, params);
            return { ok: true, rows: r.rows, rowCount: r.rowCount ?? 0 };
        } catch (err: any) {
            return { ok: false, code: err.code, message: err.message };
        }
    } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
    }
}

/** Run one statement as the table owner (bypasses RLS), then roll back. */
async function asOwner(sql: string, params: unknown[] = []): Promise<{ rowCount: number; rows: any[] }> {
    const client = await ctx.db.connect();
    try {
        await client.query('BEGIN');
        const r = await client.query(sql, params);
        return { rowCount: r.rowCount ?? 0, rows: r.rows };
    } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
    }
}

async function ownerCount(sql: string, params: unknown[] = []): Promise<number> {
    return (await ctx.db.query(sql, params)).rows[0].n;
}

function describeResult(r: ProbeResult): string {
    return r.ok ? `ok, rowCount=${r.rowCount}` : `${r.code}: ${r.message}`;
}

/** A SELECT count(*) that ran; returns the count. */
function countOf(r: ProbeResult, label: string): number {
    expect(r.ok, `${label}: ${describeResult(r)}`).toBe(true);
    return (r as any).rows[0].n;
}

/** Raised insufficient_privilege: either no grant or a WITH CHECK violation (both 42501). */
function expectRaised(r: ProbeResult, label: string, pattern?: RegExp) {
    expect(r.ok, `${label} should raise, got ${describeResult(r)}`).toBe(false);
    expect((r as any).code, `${label}: ${describeResult(r)}`).toBe('42501');
    if (pattern) expect((r as any).message, label).toMatch(pattern);
}

const NO_GRANT = /permission denied for table/;
const RLS_CHECK = /row-level security/;

/** A write that either touched no row or raised 42501. */
function expectNoEffect(r: ProbeResult, label: string) {
    if (r.ok) expect(r.rowCount, `${label} should affect 0 rows`).toBe(0);
    else expect(r.code, `${label}: ${describeResult(r)}`).toBe('42501');
}

/** The same write as the table owner touches a row: the probe's 0 is meaningful. */
async function expectOwnerWrites(sql: string, params: unknown[], label: string) {
    const r = await asOwner(sql, params);
    expect(r.rowCount, `${label} as table owner should affect a row (probe target exists)`).toBeGreaterThan(0);
}

// ─── Seeding ───

async function makeBot(serverOwner: User, serverId: string, channelId: string, name: string): Promise<string> {
    const bot = await ctx.request.post(`/servers/${serverId}/bots`).set(serverOwner.auth).send({ username: name });
    expect(bot.status, JSON.stringify(bot.body)).toBe(201);
    const access = await ctx.request.post(`/channels/${channelId}/bots/${bot.body.id}`).set(serverOwner.auth);
    expect(access.status, JSON.stringify(access.body)).toBe(201);
    return bot.body.id;
}

async function insertFile(uploaderId: string, channelId: string): Promise<string> {
    const id = generateUlid();
    await ctx.db.query(
        `INSERT INTO files (id, uploader_id, channel_id, filename, size_bytes, bucket, path)
         VALUES ($1, $2, $3, 'probe.txt', 1, 'files', $4)`,
        [id, uploaderId, channelId, `${channelId}/${id}/blob`]
    );
    return id;
}

/** One row in every server-scoped table, for one server (as table owner). */
async function seedServer(serverId: string, channelId: string, ownerId: string, uploaderId: string, bot: string): Promise<Seed> {
    const q = (sql: string, params: unknown[]) => ctx.db.query(sql, params);
    const id = () => generateUlid();
    const s = {
        serverId, channelId,
        messageId: id(), fileId: '', tagDefId: id(), hostId: id(), profileId: id(), sessionId: id(),
        batchId: id(), runId: id(), reservationId: id(), toolRequestId: id(), approvalId: id(),
        commandId: id(), checkpointId: id(), relayId: id(), cardId: id(), artifactId: id(),
        previewId: id(), handoffId: id(), inboxId: id(),
    } as Seed;

    await q(`INSERT INTO messages (id, channel_id, author_id, content) VALUES ($1, $2, $3, 'probe')`, [s.messageId, channelId, ownerId]);
    s.fileId = await insertFile(uploaderId, channelId);

    // 034 file tagging
    await q(`INSERT INTO file_tag_definitions (id, server_id, name, instructions) VALUES ($1, $2, 'probe', 'Is it a probe?')`, [s.tagDefId, serverId]);
    await q(`INSERT INTO file_tags (file_id, tag_id, tag_revision, question_version, probability, model) VALUES ($1, $2, 1, 'v1', 0.5, 'm')`, [s.fileId, s.tagDefId]);
    await q(`INSERT INTO file_tag_jobs (file_id, server_id) VALUES ($1, $2)`, [s.fileId, serverId]);

    // 037 agent sessions
    await q(`INSERT INTO agent_hosts (id, server_id, name, secret_hash, created_by) VALUES ($1, $2, 'probe-host', 'x', $3)`, [s.hostId, serverId, ownerId]);
    await q(`INSERT INTO agent_profiles (id, server_id, name, bot_id, host_id, adapter, workdir_alias, created_by)
             VALUES ($1, $2, 'probe', $3, $4, 'claude', 'agora', $5)`, [s.profileId, serverId, bot, s.hostId, ownerId]);
    await q(`INSERT INTO agent_sessions (id, server_id, channel_id, bot_id, profile_id, started_by)
             VALUES ($1, $2, $3, $4, $5, $6)`, [s.sessionId, serverId, channelId, bot, s.profileId, ownerId]);
    await q(`INSERT INTO agent_session_threads (thread_id, channel_id, initiator_session_id, session_ids)
             VALUES ($1, $2, $3, ARRAY[$4::text])`, [s.messageId, channelId, s.sessionId, s.sessionId]);
    await q(`INSERT INTO agent_batches (id, session_id, delivery_key) VALUES ($1, $2, 'probe')`, [s.batchId, s.sessionId]);
    await q(`INSERT INTO agent_inbox (id, session_id, message_id, reason, batch_id) VALUES ($1, $2, $3, 'direct', $4)`,
        [s.inboxId, s.sessionId, s.messageId, s.batchId]);
    await q(`INSERT INTO agent_runs (id, batch_id, session_id, host_id, claim_token_hash, attempt, profile_generation, lease_until)
             VALUES ($1, $2, $3, $4, repeat('a', 64), 1, 1, NOW() + interval '1 hour')`, [s.runId, s.batchId, s.sessionId, s.hostId]);

    // 041 reservations, 042 tool requests
    await q(`INSERT INTO agent_file_reservations (id, server_id, workspace_id, session_id, paths, expires_at)
             VALUES ($1, $2, 'primary', $3, ARRAY['src/a.ts'], NOW() + interval '1 hour')`, [s.reservationId, serverId, s.sessionId]);
    await q(`INSERT INTO agent_tool_requests (id, server_id, session_id, profile_id, tool) VALUES ($1, $2, $3, $4, 'Bash')`,
        [s.toolRequestId, serverId, s.sessionId, s.profileId]);

    // 045 lurk images, 046 run approvals, 047 diff review
    await q(`INSERT INTO agent_run_images (run_id, digest, file_id, message_id) VALUES ($1, repeat('b', 64), $2, $3)`, [s.runId, s.fileId, s.messageId]);
    await q(`INSERT INTO agent_run_approvals (id, server_id, session_id) VALUES ($1, $2, $3)`, [s.approvalId, serverId, s.sessionId]);
    await q(`INSERT INTO agent_workspace_commands (id, session_id, host_id, profile_generation, requested_by, action)
             VALUES ($1, $2, $3, 1, $4, 'diff')`, [s.commandId, s.sessionId, s.hostId, ownerId]);
    await q(`INSERT INTO agent_checkpoints (id, session_id, run_id, sha, ref) VALUES ($1, $2, $3, repeat('c', 40), 'refs/agora/probe')`,
        [s.checkpointId, s.sessionId, s.runId]);

    // 049 permission relays, 050 plan connections
    await q(`INSERT INTO permission_relays (id, server_id, channel_id, bot_id, relay_id, tool_name, description, input_preview)
             VALUES ($1, $2, $3, $4, 'abcde', 'Bash', 'd', 'p')`, [s.relayId, serverId, channelId, bot]);
    await q(`INSERT INTO agent_plan_connections (profile_id, server_id, status) VALUES ($1, $2, 'requested')`, [s.profileId, serverId]);

    // 051 project context, 052 task board
    await q(`INSERT INTO channel_projects (channel_id, server_id) VALUES ($1, $2)`, [channelId, serverId]);
    await q(`INSERT INTO channel_project_files (channel_id, file_id, position) VALUES ($1, $2, 0)`, [channelId, s.fileId]);
    await q(`INSERT INTO task_cards (id, server_id, channel_id, title) VALUES ($1, $2, $3, 'card')`, [s.cardId, serverId, channelId]);

    // 053 canvas and preview
    await q(`INSERT INTO artifacts (id, server_id, channel_id, title, kind) VALUES ($1, $2, $3, 'a', 'markdown')`, [s.artifactId, serverId, channelId]);
    await q(`INSERT INTO artifact_versions (artifact_id, version, message_id, title, kind, content) VALUES ($1, 1, $2, 'a', 'markdown', '# a')`,
        [s.artifactId, s.messageId]);
    await q(`INSERT INTO browser_previews (id, session_id, channel_id, host_id, profile_generation, requested_by, url)
             VALUES ($1, $2, $3, $4, 1, $5, 'http://localhost:5173')`, [s.previewId, s.sessionId, channelId, s.hostId, ownerId]);

    // 058 handoffs
    await q(`INSERT INTO agent_handoffs (id, server_id, channel_id, thread_id, from_session_id, to_session_id, from_bot_id, to_bot_id,
                                         summary, workspace_id, expires_at)
             VALUES ($1, $2, $3, $4, $5, $5, $6, $6, 'probe', 'primary', NOW() + interval '1 hour')`,
        [s.handoffId, serverId, channelId, s.messageId, s.sessionId, bot]);
    await q(`INSERT INTO agent_thread_owners (thread_id, server_id, channel_id, session_id, bot_id, handoff_id)
             VALUES ($1, $2, $3, $4, $5, $6)`, [s.messageId, serverId, channelId, s.sessionId, bot, s.handoffId]);
    return s;
}

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);

    owner = await authedUser(ctx.request, 'rlsowner');
    member = await authedUser(ctx.request, 'rlsmember');
    other = await authedUser(ctx.request, 'rlsother');
    outsider = await authedUser(ctx.request, 'rlsoutsider');
    admin = await authedUser(ctx.request, 'rlsadmin');
    await ctx.db.query('UPDATE users SET is_instance_admin = (id = $1)', [admin.userId]);

    const server = await createServer(ctx.request, owner.auth, 'RLS S');
    await joinViaInvite(ctx.request, owner.auth, member.auth, server.serverId);
    const second = await ctx.request.post(`/servers/${server.serverId}/channels`).set(owner.auth).send({ name: 'second', channelType: 3 });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    secondChannelId = second.body.id;
    expect((await ctx.request.post(`/servers/${server.serverId}/invites`).set(owner.auth).send({})).status).toBe(201);
    botId = await makeBot(owner, server.serverId, server.generalChannelId, 'rlsbot');

    const server2 = await createServer(ctx.request, other.auth, 'RLS S2');
    expect((await ctx.request.post(`/servers/${server2.serverId}/invites`).set(other.auth).send({})).status).toBe(201);
    bot2Id = await makeBot(other, server2.serverId, server2.generalChannelId, 'rlsbot2');

    // The cast is what the header says
    expect(await ownerCount('SELECT count(*)::int n FROM server_members WHERE user_id IN ($1, $2)', [outsider.userId, admin.userId])).toBe(0);
    expect(await ownerCount('SELECT count(*)::int n FROM server_members WHERE server_id = $1 AND user_id = $2', [server.serverId, member.userId])).toBe(1);

    S = await seedServer(server.serverId, server.generalChannelId, owner.userId, member.userId, botId);
    S2 = await seedServer(server2.serverId, server2.generalChannelId, other.userId, other.userId, bot2Id);
    memberFileId = S.fileId;
    await insertFile(owner.userId, server.generalChannelId);
    ownerSecondFileId = await insertFile(owner.userId, secondChannelId);

    // 043: one agent invite made by the member, one by the owner, same server and bot
    memberAgentInviteId = generateUlid();
    ownerAgentInviteId = generateUlid();
    await ctx.db.query(`INSERT INTO agent_invites (id, code_hash, bot_id, server_id, created_by) VALUES
        ($1, repeat('1', 64), $3, $4, $5), ($2, repeat('2', 64), $3, $4, $6)`,
        [memberAgentInviteId, ownerAgentInviteId, botId, server.serverId, member.userId, owner.userId]);
    await ctx.db.query(`INSERT INTO agent_invites (id, code_hash, bot_id, server_id, created_by) VALUES ($1, repeat('3', 64), $2, $3, $4)`,
        [generateUlid(), bot2Id, server2.serverId, other.userId]);

    // 044: one passkey each for member and owner
    memberPasskeyId = generateUlid();
    ownerPasskeyId = generateUlid();
    await ctx.db.query(`INSERT INTO user_passkeys (id, user_id, credential_id, public_key, device_type, rp_id, name) VALUES
        ($1, $3, 'cred-member', '\\x00', 'singleDevice', 'localhost', 'm'),
        ($2, $4, 'cred-owner', '\\x00', 'singleDevice', 'localhost', 'o')`,
        [memberPasskeyId, ownerPasskeyId, member.userId, owner.userId]);

    // 048: the documents are seeded by the migration; add one change
    termsDocId = (await ctx.db.query('SELECT id FROM terms_documents ORDER BY id LIMIT 1')).rows[0].id.trim();
    termsChangeId = generateUlid();
    await ctx.db.query(`INSERT INTO terms_changes (id, document_id, previous_hash, current_hash, diff, summary, impact, analysis_status)
        VALUES ($1, $2, 'a', 'b', 'd', 's', 'low', 'done')`, [termsChangeId, termsDocId]);
});
afterAll(async () => { await ctx.close(); });

const T = '[SEC-01.rls-probe]';

// ═══════════════════════════════════════════════════════════════
// S0517 006_row_level_security: server_invites, server_members, channels
// ═══════════════════════════════════════════════════════════════
describe('006_row_level_security (S0517)', () => {
    it(`${T} server_invites (006): outsider DELETE and INSERT into the member's server are refused`, async () => {
        const code = (await ctx.db.query('SELECT code FROM server_invites WHERE server_id = $1 LIMIT 1', [S.serverId])).rows[0].code;

        // No DELETE policy: deny-all
        await expectOwnerWrites('DELETE FROM server_invites WHERE code = $1', [code], 'invite delete');
        expectNoEffect(await probe(outsider.userId, 'DELETE FROM server_invites WHERE code = $1', [code]), 'outsider DELETE');
        expectNoEffect(await probe(member.userId, 'DELETE FROM server_invites WHERE code = $1', [code]), 'member DELETE');

        const insert = `INSERT INTO server_invites (code, server_id, creator_id) VALUES ('rlsprobe1', $1, $2)`;
        await expectOwnerWrites(insert, [S.serverId, outsider.userId], 'invite insert');
        expectRaised(await probe(outsider.userId, insert, [S.serverId, outsider.userId]), 'outsider INSERT', RLS_CHECK);
        // The member may mint one for their own server (invite_insert_member)
        const mine = await probe(member.userId, insert, [S.serverId, member.userId]);
        expect(mine.ok, describeResult(mine)).toBe(true);
    });

    // FINDING: server_invites SELECT policy invite_select is USING (true)
    // (src/db/migrations/006_row_level_security.sql:39-41): any app_user, member of no
    // server, reads every server's invite codes. The routes only look codes up by value,
    // but the policy permits enumerating them all.
    it(`${T} server_invites (006): outsider SELECT sees 0 rows and the member sees exactly S's invites`, async () => {
        const expected = await ownerCount('SELECT count(*)::int n FROM server_invites WHERE server_id = $1', [S.serverId]);
        expect(expected).toBeGreaterThan(0);
        expect(await ownerCount('SELECT count(*)::int n FROM server_invites WHERE server_id = $1', [S2.serverId])).toBeGreaterThan(0);
        expect(countOf(await probe(outsider.userId, 'SELECT count(*)::int n FROM server_invites'), 'outsider SELECT')).toBe(0);
        expect(countOf(await probe(member.userId, 'SELECT count(*)::int n FROM server_invites'), 'member SELECT')).toBe(expected);
    });

    // FINDING: server_invites UPDATE policy invite_update is USING (true) with no WITH CHECK
    // (src/db/migrations/006_row_level_security.sql:49-51): any app_user can rewrite any
    // server's invite (reset use_count, clear max_uses/expires_at, even change server_id).
    // It exists for the use_count increment on join.
    it(`${T} server_invites (006): outsider UPDATE of the member's server's invite affects 0 rows`, async () => {
        const code = (await ctx.db.query('SELECT code FROM server_invites WHERE server_id = $1 LIMIT 1', [S.serverId])).rows[0].code;
        const update = 'UPDATE server_invites SET max_uses = max_uses WHERE code = $1';
        await expectOwnerWrites(update, [code], 'invite update');
        expectNoEffect(await probe(outsider.userId, update, [code]), 'outsider UPDATE');
    });

    it(`${T} server_members (006): outsider sees 0, member sees exactly S's members, UPDATE/DELETE deny-all, no impersonated INSERT`, async () => {
        const expected = await ownerCount('SELECT count(*)::int n FROM server_members WHERE server_id = $1', [S.serverId]);
        expect(expected).toBe(2); // owner + member (bots are not members)
        expect(await ownerCount('SELECT count(*)::int n FROM server_members WHERE server_id = $1', [S2.serverId])).toBeGreaterThan(0);

        expect(countOf(await probe(outsider.userId, 'SELECT count(*)::int n FROM server_members'), 'outsider SELECT')).toBe(0);
        expect(countOf(await probe(member.userId, 'SELECT count(*)::int n FROM server_members'), 'member SELECT')).toBe(expected);

        // No UPDATE or DELETE policy: deny-all, for members too
        const update = 'UPDATE server_members SET nickname = nickname WHERE server_id = $1 AND user_id = $2';
        const del = 'DELETE FROM server_members WHERE server_id = $1 AND user_id = $2';
        await expectOwnerWrites(update, [S.serverId, member.userId], 'member update');
        await expectOwnerWrites(del, [S.serverId, member.userId], 'member delete');
        expectNoEffect(await probe(outsider.userId, update, [S.serverId, member.userId]), 'outsider UPDATE');
        expectNoEffect(await probe(outsider.userId, del, [S.serverId, member.userId]), 'outsider DELETE');
        expectNoEffect(await probe(member.userId, update, [S.serverId, member.userId]), 'member UPDATE');
        expectNoEffect(await probe(member.userId, del, [S.serverId, member.userId]), 'member DELETE');

        // members_self_insert: nobody can add someone else
        const insert = 'INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)';
        await expectOwnerWrites(insert, [S.serverId, admin.userId], 'member insert');
        expectRaised(await probe(outsider.userId, insert, [S.serverId, admin.userId]), 'outsider INSERT of another user', RLS_CHECK);
        expectRaised(await probe(member.userId, insert, [S2.serverId, admin.userId]), 'member INSERT of another user', RLS_CHECK);
    });

    // FINDING: server_members INSERT policy members_self_insert only checks
    // user_id = current user (src/db/migrations/006_row_level_security.sql:58-62): an
    // outsider can add themselves to any server. The invite check lives only in the
    // join routes (servers.ts / auth.ts), so RLS gives no defense-in-depth for joins.
    it(`${T} server_members (006): outsider INSERT of their own membership in the member's server raises`, async () => {
        const insert = 'INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)';
        await expectOwnerWrites(insert, [S.serverId, outsider.userId], 'self-join');
        expectRaised(await probe(outsider.userId, insert, [S.serverId, outsider.userId]), 'outsider self-join INSERT');
    });

    it(`${T} channels (006): outsider sees 0 and cannot UPDATE/DELETE/INSERT; member sees exactly S's channels`, async () => {
        const expected = await ownerCount('SELECT count(*)::int n FROM channels WHERE server_id = $1', [S.serverId]);
        expect(expected).toBeGreaterThanOrEqual(2);
        expect(await ownerCount('SELECT count(*)::int n FROM channels WHERE server_id IS NULL')).toBe(0);
        expect(await ownerCount('SELECT count(*)::int n FROM channels WHERE server_id = $1', [S2.serverId])).toBeGreaterThan(0);

        expect(countOf(await probe(outsider.userId, 'SELECT count(*)::int n FROM channels'), 'outsider SELECT')).toBe(0);
        expect(countOf(await probe(member.userId, 'SELECT count(*)::int n FROM channels'), 'member SELECT')).toBe(expected);

        const update = 'UPDATE channels SET name = name WHERE id = $1';
        await expectOwnerWrites(update, [S.channelId], 'channel update');
        expectNoEffect(await probe(outsider.userId, update, [S.channelId]), 'outsider UPDATE');

        // No DELETE policy: deny-all, for members too
        const del = 'DELETE FROM channels WHERE id = $1';
        await expectOwnerWrites(del, [secondChannelId], 'channel delete');
        expectNoEffect(await probe(outsider.userId, del, [secondChannelId]), 'outsider DELETE');
        expectNoEffect(await probe(member.userId, del, [secondChannelId]), 'member DELETE');

        const insert = `INSERT INTO channels (id, channel_type, server_id, name) VALUES ($1, 3, $2, 'probe')`;
        await expectOwnerWrites(insert, [generateUlid(), S.serverId], 'channel insert');
        expectRaised(await probe(outsider.userId, insert, [generateUlid(), S.serverId]), 'outsider INSERT', RLS_CHECK);
        expectRaised(await probe(member.userId, insert, [generateUlid(), S2.serverId]), 'member INSERT into S2', RLS_CHECK);
    });
});

// ═══════════════════════════════════════════════════════════════
// S0522 015_file_sharing, S0544 057_bot_file_visibility: files
// ═══════════════════════════════════════════════════════════════
describe('015_file_sharing (S0522) and 057_bot_file_visibility (S0544)', () => {
    const filesInServer = `SELECT count(*)::int n FROM files f JOIN channels c ON c.id = f.channel_id WHERE c.server_id = $1`;

    it(`${T} files (015): outsider sees 0 and cannot UPDATE/DELETE/impersonate; member sees exactly S's files`, async () => {
        const expected = await ownerCount(filesInServer, [S.serverId]);
        expect(expected).toBe(3);
        expect(await ownerCount('SELECT count(*)::int n FROM files WHERE channel_id IS NULL')).toBe(0);
        expect(await ownerCount(filesInServer, [S2.serverId])).toBeGreaterThan(0);

        expect(countOf(await probe(outsider.userId, 'SELECT count(*)::int n FROM files'), 'outsider SELECT')).toBe(0);
        expect(countOf(await probe(member.userId, 'SELECT count(*)::int n FROM files'), 'member SELECT')).toBe(expected);

        const update = 'UPDATE files SET filename = filename WHERE id = $1';
        const del = 'DELETE FROM files WHERE id = $1';
        await expectOwnerWrites(update, [memberFileId], 'file update');
        await expectOwnerWrites(del, [memberFileId], 'file delete');
        expectNoEffect(await probe(outsider.userId, update, [memberFileId]), 'outsider UPDATE');
        expectNoEffect(await probe(outsider.userId, del, [memberFileId]), 'outsider DELETE');

        // files_update / files_delete: the uploader only, even inside the server
        expectNoEffect(await probe(member.userId, update, [ownerSecondFileId]), "member UPDATE of the owner's file");
        expectNoEffect(await probe(member.userId, del, [ownerSecondFileId]), "member DELETE of the owner's file");
        const own = await probe(member.userId, update, [memberFileId]);
        expect(own.ok && own.rowCount, describeResult(own)).toBe(1);

        // files_insert: the uploader must be the current user
        const insert = `INSERT INTO files (id, uploader_id, channel_id, filename, size_bytes, bucket, path) VALUES ($1, $2, $3, 'x', 1, 'files', 'x')`;
        await expectOwnerWrites(insert, [generateUlid(), member.userId, S.channelId], 'file insert');
        expectRaised(await probe(outsider.userId, insert, [generateUlid(), member.userId, S.channelId]), 'outsider INSERT as the member', RLS_CHECK);
    });

    // FINDING: files INSERT policy files_insert only checks uploader_id = current user
    // (src/db/migrations/015_file_sharing.sql:69-74), not channel access: an outsider can
    // insert a file row into any server's channel, which that server's members then see.
    // Uploads today go through storeFile() on a separate owner connection, after the
    // route's check, so RLS is not what stops this.
    it(`${T} files (015): outsider INSERT of their own file into the member's channel raises`, async () => {
        const insert = `INSERT INTO files (id, uploader_id, channel_id, filename, size_bytes, bucket, path) VALUES ($1, $2, $3, 'x', 1, 'files', 'x')`;
        await expectOwnerWrites(insert, [generateUlid(), outsider.userId, S.channelId], 'file insert');
        expectRaised(await probe(outsider.userId, insert, [generateUlid(), outsider.userId, S.channelId]), 'outsider INSERT into S channel');
    });

    it(`${T} files (015): member UPDATE ... WHERE id moving their file into another server's channel raises`, async () => {
        // An UPDATE whose WHERE reads the table also needs SELECT rights, so PostgreSQL
        // checks the new row against the SELECT policies too: the member cannot see S2.
        const move = 'UPDATE files SET channel_id = $2 WHERE id = $1';
        await expectOwnerWrites(move, [memberFileId, S2.channelId], 'file move');
        expectRaised(await probe(member.userId, move, [memberFileId, S2.channelId]), 'member moves file into S2', RLS_CHECK);
    });

    // FINDING: files UPDATE policy files_update has no WITH CHECK
    // (src/db/migrations/015_file_sharing.sql:76-81), so for an UPDATE that does not read
    // the table (no WHERE) the only check on the new row is "uploader = me": the member
    // moves every file they uploaded into a channel of a server they are not in.
    it(`${T} files (015): member UPDATE (no WHERE) moving their files into another server's channel raises or affects 0 rows`, async () => {
        const move = 'UPDATE files SET channel_id = $1';
        await expectOwnerWrites(move, [S2.channelId], 'file move');
        expectNoEffect(await probe(member.userId, move, [S2.channelId]), 'member moves files into S2');
    });

    // FINDING: same missing WITH CHECK (015_file_sharing.sql:76-81) together with
    // files_select's "channel_id IS NULL" branch (015_file_sharing.sql:47-50): an uploader
    // can detach their file from its channel, and every user on the instance can then read it.
    it(`${T} files (015): member UPDATE detaching their file from its channel (channel_id NULL) raises or affects 0 rows`, async () => {
        const detach = 'UPDATE files SET channel_id = NULL WHERE id = $1';
        await expectOwnerWrites(detach, [memberFileId], 'file detach');
        expectNoEffect(await probe(member.userId, detach, [memberFileId]), 'member detaches file');
    });

    it(`${T} files (057 files_bot_select): a bot sees exactly the files of channels it was given`, async () => {
        const expected = await ownerCount('SELECT count(*)::int n FROM files WHERE channel_id = $1', [S.channelId]);
        expect(expected).toBe(2);
        // #second's file is in the bot's server but not in a channel it was given
        expect(await ownerCount('SELECT count(*)::int n FROM files WHERE channel_id = $1', [secondChannelId])).toBe(1);
        expect(countOf(await probe(botId, 'SELECT count(*)::int n FROM files'), 'bot SELECT')).toBe(expected);
        const ids = (await probe(botId, 'SELECT id FROM files')) as any;
        expect(ids.rows.map((r: any) => r.id.trim())).not.toContain(ownerSecondFileId);
        // SELECT-only policy: no writes for the bot
        expectNoEffect(await probe(botId, 'UPDATE files SET filename = filename WHERE id = $1', [memberFileId]), 'bot UPDATE');
        expectNoEffect(await probe(botId, 'DELETE FROM files WHERE id = $1', [memberFileId]), 'bot DELETE');
    });
});

// ═══════════════════════════════════════════════════════════════
// S0523 016_bot_infrastructure, S0524 018_channels_update_policy: channels
// ═══════════════════════════════════════════════════════════════
describe('016_bot_infrastructure (S0523) and 018_channels_update_policy (S0524)', () => {
    it(`${T} channels (016 channels_bot_select): a bot sees exactly the channels it was given, and cannot write`, async () => {
        const expected = await ownerCount('SELECT count(*)::int n FROM bot_channel_access WHERE bot_id = $1', [botId]);
        expect(expected).toBe(1);
        const r = await probe(botId, 'SELECT id FROM channels');
        expect(r.ok, describeResult(r)).toBe(true);
        expect((r as any).rows.map((c: any) => c.id.trim())).toEqual([S.channelId]);
        expectNoEffect(await probe(botId, 'UPDATE channels SET name = name WHERE id = $1', [S.channelId]), 'bot UPDATE');
        expectRaised(await probe(botId, `INSERT INTO channels (id, channel_type, server_id, name) VALUES ($1, 3, $2, 'b')`,
            [generateUlid(), S.serverId]), 'bot INSERT', RLS_CHECK);
        // A bot of S2 sees none of S's channels
        const r2 = await probe(bot2Id, 'SELECT id FROM channels');
        expect((r2 as any).rows.map((c: any) => c.id.trim())).toEqual([S2.channelId]);
    });

    it(`${T} channels (018 channels_update): member UPDATE reaches exactly S's channels; outsider reaches none`, async () => {
        const expected = await ownerCount('SELECT count(*)::int n FROM channels WHERE server_id = $1', [S.serverId]);
        const all = 'UPDATE channels SET name = name WHERE server_id IN ($1, $2)';
        await expectOwnerWrites(all, [S.serverId, S2.serverId], 'channels update');
        const m = await probe(member.userId, all, [S.serverId, S2.serverId]);
        expect(m.ok && m.rowCount, describeResult(m)).toBe(expected);
        expectNoEffect(await probe(outsider.userId, all, [S.serverId, S2.serverId]), 'outsider UPDATE');
        // The new row must stay in a server the member is in (WITH CHECK defaults to USING)
        expectRaised(await probe(member.userId, 'UPDATE channels SET server_id = $2 WHERE id = $1', [S.channelId, S2.serverId]),
            'member moves channel into S2', RLS_CHECK);
    });
});

// ═══════════════════════════════════════════════════════════════
// S0527 034_file_tags
// ═══════════════════════════════════════════════════════════════
describe('034_file_tags (S0527)', () => {
    it(`${T} file_tag_definitions (034): outsider sees 0 and cannot write; member sees and writes exactly S's`, async () => {
        const expected = await ownerCount('SELECT count(*)::int n FROM file_tag_definitions WHERE server_id = $1', [S.serverId]);
        expect(expected).toBe(1);
        expect(countOf(await probe(outsider.userId, 'SELECT count(*)::int n FROM file_tag_definitions'), 'outsider SELECT')).toBe(0);
        expect(countOf(await probe(member.userId, 'SELECT count(*)::int n FROM file_tag_definitions'), 'member SELECT')).toBe(expected);

        const update = 'UPDATE file_tag_definitions SET name = name WHERE id = $1';
        const del = 'DELETE FROM file_tag_definitions WHERE id = $1';
        await expectOwnerWrites(update, [S.tagDefId], 'tag update');
        await expectOwnerWrites(del, [S.tagDefId], 'tag delete');
        expectNoEffect(await probe(outsider.userId, update, [S.tagDefId]), 'outsider UPDATE');
        expectNoEffect(await probe(outsider.userId, del, [S.tagDefId]), 'outsider DELETE');
        expectNoEffect(await probe(member.userId, update, [S2.tagDefId]), 'member UPDATE of S2');

        const insert = `INSERT INTO file_tag_definitions (id, server_id, name, instructions) VALUES ($1, $2, 'p2', 'q')`;
        await expectOwnerWrites(insert, [generateUlid(), S.serverId], 'tag insert');
        expectRaised(await probe(outsider.userId, insert, [generateUlid(), S.serverId]), 'outsider INSERT', RLS_CHECK);
        // Any member may write at the RLS level; the routes restrict writes to administrators
        const m = await probe(member.userId, 'UPDATE file_tag_definitions SET name = name WHERE server_id IN ($1, $2)', [S.serverId, S2.serverId]);
        expect(m.ok && m.rowCount, describeResult(m)).toBe(expected);
    });

    // file_tags and file_tag_jobs: SELECT grant only; rows are visible where their file is.
    for (const table of ['file_tags', 'file_tag_jobs'] as const) {
        it(`${T} ${table} (034): outsider sees 0; member sees exactly S's; writes are not granted`, async () => {
            const expected = await ownerCount(
                `SELECT count(*)::int n FROM ${table} t JOIN files f ON f.id = t.file_id JOIN channels c ON c.id = f.channel_id WHERE c.server_id = $1`,
                [S.serverId]);
            expect(expected).toBe(1);
            expect(countOf(await probe(outsider.userId, `SELECT count(*)::int n FROM ${table}`), 'outsider SELECT')).toBe(0);
            expect(countOf(await probe(member.userId, `SELECT count(*)::int n FROM ${table}`), 'member SELECT')).toBe(expected);
            // Only the worker, as table owner, writes these (no INSERT/UPDATE/DELETE grant)
            for (const who of [outsider.userId, member.userId]) {
                expectRaised(await probe(who, `UPDATE ${table} SET file_id = file_id WHERE file_id = $1`, [S.fileId]), 'UPDATE', NO_GRANT);
                expectRaised(await probe(who, `DELETE FROM ${table} WHERE file_id = $1`, [S.fileId]), 'DELETE', NO_GRANT);
                expectRaised(await probe(who, `INSERT INTO ${table} SELECT * FROM ${table} WHERE file_id = $1`, [S.fileId]), 'INSERT', NO_GRANT);
            }
        });
    }
});

// ═══════════════════════════════════════════════════════════════
// S0530 037_agent_sessions: agent_profiles, agent_sessions (member read)
// ═══════════════════════════════════════════════════════════════
describe('037_agent_sessions (S0530): member-readable tables', () => {
    for (const table of ['agent_profiles', 'agent_sessions'] as const) {
        it(`${T} ${table} (037): outsider sees 0; member sees exactly S's; writes are not granted`, async () => {
            const expected = await ownerCount(`SELECT count(*)::int n FROM ${table} WHERE server_id = $1`, [S.serverId]);
            expect(expected).toBe(1);
            expect(await ownerCount(`SELECT count(*)::int n FROM ${table} WHERE server_id = $1`, [S2.serverId])).toBe(1);
            expect(countOf(await probe(outsider.userId, `SELECT count(*)::int n FROM ${table}`), 'outsider SELECT')).toBe(0);
            expect(countOf(await probe(member.userId, `SELECT count(*)::int n FROM ${table}`), 'member SELECT')).toBe(expected);
            // Bots are not server members: the policy shows them nothing
            expect(countOf(await probe(botId, `SELECT count(*)::int n FROM ${table}`), 'bot SELECT')).toBe(0);
            // Writes go through asService (src/lib/agent-sessions.ts); app_user has SELECT only
            const id = table === 'agent_profiles' ? S.profileId : S.sessionId;
            for (const who of [outsider.userId, member.userId]) {
                expectRaised(await probe(who, `UPDATE ${table} SET id = id WHERE id = $1`, [id]), 'UPDATE', NO_GRANT);
                expectRaised(await probe(who, `DELETE FROM ${table} WHERE id = $1`, [id]), 'DELETE', NO_GRANT);
                expectRaised(await probe(who, `INSERT INTO ${table} SELECT * FROM ${table} WHERE id = $1`, [id]), 'INSERT', NO_GRANT);
            }
        });
    }
});

// ═══════════════════════════════════════════════════════════════
// Service-only tables: RLS enabled, no policy and no grant to app_user. Every access is
// as the table owner, through asService or a separate owner connection, after the
// route's own checks. Outsider AND member are both refused (permission denied), which is
// the pass condition; the owner connection still sees the seeded row.
// ═══════════════════════════════════════════════════════════════
interface ServiceOnly { table: string; migration: string; ledger: string; key: string; id: (s: Seed) => string }
const serviceOnly: ServiceOnly[] = [
    { table: 'agent_hosts', migration: '037', ledger: 'S0530', key: 'id', id: (s) => s.hostId },
    { table: 'agent_session_threads', migration: '037', ledger: 'S0530', key: 'thread_id', id: (s) => s.messageId },
    { table: 'agent_batches', migration: '037', ledger: 'S0530', key: 'id', id: (s) => s.batchId },
    { table: 'agent_inbox', migration: '037', ledger: 'S0530', key: 'id', id: (s) => s.inboxId },
    { table: 'agent_runs', migration: '037', ledger: 'S0530', key: 'id', id: (s) => s.runId },
    { table: 'agent_file_reservations', migration: '041', ledger: 'S0531', key: 'id', id: (s) => s.reservationId },
    { table: 'agent_tool_requests', migration: '042', ledger: 'S0532', key: 'id', id: (s) => s.toolRequestId },
    { table: 'agent_run_images', migration: '045', ledger: 'S0535', key: 'run_id', id: (s) => s.runId },
    { table: 'agent_run_approvals', migration: '046', ledger: 'S0536', key: 'id', id: (s) => s.approvalId },
    { table: 'agent_workspace_commands', migration: '047', ledger: 'S0537', key: 'id', id: (s) => s.commandId },
    { table: 'agent_checkpoints', migration: '047', ledger: 'S0537', key: 'id', id: (s) => s.checkpointId },
    { table: 'permission_relays', migration: '049', ledger: 'S0539', key: 'id', id: (s) => s.relayId },
    { table: 'agent_plan_connections', migration: '050', ledger: 'S0540', key: 'profile_id', id: (s) => s.profileId },
    { table: 'channel_projects', migration: '051', ledger: 'S0541', key: 'channel_id', id: (s) => s.channelId },
    { table: 'channel_project_files', migration: '051', ledger: 'S0541', key: 'channel_id', id: (s) => s.channelId },
    { table: 'task_cards', migration: '052', ledger: 'S0542', key: 'id', id: (s) => s.cardId },
    { table: 'artifacts', migration: '053', ledger: 'S0543', key: 'id', id: (s) => s.artifactId },
    { table: 'artifact_versions', migration: '053', ledger: 'S0543', key: 'artifact_id', id: (s) => s.artifactId },
    { table: 'browser_previews', migration: '053', ledger: 'S0543', key: 'id', id: (s) => s.previewId },
    { table: 'agent_handoffs', migration: '058', ledger: 'S0545', key: 'id', id: (s) => s.handoffId },
    { table: 'agent_thread_owners', migration: '058', ledger: 'S0545', key: 'thread_id', id: (s) => s.messageId },
];

describe('service-only tables (no app_user grant)', () => {
    for (const t of serviceOnly) {
        it(`${T} ${t.table} (${t.migration}, ${t.ledger}): service-only, outsider and member are both denied`, async () => {
            const id = t.id(S);
            expect(await ownerCount(`SELECT count(*)::int n FROM ${t.table} WHERE ${t.key} = $1`, [id])).toBe(1);
            // RLS enabled with zero policies, and no grant: double-locked for app_user
            const meta = await ctx.db.query(
                `SELECT c.relrowsecurity, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
                        has_table_privilege('app_user', c.oid, 'SELECT') AS can_select
                 FROM pg_class c WHERE c.relname = $1 AND c.relnamespace = 'public'::regnamespace`, [t.table]);
            expect(meta.rows[0]).toEqual({ relrowsecurity: true, policies: 0, can_select: false });

            for (const [who, label] of [[outsider.userId, 'outsider'], [member.userId, 'member']] as const) {
                expectRaised(await probe(who, `SELECT count(*)::int n FROM ${t.table}`), `${label} SELECT`, NO_GRANT);
                expectRaised(await probe(who, `UPDATE ${t.table} SET ${t.key} = ${t.key} WHERE ${t.key} = $1`, [id]), `${label} UPDATE`, NO_GRANT);
                expectRaised(await probe(who, `DELETE FROM ${t.table} WHERE ${t.key} = $1`, [id]), `${label} DELETE`, NO_GRANT);
                expectRaised(await probe(who, `INSERT INTO ${t.table} SELECT * FROM ${t.table} WHERE ${t.key} = $1`, [id]), `${label} INSERT`, NO_GRANT);
            }
        });
    }
});

// ═══════════════════════════════════════════════════════════════
// S0533 043_agent_invites: creator-owned (SELECT, INSERT granted)
// ═══════════════════════════════════════════════════════════════
describe('043_agent_invites (S0533)', () => {
    it('062: agent invite INSERT requires matching server and bot ownership or Administrator', async () => {
        const insert = `INSERT INTO agent_invites (id, code_hash, bot_id, server_id, created_by)
            VALUES ($1, repeat('a', 64), $2, $3, $4)`;
        const allowed = await probe(owner.userId, insert, [generateUlid(), botId, S.serverId, owner.userId]);
        expect(allowed.ok && allowed.rowCount, describeResult(allowed)).toBe(1);
        expectRaised(await probe(member.userId, insert, [generateUlid(), botId, S.serverId, member.userId]), 'member without ownership/admin', RLS_CHECK);
        expectRaised(await probe(owner.userId, insert, [generateUlid(), bot2Id, S.serverId, owner.userId]), 'bot from another server', RLS_CHECK);

        // Exercise both permitted member paths without changing the shared fixtures.
        const client = await ctx.db.connect();
        try {
            await client.query('BEGIN');
            await client.query('UPDATE users SET bot_owner_id = $2 WHERE id = $1', [botId, member.userId]);
            await client.query('SET LOCAL ROLE app_user');
            await client.query("SELECT set_config('app.current_user_id', $1, true)", [member.userId]);
            expect((await client.query(insert, [generateUlid(), botId, S.serverId, member.userId])).rowCount).toBe(1);
            await client.query('RESET ROLE');
            // A different, non-owned bot is allowed through an assigned admin role.
            const roleId = generateUlid();
            await client.query("INSERT INTO roles (id, server_id, name, permissions) VALUES ($1, $2, 'invite-admin', 1)", [roleId, S.serverId]);
            await client.query('INSERT INTO member_roles (server_id, user_id, role_id) VALUES ($1, $2, $3)', [S.serverId, member.userId, roleId]);
            await client.query('UPDATE users SET bot_owner_id = $2 WHERE id = $1', [botId, owner.userId]);
            await client.query('SET LOCAL ROLE app_user');
            expect((await client.query('SELECT public.rls_can_create_agent_invite($1, $2) AS allowed', [botId, S.serverId])).rows[0].allowed).toBe(true);
        } finally {
            await client.query('ROLLBACK'); client.release();
        }
    });

    it(`${T} agent_invites (043): outsider sees 0, cannot UPDATE/DELETE or impersonate; the creator sees exactly their own`, async () => {
        expect(await ownerCount('SELECT count(*)::int n FROM agent_invites WHERE created_by = $1', [member.userId])).toBe(1);
        expect(await ownerCount('SELECT count(*)::int n FROM agent_invites')).toBe(3);
        expect(countOf(await probe(outsider.userId, 'SELECT count(*)::int n FROM agent_invites'), 'outsider SELECT')).toBe(0);
        const mine = await probe(member.userId, 'SELECT id FROM agent_invites');
        expect(mine.ok, describeResult(mine)).toBe(true);
        // The owner's invite in the same server stays hidden from the member
        expect((mine as any).rows.map((r: any) => r.id.trim())).toEqual([memberAgentInviteId]);

        // No UPDATE/DELETE grant (redeem runs unauthenticated, as the table owner)
        expectRaised(await probe(outsider.userId, 'UPDATE agent_invites SET id = id WHERE id = $1', [memberAgentInviteId]), 'outsider UPDATE', NO_GRANT);
        expectRaised(await probe(outsider.userId, 'DELETE FROM agent_invites WHERE id = $1', [memberAgentInviteId]), 'outsider DELETE', NO_GRANT);

        const insert = `INSERT INTO agent_invites (id, code_hash, bot_id, server_id, created_by) VALUES ($1, repeat('9', 64), $2, $3, $4)`;
        await expectOwnerWrites(insert, [generateUlid(), botId, S.serverId, member.userId], 'agent invite insert');
        expectRaised(await probe(outsider.userId, insert, [generateUlid(), botId, S.serverId, member.userId]), 'outsider INSERT as the member', RLS_CHECK);
    });

    // FINDING: agent_invites policy agent_invites_creator only checks created_by = current
    // user (src/db/migrations/043_agent_invites.sql:16-18), not that the creator may manage
    // the bot or is in its server. An outsider can insert an invite for another server's bot
    // with a code hash they chose; POST /agent-invites/redeem (unauthenticated, owner role)
    // would then mint a bot token for it. Only the create route's permission check stops it.
    it(`${T} agent_invites (043): outsider INSERT of their own invite for the member's server's bot raises`, async () => {
        const insert = `INSERT INTO agent_invites (id, code_hash, bot_id, server_id, created_by) VALUES ($1, repeat('8', 64), $2, $3, $4)`;
        await expectOwnerWrites(insert, [generateUlid(), botId, S.serverId, outsider.userId], 'agent invite insert');
        expectRaised(await probe(outsider.userId, insert, [generateUlid(), botId, S.serverId, outsider.userId]), 'outsider INSERT for S bot');
    });
});

describe('062 allowed writes and legacy boundaries', () => {
    it('members and explicitly assigned bots can insert their own files only in accessible channels', async () => {
        const insert = `INSERT INTO files (id, uploader_id, channel_id, filename, size_bytes, bucket, path)
            VALUES ($1, $2, $3, 'allowed.txt', 1, 'files', 'allowed')`;
        for (const actor of [member.userId, botId]) {
            const result = await probe(actor, insert, [generateUlid(), actor, S.channelId]);
            expect(result.ok && result.rowCount, describeResult(result)).toBe(1);
            expectRaised(await probe(actor, insert, [generateUlid(), actor, null]), 'new channel-less file', RLS_CHECK);
        }
        expectRaised(await probe(botId, insert, [generateUlid(), botId, secondChannelId]), 'bot without explicit channel access', RLS_CHECK);
    });

    it('legacy channel-less files are visible to their uploader alone', async () => {
        const client = await ctx.db.connect();
        try {
            await client.query('BEGIN');
            const id = generateUlid();
            await client.query("INSERT INTO files (id, uploader_id, filename, size_bytes, bucket, path) VALUES ($1, $2, 'legacy', 1, 'files', 'legacy')", [id, member.userId]);
            await client.query('SET LOCAL ROLE app_user');
            for (const actor of [member.userId, owner.userId, outsider.userId, botId]) {
                await client.query("SELECT set_config('app.current_user_id', $1, true)", [actor]);
                expect((await client.query('SELECT id FROM files WHERE id = $1', [id])).rows).toHaveLength(actor === member.userId ? 1 : 0);
            }
        } finally {
            await client.query('ROLLBACK'); client.release();
        }
    });

    it('members cannot forge another invite creator, and nobody inserts server-less channels', async () => {
        expectRaised(await probe(member.userId, "INSERT INTO server_invites (code, server_id, creator_id) VALUES ('forged', $1, $2)", [S.serverId, owner.userId]), 'forged invite creator', RLS_CHECK);
        for (const actor of [member.userId, outsider.userId]) {
            expectRaised(await probe(actor, "INSERT INTO channels (id, channel_type, name) VALUES ($1, 3, 'serverless')", [generateUlid()]), 'server-less channel', RLS_CHECK);
        }
    });
});

// ═══════════════════════════════════════════════════════════════
// S0534 044_passkeys: user-owned
// ═══════════════════════════════════════════════════════════════
describe('044_passkeys (S0534)', () => {
    it(`${T} user_passkeys (044): another user sees 0 and cannot UPDATE/DELETE/INSERT; the owner sees exactly their own`, async () => {
        expect(await ownerCount('SELECT count(*)::int n FROM user_passkeys')).toBe(2);
        expect(countOf(await probe(outsider.userId, 'SELECT count(*)::int n FROM user_passkeys'), 'outsider SELECT')).toBe(0);
        const mine = await probe(member.userId, 'SELECT id FROM user_passkeys');
        expect(mine.ok, describeResult(mine)).toBe(true);
        expect((mine as any).rows.map((r: any) => r.id.trim())).toEqual([memberPasskeyId]);

        const update = 'UPDATE user_passkeys SET name = name WHERE id = $1';
        const del = 'DELETE FROM user_passkeys WHERE id = $1';
        await expectOwnerWrites(update, [memberPasskeyId], 'passkey update');
        await expectOwnerWrites(del, [memberPasskeyId], 'passkey delete');
        expectNoEffect(await probe(outsider.userId, update, [memberPasskeyId]), 'outsider UPDATE');
        expectNoEffect(await probe(outsider.userId, del, [memberPasskeyId]), 'outsider DELETE');
        // Same server is no exception: the member cannot touch the owner's passkey
        expectNoEffect(await probe(member.userId, update, [ownerPasskeyId]), "member UPDATE of owner's passkey");
        const own = await probe(member.userId, update, [memberPasskeyId]);
        expect(own.ok && own.rowCount, describeResult(own)).toBe(1);
        // Nor re-point their own passkey at someone else
        expectRaised(await probe(member.userId, 'UPDATE user_passkeys SET user_id = $2 WHERE id = $1', [memberPasskeyId, outsider.userId]),
            'member hands passkey to another user', RLS_CHECK);

        const insert = `INSERT INTO user_passkeys (id, user_id, credential_id, public_key, device_type, rp_id, name)
                        VALUES ($1, $2, 'cred-probe', '\\x00', 'singleDevice', 'localhost', 'p')`;
        await expectOwnerWrites(insert, [generateUlid(), member.userId], 'passkey insert');
        expectRaised(await probe(outsider.userId, insert, [generateUlid(), member.userId]), "outsider INSERT for the member", RLS_CHECK);
    });
});

// ═══════════════════════════════════════════════════════════════
// S0538 048_terms_watch: instance-admin only
// ═══════════════════════════════════════════════════════════════
describe('048_terms_watch (S0538)', () => {
    const specs = [
        {
            table: 'terms_documents',
            id: () => termsDocId,
            insert: `INSERT INTO terms_documents (id, name, url, allowed_hosts) VALUES ($1, 'p', 'https://example.com/rls-probe', ARRAY['example.com'])`,
        },
        {
            table: 'terms_changes',
            id: () => termsChangeId,
            insert: `INSERT INTO terms_changes (id, document_id, previous_hash, current_hash, diff, summary, impact, analysis_status)
                     SELECT $1, id, 'a', 'b', 'd', 's', 'low', 'done' FROM terms_documents LIMIT 1`,
        },
    ];
    for (const t of specs) {
        it(`${T} ${t.table} (048): non-admins (outsider and server member) see 0 and cannot write; the admin sees every row`, async () => {
            const expected = await ownerCount(`SELECT count(*)::int n FROM ${t.table}`);
            expect(expected).toBeGreaterThan(0);
            expect(countOf(await probe(outsider.userId, `SELECT count(*)::int n FROM ${t.table}`), 'outsider SELECT')).toBe(0);
            expect(countOf(await probe(member.userId, `SELECT count(*)::int n FROM ${t.table}`), 'member SELECT')).toBe(0);
            expect(countOf(await probe(owner.userId, `SELECT count(*)::int n FROM ${t.table}`), 'server owner SELECT')).toBe(0);
            expect(countOf(await probe(admin.userId, `SELECT count(*)::int n FROM ${t.table}`), 'admin SELECT')).toBe(expected);

            const update = `UPDATE ${t.table} SET id = id WHERE id = $1`;
            const del = `DELETE FROM ${t.table} WHERE id = $1`;
            await expectOwnerWrites(update, [t.id()], 'update');
            await expectOwnerWrites(del, [t.id()], 'delete');
            expectNoEffect(await probe(outsider.userId, update, [t.id()]), 'outsider UPDATE');
            expectNoEffect(await probe(outsider.userId, del, [t.id()]), 'outsider DELETE');
            await expectOwnerWrites(t.insert, [generateUlid()], 'insert');
            // terms_changes' INSERT ... SELECT reads terms_documents, which the outsider cannot
            // see, so it inserts nothing rather than raising: either way no row lands
            const ins = await probe(outsider.userId, t.insert, [generateUlid()]);
            if (t.table === 'terms_documents') expectRaised(ins, 'outsider INSERT', RLS_CHECK);
            else expectNoEffect(ins, 'outsider INSERT');
            const adminIns = await probe(admin.userId, t.insert, [generateUlid()]);
            expect(adminIns.ok && adminIns.rowCount, describeResult(adminIns)).toBe(1);
        });
    }

    it(`${T} terms_changes (048): an outsider INSERT with an explicit document id raises`, async () => {
        const r = await probe(outsider.userId,
            `INSERT INTO terms_changes (id, document_id, previous_hash, current_hash, diff, summary, impact, analysis_status)
             VALUES ($1, $2, 'a', 'b', 'd', 's', 'low', 'done')`, [generateUlid(), termsDocId]);
        expectRaised(r, 'outsider INSERT', RLS_CHECK);
    });
});
