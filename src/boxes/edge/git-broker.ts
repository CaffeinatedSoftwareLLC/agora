import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { subjectHash, type PushSubject } from '../../lib/boxes/edge-requests';
import type { EdgeBox } from './identity';
import { boxPolicy, defaultBranch, loadRepo, loadToken, requestApproval, sendText, settleRequest, type BoxRepo, type EdgeDeps } from './common';
import { inTransaction, RefLockTimeout, withRefLocks } from './locks';
import type { GitRoute } from './paths';
import {
    parseAdvertisement, parseCommands, parseReport, refusalReport, sidebandOf, sortCommands, ZERO_OID,
    type CommandParse, type PushCommand,
} from './pktline';
import { gitAuth, isRedirect, openUpstream, requestBuffered } from './upstream';

/**
 * The git broker (docs/agent-boxes.md §5.1, §5.2): fetches of attached repos go straight
 * through with the owner's token; a push goes upstream only when every command in it is
 * authorized, and an approval is used exactly once.
 */

const GIT_UA = 'git/2.43.0 (agora-edge)';
/** A refused push's pack is read and thrown away; past this the connection is cut instead. */
const MAX_DRAIN = 2 * 1024 * 1024 * 1024;
/** How much of GitHub's receive-pack reply is kept to read the report (progress can be long). */
const MAX_REPORT = 4 * 1024 * 1024;
const PUSH_IDLE_MS = 10 * 60 * 1000;

const RESPONSE_HEADERS = ['content-type', 'content-encoding', 'content-length', 'cache-control', 'expires', 'pragma'];

function copyHeaders(from: IncomingMessage['headers'], names: string[]): OutgoingHttpHeaders {
    const out: OutgoingHttpHeaders = {};
    for (const n of names) if (from[n] !== undefined) out[n] = from[n];
    return out;
}

const clientUa = (req: IncomingMessage) => {
    const ua = req.headers['user-agent'];
    return typeof ua === 'string' && /^git\/[\w.\-() ]{1,80}$/.test(ua) ? ua : GIT_UA;
};

const upstreamUrl = (deps: EdgeDeps, repo: BoxRepo, suffix: string) => `${deps.githubBase}/${repo.owner}/${repo.repo}.git/${suffix}`;

export async function handleGit(deps: EdgeDeps, box: EdgeBox, req: IncomingMessage, res: ServerResponse, route: GitRoute): Promise<void> {
    const repo = await loadRepo(deps.db, box.id, route.owner, route.repo);
    if (!repo) { req.resume(); return sendText(res, 404, 'not found'); }
    const token = await loadToken(deps, box.serverId);
    if (!token) { req.resume(); return sendText(res, 502, 'no GitHub credential is set for this server'); }

    if (route.kind === 'receive-pack') return receivePack(deps, box, req, res, repo, token);

    const headers: OutgoingHttpHeaders = { authorization: gitAuth(token), 'user-agent': clientUa(req) };
    for (const n of ['accept', 'accept-encoding']) if (typeof req.headers[n] === 'string') headers[n] = req.headers[n];
    // Fetches may speak v2; pushes stay on v0 so the command list is what the edge parses
    const proto = req.headers['git-protocol'];
    if (route.kind !== 'info-refs' || route.service === 'git-upload-pack') {
        if (typeof proto === 'string' && /^version=[12]$/.test(proto)) headers['git-protocol'] = proto;
    }
    let url: string;
    if (route.kind === 'info-refs') {
        url = upstreamUrl(deps, repo, `info/refs?service=${route.service}`);
    } else {
        url = upstreamUrl(deps, repo, 'git-upload-pack');
        headers['content-type'] = 'application/x-git-upload-pack-request';
        for (const n of ['content-encoding', 'content-length']) if (typeof req.headers[n] === 'string') headers[n] = req.headers[n];
    }
    const up = openUpstream(url, req.method!, headers);
    if (route.kind === 'info-refs') { req.resume(); up.req.end(); } else req.pipe(up.req);
    let upRes: IncomingMessage;
    try {
        upRes = await up.response;
    } catch (err) {
        deps.log.warn({ boxId: box.id, err: (err as Error).message }, 'git upstream failed');
        return sendText(res, 502, 'GitHub could not be reached');
    }
    if (isRedirect(upRes.statusCode)) { upRes.resume(); return sendText(res, 502, 'GitHub answered with a redirect; not followed'); }
    if (upRes.statusCode === 401) { upRes.resume(); return sendText(res, 502, 'GitHub refused the server\'s credential'); }
    res.writeHead(upRes.statusCode ?? 502, copyHeaders(upRes.headers, RESPONSE_HEADERS));
    upRes.pipe(res);
    upRes.on('error', () => res.destroy());
}

