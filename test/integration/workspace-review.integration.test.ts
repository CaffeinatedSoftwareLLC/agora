import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';
import { Permissions } from '../../src/permissions';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>, member: typeof owner, outsider: typeof owner;
let serverId:string,channel:string,second:string,hostId:string,profileId:string,botId:string,sessionId:string;
let hostAuth:object,otherHostAuth:object,botAuth:object;
const sha='a'.repeat(40);
const root=()=>`/channels/${channel}/sessions/${sessionId}`;
const queue=(body:object,auth:object=owner.auth)=>ctx.request.post(`${root()}/workspace-commands`).set(auth).send(body);
const next=()=>ctx.request.get('/agent-hosts/@me/workspace-commands/next').set(hostAuth);
const result=(c:any,success=true,data:object={message:'done',headSha:sha},auth=hostAuth)=>ctx.request.post(`/agent-hosts/@me/workspace-commands/${c.id}/result`).set(auth).send({claimToken:c.claimToken,success,result:data});
const list=()=>ctx.request.get(`${root()}/checkpoints`).set(owner.auth);
async function claimRun() {
    const res=await ctx.request.get('/agent-hosts/@me/runs/next?wait=0').set(hostAuth);
    expect(res.status,JSON.stringify(res.body)).toBe(200);return res.body;
}
async function saveCheckpoint(failed=false) {
    const c=await claimRun();const cp={sha,ref:`refs/agora/checkpoints/${sessionId}/1`};
    const res=await ctx.request.post(`/agent-hosts/@me/runs/${c.run.id}/${failed?'fail':'complete'}`).set(hostAuth)
        .send({claimToken:c.run.claimToken,checkpoint:cp,...(failed?{error:'cli_failed',retryable:false}:{branch:`agora/builder/${sessionId}`,baseSha:'b'.repeat(40),headSha:sha})});
    expect(res.status,JSON.stringify(res.body)).toBe(200);return {claim:c,checkpoint:(await list()).body.checkpoints[0]};
}
beforeAll(async()=>{
    ctx=await setupTestApp();await cleanDatabase(ctx.db);
    owner=await authedUser(ctx.request,'reviewowner');member=await authedUser(ctx.request,'reviewmember');outsider=await authedUser(ctx.request,'reviewoutsider');
    const server=await createServer(ctx.request,owner.auth,'Review');serverId=server.serverId;channel=server.generalChannelId;
    await joinViaInvite(ctx.request,owner.auth,member.auth,serverId);
    second=(await ctx.request.post(`/servers/${serverId}/channels`).set(owner.auth).send({name:'other',channelType:3})).body.id;
    const host=await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({name:'review-host'});hostId=host.body.host.id;hostAuth={Authorization:`AgentHost ${host.body.token}`};
    const other=await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({name:'other-host'});otherHostAuth={Authorization:`AgentHost ${other.body.token}`};
    const agent=await ctx.request.post(`/servers/${serverId}/agents`).set(owner.auth).send({name:'builder',hostId,adapter:'codex',workdirAlias:'agora',channelId:channel});
    expect(agent.status).toBe(201);profileId=agent.body.profile.id;botId=agent.body.bot.id;botAuth={Authorization:`Bot ${agent.body.token}`};
});
afterAll(async()=>{await ctx.close();});
beforeEach(async()=>{
    await ctx.db.query('TRUNCATE agent_sessions CASCADE');
    await ctx.db.query('UPDATE agent_profiles SET generation=1,workdir_alias=$2 WHERE id=$1',[profileId,'agora']);
    await ctx.db.query('UPDATE agent_hosts SET revoked_at=NULL WHERE id=$1',[hostId]);
    await ctx.db.query('TRUNCATE channel_member_overrides');
    const start=await ctx.request.post(`/channels/${channel}/agent-commands`).set(owner.auth).send({command:'start',profile:'builder'});
    expect(start.status,JSON.stringify(start.body)).toBe(201);sessionId=start.body.session.id;
});
it('requires user auth and channel access; only human owner/directors mutate',async()=>{
    expect((await ctx.request.post(`${root()}/workspace-commands`).send({action:'diff'})).status).toBe(401);
    expect((await queue({action:'diff'},outsider.auth)).status).toBe(403);
    expect((await queue({action:'commit',message:'x'},member.auth)).status).toBe(403);
    expect((await queue({action:'commit',message:'x'},botAuth)).status).toBe(403);
    expect((await queue({action:'diff'},member.auth)).status).toBe(202);
    const c=(await next()).body;expect(c.sessionId).toBe(sessionId);expect(c.profile).toBe('builder');expect(c.workdirAlias).toBe('agora');
    expect((await result(c,true,{files:['a'],next:null,truncated:false})).status).toBe(200);
});
it('allows director commit/merge/discard, but restore, fork and PR need the owner',async()=>{
    const cp=(await saveCheckpoint()).checkpoint;
    await ctx.db.query(`INSERT INTO channel_member_overrides (channel_id,user_id,allow,deny) VALUES ($1,$2,$3,0)`,[channel,member.userId,Permissions.DirectAgents.toString()]);
    for(const action of ['commit','merge','discard']) {
        const q=await queue({action,message:'test',path:'a.txt'},member.auth);expect(q.status,JSON.stringify(q.body)).toBe(202);
        const c=(await next()).body;expect((await result(c)).status).toBe(200);
    }
    expect((await queue({action:'restore',checkpointId:cp.id},member.auth)).status).toBe(403);
    expect((await queue({action:'fork',checkpointId:cp.id},member.auth)).status).toBe(403);
    const view=await ctx.request.get(`${root()}/checkpoints`).set(member.auth);expect(view.body).toMatchObject({canManage:true,isOwner:false});
});
it('opening a GitHub PR is owner-only: it uses the owner gh login on the host',async()=>{
    await ctx.db.query(`INSERT INTO channel_member_overrides (channel_id,user_id,allow,deny) VALUES ($1,$2,$3,0)`,[channel,member.userId,Permissions.DirectAgents.toString()]);
    const denied=await queue({action:'pr',message:'test'},member.auth);
    expect(denied.status).toBe(403);expect(denied.body.error).toBe('owner_only');
    expect((await next()).status).toBe(204);
    const q=await queue({action:'pr',message:'test'},owner.auth);expect(q.status,JSON.stringify(q.body)).toBe(202);
    const c=(await next()).body;expect(c.action).toBe('pr');expect((await result(c,true,{message:'opened',url:'https://github.com/o/r/pull/1'})).status).toBe(200);
});
it('binds commands and results to a session, channel, host and claim token',async()=>{
    const q=await queue({action:'diff'});expect(q.status).toBe(202);const c=(await next()).body;
    expect((await ctx.request.get(`${root()}/workspace-commands/latest`).set(member.auth)).body.command).toMatchObject({id:c.id,status:'claimed',action:'diff'});
    expect((await ctx.request.get(`/channels/${second}/sessions/${sessionId}/workspace-commands/latest`).set(owner.auth)).body.command).toBeNull();
    expect((await ctx.request.get(`${root()}/workspace-commands/latest`).set(outsider.auth)).status).toBe(403);
    expect((await ctx.request.get('/agent-hosts/@me/workspace-commands/next').set(otherHostAuth)).status).toBe(204);
    expect((await result(c,true,{},otherHostAuth)).status).toBe(404);
    expect((await result({...c,claimToken:'wrong-claim-token'})).status).toBe(409);
    expect((await ctx.request.get(`/channels/${second}/sessions/${sessionId}/workspace-commands/${c.id}`).set(owner.auth)).status).toBe(404);
    expect((await ctx.request.post(`/channels/${second}/sessions/${sessionId}/workspace-commands`).set(owner.auth).send({action:'diff'})).status).toBe(404);
    expect((await result(c,true,{files:['literal.txt'],next:null})).status).toBe(200);
    expect((await result(c,true,{files:['different']})).body.repeated).toBe(true);
    const read=await ctx.request.get(`${root()}/workspace-commands/${c.id}`).set(member.auth);expect(read.body.result.files).toEqual(['literal.txt']);
    expect((await ctx.request.get(`${root()}/workspace-commands/${c.id}`).set(outsider.auth)).status).toBe(403);
});
it('serializes commands and prevents run claims while review owns the session',async()=>{
    const queued=await Promise.all([queue({action:'diff'}),queue({action:'diff'})]);expect(queued.map(r=>r.status).sort()).toEqual([202,409]);
    expect((await ctx.request.get('/agent-hosts/@me/runs/next?wait=0').set(hostAuth)).status).toBe(204);
    const c=(await next()).body;expect((await next()).status).toBe(204);
    expect((await queue({action:'commit',message:'x'})).body.error).toBe('session_busy');
    await result(c);const run=await claimRun();expect((await queue({action:'diff'})).status).toBe(409);
    await ctx.request.post(`/agent-hosts/@me/runs/${run.run.id}/complete`).set(hostAuth).send({claimToken:run.run.claimToken});
    expect((await queue({action:'diff'})).status).toBe(202);
});
it('fences profile edits at claim and result, and rechecks authority before execution',async()=>{
    await queue({action:'commit',message:'x'});await ctx.db.query('UPDATE agent_profiles SET generation=generation+1 WHERE id=$1',[profileId]);
    expect((await next()).status).toBe(204);
    await queue({action:'diff'});const c=(await next()).body;await ctx.db.query('UPDATE agent_profiles SET generation=generation+1 WHERE id=$1',[profileId]);
    expect((await result(c)).status).toBe(409);
    await ctx.db.query(`UPDATE agent_workspace_commands SET status='failed' WHERE session_id=$1`,[sessionId]);
    await ctx.db.query(`INSERT INTO channel_member_overrides (channel_id,user_id,allow,deny) VALUES ($1,$2,$3,0)`,[channel,member.userId,Permissions.DirectAgents.toString()]);
    await queue({action:'commit',message:'x'},member.auth);
    await ctx.db.query('TRUNCATE channel_member_overrides');expect((await next()).status).toBe(204);
});
it('never replays expired mutations and posts success, failure and timeout notices',async()=>{
    await queue({action:'commit',message:'x'});const c=(await next()).body;
    await ctx.db.query(`UPDATE agent_workspace_commands SET lease_until=NOW()-INTERVAL '1 second' WHERE id=$1`,[c.id]);
    expect((await result(c)).status).toBe(409);expect((await next()).status).toBe(204);expect((await next()).status).toBe(204);
    const row=(await ctx.db.query('SELECT * FROM agent_workspace_commands WHERE id=$1',[c.id])).rows[0];expect(row.status).toBe('failed');
    await queue({action:'pr'});const pr=(await next()).body;await result(pr,false,{error:'gh_unavailable'});
    const notices=(await ctx.db.query(`SELECT content FROM messages WHERE channel_id=$1 AND author_id IS NULL ORDER BY created_at`,[channel])).rows.map(r=>r.content).join('\n');
    expect(notices).toContain('timed out');expect(notices).toContain('Workspace pr failed');
});
it('saves checkpoints for successful and failed runs, linked to the triggering message',async()=>{
    const {checkpoint:cp,claim:c}=await saveCheckpoint();expect(cp).toMatchObject({runId:c.run.id,messageId:c.inbox[0].messageId,sha,ref:`refs/agora/checkpoints/${sessionId}/1`});
    expect((await ctx.request.post(`/agent-hosts/@me/runs/${c.run.id}/complete`).set(hostAuth).send({claimToken:c.run.claimToken,checkpoint:{sha,ref:cp.ref}})).body.repeated).toBe(true);
    expect((await list()).body.checkpoints).toHaveLength(1);
    const states=await ctx.request.post('/agent-hosts/@me/workspaces/reconcile').set(hostAuth).send({sessionIds:[sessionId]});expect(states.body).not.toContain(sessionId);
});
it('records failed-run checkpoints too',async()=>{ const cp=(await saveCheckpoint(true)).checkpoint;expect(cp.sha).toBe(sha); });
it('rejects checkpoints from another session or host and invalid refs',async()=>{
    const c=await claimRun();
    const body={claimToken:c.run.claimToken,checkpoint:{sha,ref:`refs/agora/checkpoints/${generateUlid()}/1`}};
    expect((await ctx.request.post(`/agent-hosts/@me/runs/${c.run.id}/complete`).set(hostAuth).send(body)).status).toBe(400);
    body.checkpoint.ref=`refs/agora/checkpoints/${sessionId}/1`;
    expect((await ctx.request.post(`/agent-hosts/@me/runs/${c.run.id}/complete`).set(otherHostAuth).send(body)).status).toBe(404);
    body.checkpoint.ref='refs/heads/main';expect((await ctx.request.post(`/agent-hosts/@me/runs/${c.run.id}/complete`).set(hostAuth).send(body)).status).toBe(400);
});
it('restores only a bound checkpoint, invalidates native resume and keeps checkpoint history',async()=>{
    const cp=(await saveCheckpoint()).checkpoint;
    expect((await queue({action:'restore',checkpointId:generateUlid()})).status).toBe(404);
    await ctx.db.query(`UPDATE agent_sessions SET native_session_id='old-native' WHERE id=$1`,[sessionId]);
    expect((await queue({action:'restore',checkpointId:cp.id})).status).toBe(202);const c=(await next()).body;
    expect(c.payload.checkpoint).toEqual({sha,ref:cp.ref});await result(c,true,{headSha:sha,message:'Restored'});
    const session=(await ctx.db.query('SELECT * FROM agent_sessions WHERE id=$1',[sessionId])).rows[0];expect(session.native_session_id).toBeNull();expect(session.head_sha).toBe(sha);
    expect((await list()).body.checkpoints).toHaveLength(1);
});
it('forks into a new shelved session only after the host proves the requested branch and checkpoint',async()=>{
    const cp=(await saveCheckpoint()).checkpoint;await queue({action:'fork',checkpointId:cp.id});const c=(await next()).body;
    const target=c.payload.forkSessionId;expect(target).not.toBe(sessionId);
    expect((await result(c,true,{sessionId:target,branch:`agora/builder/${target}`,baseSha:sha,headSha:'b'.repeat(40)})).status).toBe(400);
    expect((await result(c,true,{sessionId:target,branch:`agora/builder/${target}`,baseSha:sha,headSha:sha})).status).toBe(200);
    const fork=(await ctx.db.query('SELECT * FROM agent_sessions WHERE id=$1',[target])).rows[0];
    expect(fork.state).toBe('shelved');expect(fork.profile_id.trim()).toBe(profileId);expect(fork.base_sha).toBe(sha);expect(fork.native_session_id).toBeNull();
    expect((await ctx.db.query('SELECT state FROM agent_sessions WHERE id=$1',[sessionId])).rows[0].state).toBe('live');
});
// beta-test-plan §6.2 "Workspace commands", server side: fixed code, nothing queued for the host
it('refuses an unsafe discard path with 400 unsafe_path and queues nothing',async()=>{
    const paths=['../x','a/../../x','.git','.git/config','src/.git/hooks/pre-commit','GIT~1/config','git~1','.GIT/config','.git./config','.git~/x',
        'file.txt.','dir./file','file.txt ','C:/Windows/win.ini','a\\b','a.png:stream','/abs','a//b','./a'];
    for(const path of paths){
        const res=await queue({action:'discard',path});
        expect(res.status,path).toBe(400);expect(res.body,path).toEqual({error:'unsafe_path'});
    }
    expect((await ctx.db.query('SELECT count(*)::int AS n FROM agent_workspace_commands WHERE session_id=$1',[sessionId])).rows[0].n).toBe(0);
    expect((await next()).status).toBe(204);
    expect((await queue({action:'discard',path:'src/file.txt'})).status).toBe(202);
});
it('validates paths, payload bounds, revoked hosts and isolated checkpoint access',async()=>{
    for(const path of ['../bad','.git/config','C:/bad','a\\b']) expect((await queue({action:'discard',path})).status).toBe(400);
    expect((await queue({action:'commit',message:' '})).status).toBe(400);
    expect((await queue({action:'diff',offset:999999})).status).toBe(400);
    expect((await queue({action:'execute',command:'rm -rf'})).status).toBe(400);
    expect((await ctx.request.get(`/channels/${second}/sessions/${sessionId}/checkpoints`).set(owner.auth)).status).toBe(404);
    await queue({action:'diff'});await ctx.db.query('UPDATE agent_hosts SET revoked_at=NOW() WHERE id=$1',[hostId]);
    expect((await next()).status).toBe(401);
    expect((await queue({action:'diff'})).body.error).toBe('host_unavailable');
});
