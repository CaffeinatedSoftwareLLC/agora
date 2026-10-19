import { randomBytes } from 'crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { asService } from '../lib/agent-sessions';
import { canViewChannel } from '../lib/channel-access';
import { isServerOwner, stampAuthority } from '../lib/direct-agents';
import { hashClaimToken, postNotice } from '../lib/agent-runs';
import { generateUlid } from '../utils/ulid';

const ID = { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' } as const;
const SHA = { type: 'string', pattern: '^([0-9a-f]{40}|[0-9a-f]{64})$' } as const;
/** Actions only the server owner may queue: rewinding history, forking, and opening a PR with the owner's `gh` login. */
const OWNER_ONLY = ['restore','fork','pr'];
const response = (httpStatus: number, body?: object) => ({ httpStatus, body });
async function respondService(request: FastifyRequest, reply: FastifyReply, fn: () => Promise<any>) {
    const value = await asService(request.dbClient!,fn);
    return value?.httpStatus ? reply.code(value.httpStatus).send(value.body) : value;
}
function emit(request: FastifyRequest, n: Awaited<ReturnType<typeof postNotice>>) {
    (request.pendingEvents ??= []).push({ room: `channel:${n.channelId}`, event: 'Message', data: n.event });
}
async function access(request: FastifyRequest, channelId: string) {
    return (await canViewChannel(request.dbClient!, channelId, request.userId, !!request.isBot)).allowed;
}
async function boundSession(db: any, channelId: string, sessionId: string) {
    // Same lock order as run completion and profile edits.
    const meta = await db.query('SELECT profile_id FROM agent_sessions WHERE id=$1 AND channel_id=$2', [sessionId, channelId]);
    if (!meta.rows[0]) return null;
    await db.query('SELECT 1 FROM agent_profiles WHERE id=$1 FOR SHARE', [meta.rows[0].profile_id]);
    return (await db.query(`SELECT s.*, p.name AS profile, p.host_id, p.generation, p.workdir_alias, p.wake_budget, p.token_budget AS profile_budget
        FROM agent_sessions s JOIN agent_profiles p ON p.id=s.profile_id WHERE s.id=$1 AND s.channel_id=$2 FOR UPDATE OF s`, [sessionId, channelId])).rows[0];
}
export async function workspaceReviewRoutes(app: FastifyInstance) {
    const root = '/channels/:id/sessions/:sessionId';
    app.post(`${root}/workspace-commands`, { schema: { body: {
        type: 'object', additionalProperties: false, required: ['action'], properties: {
            action: { type: 'string', enum: ['diff','discard','commit','merge','pr','restore','fork'] },
            path: { type: 'string', minLength: 1, maxLength: 4096 }, offset: { type: 'integer', minimum: 0, maximum: 131072 },
            revision: {type:'string',pattern:'^[0-9a-f]{64}$'},
            message: { type: 'string', minLength: 1, maxLength: 2000 }, checkpointId: ID,
        },
    } } }, async (request, reply) => {
        const { id, sessionId } = request.params as any, b = request.body as any, db = request.dbClient!;
        if (!await access(request, id)) return reply.code(403).send({ error: 'forbidden' });
        if (b.action !== 'diff' && (request.isBot || !await stampAuthority(db, id, request.userId, false))) return reply.code(403).send({ error: 'cannot_direct' });
        if (b.action === 'discard' && !b.path || b.action === 'commit' && !b.message?.trim()
            || ['restore','fork'].includes(b.action) && !b.checkpointId) return reply.code(400).send({ error: 'missing_argument' });
        if (b.path && (/[\\\x00-\x1f:]/.test(b.path) || b.path.split('/').some((s: string) => !s || s === '.' || s === '..' || /[ .]$/.test(s) || /^(?:\.git(?:[ .~]|$)|git~[0-9]+$)/i.test(s)))) return reply.code(400).send({ error: 'unsafe_path' });
        const r = await asService(db, async () => {
            const s = await boundSession(db, id, sessionId);
            if (!s) return { status: 404, body: { error: 'session_not_found' } };
            // 'pr' runs `gh` with the owner's GitHub login on the host, so directors may not trigger it.
            if (OWNER_ONLY.includes(b.action) && !await isServerOwner(db, s.server_id.trim(), request.userId)) return { status: 403, body: { error: 'owner_only' } };
            if (!(await db.query('SELECT 1 FROM agent_hosts WHERE id=$1 AND revoked_at IS NULL', [s.host_id])).rows.length) return { status: 409, body: { error: 'host_unavailable' } };
            const busy = await db.query(`SELECT 1 FROM agent_runs WHERE session_id=$1 AND status='claimed'
                UNION ALL SELECT 1 FROM agent_workspace_commands WHERE session_id=$1 AND status IN ('queued','claimed')`, [sessionId]);
            if (busy.rows.length) return { status: 409, body: { error: 'session_busy' } };
            const payload: any = { path: b.path, offset: b.offset, revision:b.revision, message: b.message };
            if (['restore','fork'].includes(b.action)) {
                const cp = (await db.query('SELECT sha, ref FROM agent_checkpoints WHERE id=$1 AND session_id=$2', [b.checkpointId, sessionId])).rows[0];
                if (!cp) return { status: 404, body: { error: 'checkpoint_not_found' } };
                payload.checkpoint = cp;
                if (b.action === 'fork') payload.forkSessionId = generateUlid();
            }
            const commandId = generateUlid();
            await db.query(`INSERT INTO agent_workspace_commands (id,session_id,host_id,profile_generation,requested_by,action,payload)
                VALUES ($1,$2,$3,$4,$5,$6,$7)`, [commandId, sessionId, s.host_id, s.generation, request.userId, b.action, payload]);
            return { status: 202, body: { id: commandId, status: 'queued' } };
        });
        return reply.code(r.status).send(r.body);
    });
    app.get(`${root}/workspace-commands/:commandId`, async (request, reply) => {
        const { id, sessionId, commandId } = request.params as any;
        if (!await access(request, id)) return reply.code(403).send({ error: 'forbidden' });
        const row = await asService(request.dbClient!, () => request.dbClient!.query(`SELECT btrim(c.id) AS id,c.action,c.status,c.result FROM agent_workspace_commands c
            JOIN agent_sessions s ON s.id=c.session_id WHERE c.id=$1 AND c.session_id=$2 AND s.channel_id=$3`, [commandId, sessionId, id]));
        return row.rows[0] ?? reply.code(404).send({ error: 'not_found' });
    });
    app.get(`${root}/workspace-commands/latest`, async (request, reply) => {
        const { id, sessionId } = request.params as any;
        if (!await access(request,id)) return reply.code(403).send({error:'forbidden'});
        const rows = await asService(request.dbClient!,()=>request.dbClient!.query(`SELECT btrim(c.id) AS id,c.action,c.payload,c.status,c.result
            FROM agent_workspace_commands c JOIN agent_sessions s ON s.id=c.session_id
            WHERE c.session_id=$1 AND s.channel_id=$2 ORDER BY c.id DESC LIMIT 1`,[sessionId,id]));
        return {command:rows.rows[0]??null};
    });
    app.get(`${root}/checkpoints`, { schema: { querystring: { type: 'object', properties: { before: ID } } } }, async (request, reply) => {
        const { id, sessionId } = request.params as any;
        if (!await access(request, id)) return reply.code(403).send({ error: 'forbidden' });
        const db = request.dbClient!;
        return respondService(request, reply, async () => {
            if (!(await db.query('SELECT 1 FROM agent_sessions WHERE id=$1 AND channel_id=$2', [sessionId,id])).rows.length) return response(404,{ error: 'session_not_found' });
            const rows = (await db.query(`SELECT btrim(c.id) AS id,btrim(c.run_id) AS "runId",btrim(c.message_id) AS "messageId",c.sha,c.ref,c.created_at AS "createdAt"
                FROM agent_checkpoints c WHERE c.session_id=$1 AND ($2::text IS NULL OR c.id<$2) ORDER BY c.id DESC LIMIT 26`, [sessionId,(request.query as any).before ?? null])).rows;
            return { checkpoints: rows.slice(0,25), next: rows.length > 25 ? rows[24].id : null,
                canManage: !request.isBot && !!await stampAuthority(db,id,request.userId,false),
                isOwner: !request.isBot && await isServerOwner(db, (await db.query('SELECT server_id FROM channels WHERE id=$1',[id])).rows[0].server_id.trim(),request.userId) };
        });
    });
    app.get('/agent-hosts/@me/workspace-commands/next', async (request, reply) => {
        const db = request.dbClient!, host = request.agentHost!;
        return respondService(request, reply, async () => {
            if (!(await db.query('SELECT 1 FROM agent_hosts WHERE id=$1 AND server_id=$2 AND revoked_at IS NULL FOR SHARE',[host.id,host.serverId])).rows.length) return response(401,{error:'host_revoked'});
            // Expired claims are terminal: mutations are never automatically replayed.
            const expired = (await db.query(`UPDATE agent_workspace_commands SET status='failed', result='{"error":"host_timeout_check_repository_before_retry"}',finished_at=NOW()
                WHERE host_id=$1 AND status='claimed' AND lease_until<NOW() RETURNING session_id`,[host.id])).rows;
            for (const row of expired) { const s = (await db.query('SELECT channel_id FROM agent_sessions WHERE id=$1',[row.session_id])).rows[0];
                emit(request,await postNotice(db,s.channel_id.trim(),'Workspace command timed out. Check repository state before retrying.')); }
            const candidates = (await db.query(`SELECT c.id,c.session_id,s.channel_id FROM agent_workspace_commands c JOIN agent_sessions s ON s.id=c.session_id
                WHERE c.host_id=$1 AND s.server_id=$2 AND c.status='queued' ORDER BY c.id LIMIT 20`,[host.id,host.serverId])).rows;
            for (const candidate of candidates) {
                const s = await boundSession(db,candidate.channel_id.trim(),candidate.session_id.trim());
                const c = (await db.query(`SELECT * FROM agent_workspace_commands WHERE id=$1 AND status='queued' FOR UPDATE SKIP LOCKED`,[candidate.id])).rows[0];
                if (!s || !c) continue;
                const permitted = c.action === 'diff' ? await canViewChannel(db,s.channel_id.trim(),c.requested_by.trim(),false) : null;
                const authority = c.action === 'diff' ? permitted?.allowed : await stampAuthority(db,s.channel_id.trim(),c.requested_by.trim(),false);
                const ownerOK = !OWNER_ONLY.includes(c.action) || await isServerOwner(db,s.server_id.trim(),c.requested_by.trim());
                if (s.host_id.trim() !== host.id || s.generation !== c.profile_generation || !authority || !ownerOK) {
                    await db.query(`UPDATE agent_workspace_commands SET status='failed',result='{"error":"binding_or_authority_changed"}',finished_at=NOW() WHERE id=$1`,[c.id]);
                    emit(request,await postNotice(db,s.channel_id.trim(),'Workspace command rejected: session binding or authority changed.')); continue;
                }
                if ((await db.query(`SELECT 1 FROM agent_runs WHERE session_id=$1 AND status='claimed'`,[s.id])).rows.length) continue;
                const token = randomBytes(32).toString('hex');
                await db.query(`UPDATE agent_workspace_commands SET status='claimed',claim_token_hash=$2,lease_until=NOW()+INTERVAL '180 seconds' WHERE id=$1`,[c.id,hashClaimToken(token)]);
                return { id:c.id.trim(),claimToken:token,sessionId:s.id.trim(),profile:s.profile,workdirAlias:s.workdir_alias,action:c.action,payload:c.payload };
            }
            return response(204);
        });
    });
    app.post('/agent-hosts/@me/workspace-commands/:commandId/result', { schema: { body: {
        type:'object',additionalProperties:false,required:['claimToken','success','result'],properties:{
            claimToken:{type:'string',minLength:10,maxLength:200},success:{type:'boolean'},result:{type:'object',additionalProperties:false,properties:{
                error:{type:'string',maxLength:120},message:{type:'string',maxLength:4096},url:{type:'string',maxLength:2048},
                diff:{type:'string',maxLength:20000},path:{type:'string',maxLength:4096},files:{type:'array',maxItems:30,items:{type:'string',maxLength:4096}},
                next:{type:['integer','null'],minimum:0,maximum:131072},truncated:{type:'boolean'},branch:{type:'string',maxLength:128},baseSha:SHA,headSha:SHA,sessionId:ID,
                revision:{type:'string',pattern:'^[0-9a-f]{64}$'},
            }},
        },
    } } }, async (request,reply) => {
        const db=request.dbClient!,host=request.agentHost!,{commandId}=request.params as any,b=request.body as any;
        return respondService(request,reply,async()=>{
            if (!(await db.query('SELECT 1 FROM agent_hosts WHERE id=$1 AND server_id=$2 AND revoked_at IS NULL FOR SHARE',[host.id,host.serverId])).rows.length) return response(401,{error:'host_revoked'});
            const meta=(await db.query(`SELECT c.session_id,s.channel_id FROM agent_workspace_commands c JOIN agent_sessions s ON s.id=c.session_id
                WHERE c.id=$1 AND c.host_id=$2 AND s.server_id=$3`,[commandId,host.id,host.serverId])).rows[0];
            if (!meta) return response(404,{error:'not_found'});
            const s=await boundSession(db,meta.channel_id.trim(),meta.session_id.trim());
            const c=(await db.query('SELECT *,lease_until<=NOW() AS expired FROM agent_workspace_commands WHERE id=$1 FOR UPDATE',[commandId])).rows[0];
            if (c.claim_token_hash!==hashClaimToken(b.claimToken)) return response(409,{error:'stale_claim'});
            if (['succeeded','failed'].includes(c.status)) return {ok:true,repeated:true};
            if(c.status!=='claimed'||c.expired||s.host_id.trim()!==host.id||s.generation!==c.profile_generation) return response(409,{error:'binding_or_lease_changed'});
            if(b.success && c.action==='restore' && b.result.headSha!==c.payload.checkpoint.sha) return response(400,{error:'invalid_restore_result'});
            if(b.success && c.action==='commit' && !b.result.headSha) return response(400,{error:'invalid_commit_result'});
            if(b.success&&c.action==='fork') {
                const target=c.payload.forkSessionId,sha=c.payload.checkpoint.sha,branch=`agora/${s.profile}/${target}`;
                if(b.result.sessionId!==target||b.result.branch!==branch||b.result.baseSha!==sha||b.result.headSha!==sha) return response(400,{error:'invalid_fork_result'});
                await db.query(`INSERT INTO agent_sessions (id,server_id,channel_id,profile_id,bot_id,state,started_by,workspace_id,branch,base_sha,head_sha,summary)
                    VALUES ($1,$2,$3,$4,$5,'shelved',$6,$7,$8,$9,$9,$10)`,[target,s.server_id,s.channel_id,s.profile_id,s.bot_id,c.requested_by,s.workspace_id,branch,sha,`Forked from ${s.id.trim()} at ${sha}`]);
            }
            if(b.success&&['restore','commit'].includes(c.action)&&b.result.headSha) await db.query('UPDATE agent_sessions SET head_sha=$2,native_session_id=NULL WHERE id=$1',[s.id,b.result.headSha]);
            if(b.success&&c.action==='restore') {
                await db.query(`UPDATE agent_sessions SET native_session_id=NULL,summary=$2 WHERE id=$1`,[s.id,`Restored checkpoint ${c.payload.checkpoint.sha}. Read channel history for context.`]);
                await db.query(`UPDATE agent_inbox SET acked_at=NOW() WHERE session_id=$1 AND acked_at IS NULL`,[s.id]);
                await db.query(`UPDATE agent_batches SET status='dropped',finished_at=NOW() WHERE session_id=$1 AND status='retry'`,[s.id]);
            }
            await db.query('UPDATE agent_workspace_commands SET status=$2,result=$3,finished_at=NOW() WHERE id=$1',[c.id,b.success?'succeeded':'failed',b.result]);
            // Every action's result is a system notice; previews keep patch text out of chat.
            emit(request,await postNotice(db,s.channel_id.trim(),`Workspace ${c.action} ${b.success?'completed':'failed'} for session ${s.id.trim()}: ${b.result.error??b.result.message??'Review ready in the session sheet.'}${b.result.url?' '+b.result.url:''}`));
            return {ok:true};
        });
    });
}