/** Read the request until the command list is complete (or refused); the rest stays in the stream. */
function readCommandSection(req: IncomingMessage): Promise<{ parse: CommandParse; prefix: Buffer }> {
    return new Promise((resolve, reject) => {
        let buf = Buffer.alloc(0);
        const done = (parse: CommandParse) => {
            req.off('data', onData); req.off('end', onEnd); req.off('error', onError);
            req.pause();
            resolve({ parse, prefix: buf });
        };
        const onData = (chunk: Buffer) => {
            buf = Buffer.concat([buf, chunk]);
            const parse = parseCommands(buf);
            if (parse.state !== 'more') done(parse);
        };
        const onEnd = () => {
            const parse = parseCommands(buf);
            done(parse.state === 'more' ? { state: 'refused', reason: 'truncated command list' } : parse);
        };
        const onError = (err: Error) => reject(err);
        req.on('data', onData); req.on('end', onEnd); req.on('error', onError);
    });
}

/** Read and discard the rest of a request so git gets its answer. */
function drain(req: IncomingMessage): Promise<void> {
    return new Promise(resolve => {
        if (req.readableEnded) return resolve();
        let total = 0;
        req.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > MAX_DRAIN) { req.destroy(); resolve(); }
        });
        req.on('end', () => resolve());
        req.on('close', () => resolve());
        req.resume();
    });
}

async function refuse(req: IncomingMessage, res: ServerResponse, commands: PushCommand[], sideband: ReturnType<typeof sidebandOf>, reason: string, message?: string) {
    await drain(req);
    if (res.headersSent || res.destroyed) return;
    const body = refusalReport(commands.map(c => c.ref), reason, sideband, message);
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache', 'content-length': body.length });
    res.end(body);
}

type Authorization =
    | { kind: 'auto' }
    | { kind: 'approval'; requestId: string }
    | { kind: 'refuse'; reason: string; message?: string };

const toSubject = (repo: BoxRepo, commands: PushCommand[]): PushSubject => ({
    owner: repo.owner, repo: repo.repo, commands: sortCommands(commands).map(c => [c.old, c.new, c.ref] as [string, string, string]),
});

/**
 * Auto-allow: the home channel allows pushes from this box, and every command creates or
 * updates a branch that isn't the default one. Deletes, tags and the default branch never are.
 */
async function autoAllowed(deps: EdgeDeps, box: EdgeBox, repo: BoxRepo, token: string, commands: PushCommand[]): Promise<boolean> {
    const policy = await boxPolicy(deps.db, box);
    if (!policy.autoPush) return false;
    const branch = await defaultBranch(deps, box.id, repo, token);
    if (!branch) return false;
    return commands.every(c => c.ref.startsWith('refs/heads/') && !ZERO_OID.test(c.new) && c.ref !== `refs/heads/${branch}`);
}

async function authorize(deps: EdgeDeps, box: EdgeBox, repo: BoxRepo, token: string, commands: PushCommand[], client: import('pg').PoolClient): Promise<Authorization> {
    if (await autoAllowed(deps, box, repo, token, commands)) return { kind: 'auto' };
    const subject = toSubject(repo, commands);
    const hash = subjectHash('push', subject);
    const claimed = await inTransaction(client, async c => {
        const row = (await c.query(
            `SELECT id FROM box_edge_requests
             WHERE box_id = $1 AND generation = $2 AND kind = 'push' AND subject_hash = $3 AND status = 'allowed' AND expires_at > NOW()
             ORDER BY decided_at LIMIT 1 FOR UPDATE`,
            [box.id, box.generation, hash]
        )).rows[0];
        if (!row) {
            const busy = await c.query(
                `SELECT 1 FROM box_edge_requests WHERE box_id = $1 AND kind = 'push' AND subject_hash = $2 AND status = 'in_flight' LIMIT 1`,
                [box.id, hash]
            );
            return busy.rows.length > 0 ? 'busy' : null;
        }
        await c.query(`UPDATE box_edge_requests SET status = 'in_flight', updated_at = NOW() WHERE id = $1`, [row.id]);
        return row.id.trim() as string;
    });
    if (claimed === 'busy') return { kind: 'refuse', reason: 'another push with this approval is in progress' };
    if (claimed) return { kind: 'approval', requestId: claimed };
    const requestId = await requestApproval(deps, box, 'push', subject);
    return {
        kind: 'refuse',
        reason: `push needs the owner's approval (request ${requestId}); push again after it's approved`,
        message: `Agora: this push waits for the owner's approval (request ${requestId}).`,
    };
}

/** Current values of the repo's refs on GitHub (absent refs are missing from the map), or null. */
export async function readRefs(deps: EdgeDeps, repo: BoxRepo, token: string): Promise<Map<string, string> | null> {
    try {
        const res = await requestBuffered(upstreamUrl(deps, repo, 'info/refs?service=git-upload-pack'), {
            headers: { authorization: gitAuth(token), 'user-agent': GIT_UA }, maxBytes: 32 * 1024 * 1024,
        });
        if (res.status !== 200) return null;
        return parseAdvertisement(res.body);
    } catch {
        return null;
    }
}

const zeroLike = (oid: string) => '0'.repeat(oid.length);

/** What a ref is now, in the command's own terms: 'old', 'new' or 'other'. */
function refState(current: Map<string, string>, c: PushCommand): 'old' | 'new' | 'other' {
    const now = current.get(c.ref) ?? zeroLike(c.old);
    if (now === c.old) return 'old';
    if (now === c.new) return 'new';
    return 'other';
}

/**
 * After an approved push: decide the approval's status from GitHub's report, or, when the
 * outcome is unclear, from the refs read back from GitHub.
 */
async function settlePush(deps: EdgeDeps, box: EdgeBox, repo: BoxRepo, token: string, requestId: string, commands: PushCommand[], report: ReturnType<typeof parseReport>) {
    const covered = report && commands.every(c => report.ok.has(c.ref) || report.ng.has(c.ref));
    if (report && covered) {
        const done = report.unpackOk ? commands.filter(c => report.ok.has(c.ref)) : [];
        if (done.length === commands.length) return settleRequest(deps, requestId, 'used', { updated: done.map(c => c.ref) });
        if (done.length === 0) return settleRequest(deps, requestId, 'allowed', { rejected: Object.fromEntries(report.ng) });
        // Partial: the approval is spent on what it did; the rest needs a new approval at its current old value
        const rest = commands.filter(c => !report.ok.has(c.ref));
        await settleRequest(deps, requestId, 'used', { updated: done.map(c => c.ref), rejected: Object.fromEntries(report.ng) });
        const current = await readRefs(deps, repo, token);
        const remaining = rest.map(c => ({ ...c, old: current ? (current.get(c.ref) ?? zeroLike(c.old)) : c.old }))
            .filter(c => c.old !== c.new);
        if (remaining.length > 0) await requestApproval(deps, box, 'push', toSubject(repo, remaining));
        return;
    }
    const current = await readRefs(deps, repo, token);
    if (!current) return settleRequest(deps, requestId, 'unknown', { readBack: 'failed' });
    const states = commands.map(c => refState(current, c));
    if (states.every(s => s === 'old')) return settleRequest(deps, requestId, 'allowed', { readBack: 'unchanged' });
    if (states.every(s => s === 'new')) return settleRequest(deps, requestId, 'used', { updated: commands.map(c => c.ref), readBack: 'updated' });
    return settleRequest(deps, requestId, 'unknown', { readBack: Object.fromEntries(commands.map((c, i) => [c.ref, states[i]])) });
}

async function receivePack(deps: EdgeDeps, box: EdgeBox, req: IncomingMessage, res: ServerResponse, repo: BoxRepo, token: string): Promise<void> {
    const encoding = String(req.headers['content-encoding'] ?? 'identity').toLowerCase();
    if (encoding !== 'identity') { await drain(req); return sendText(res, 415, 'push refused: compressed receive-pack requests are not accepted'); }
    const { parse, prefix } = await readCommandSection(req);
    if (parse.state !== 'done') {
        await drain(req);
        return sendText(res, 400, `push refused: ${parse.state === 'refused' ? parse.reason : 'malformed request'}`);
    }
    const { commands, capabilities } = parse;
    const sideband = sidebandOf(capabilities);

    let refusal: Authorization | null = null;
    try {
        refusal = await withRefLocks(deps.db, repo.owner, repo.repo, commands.map(c => c.ref), async client => {
            const auth = await authorize(deps, box, repo, token, commands, client);
            if (auth.kind === 'refuse') return auth;
            await forwardPush(deps, box, req, res, repo, token, prefix, sideband, auth.kind === 'approval' ? auth.requestId : null, commands);
            return null;
        });
    } catch (err) {
        if (!(err instanceof RefLockTimeout)) throw err;
        refusal = { kind: 'refuse', reason: 'another write to this ref is in progress; push again' };
    }
    if (refusal && refusal.kind === 'refuse') await refuse(req, res, commands, sideband, refusal.reason, refusal.message);
}

async function forwardPush(
    deps: EdgeDeps, box: EdgeBox, req: IncomingMessage, res: ServerResponse, repo: BoxRepo, token: string,
    prefix: Buffer, sideband: ReturnType<typeof sidebandOf>, requestId: string | null, commands: PushCommand[],
): Promise<void> {
    const headers: OutgoingHttpHeaders = {
        authorization: gitAuth(token), 'user-agent': clientUa(req),
        'content-type': 'application/x-git-receive-pack-request', accept: 'application/x-git-receive-pack-result',
    };
    if (typeof req.headers['content-length'] === 'string') headers['content-length'] = req.headers['content-length'];
    const up = openUpstream(upstreamUrl(deps, repo, 'git-receive-pack'), 'POST', headers, PUSH_IDLE_MS);
    if (req.readableEnded) up.req.end(prefix);
    else { up.req.write(prefix); req.pipe(up.req); }
    req.on('error', () => up.req.destroy());

    const collected: Buffer[] = [];
    let size = 0;
    let complete = false;
    // The client's answer is finished only after the approval is settled, so a retry that
    // follows it sees the settled state (never a stale in_flight)
    let finish: () => void = () => undefined;
    try {
        const upRes = await up.response;
        if (isRedirect(upRes.statusCode)) {
            upRes.resume();
            finish = () => sendText(res, 502, 'GitHub answered with a redirect; not followed');
        } else if (upRes.statusCode === 401) {
            upRes.resume();
            finish = () => sendText(res, 502, 'GitHub refused the server credential');
        } else {
            res.writeHead(upRes.statusCode ?? 502, copyHeaders(upRes.headers, RESPONSE_HEADERS));
            let clean = false;
            await new Promise<void>((resolve) => {
                upRes.on('data', (chunk: Buffer) => {
                    if (!res.destroyed) res.write(chunk);
                    size += chunk.length;
                    if (size <= MAX_REPORT) collected.push(chunk);
                });
                upRes.on('end', () => { clean = true; complete = upRes.statusCode === 200 && size <= MAX_REPORT; resolve(); });
                upRes.on('error', () => resolve());
                upRes.on('aborted', () => resolve());
                upRes.on('close', () => resolve());
            });
            // A reply cut short is cut short for the client too, so git doesn't take it as complete
            finish = () => { if (res.destroyed) return; if (clean) res.end(); else res.destroy(); };
        }
    } catch (err) {
        deps.log.warn({ boxId: box.id, err: (err as Error).message }, 'push upstream failed');
        finish = () => { if (!res.headersSent) sendText(res, 502, 'GitHub could not be reached; check the remote before pushing again'); else res.destroy(); };
    }
    try {
        if (requestId) {
            const report = complete ? parseReport(Buffer.concat(collected), sideband !== null) : null;
            await settlePush(deps, box, repo, token, requestId, commands, report);
        }
    } finally {
        finish();
    }
}
