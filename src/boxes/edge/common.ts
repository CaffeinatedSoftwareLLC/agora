import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { decryptString } from '../../lib/encryption';
import type { BridgedEvent } from '../../lib/event-bridge';
import { recordEdgeRequest, refreshCard, type EdgeKind, type EdgeSubject } from '../../lib/boxes/edge-requests';
import type { EdgeBox } from './identity';
import { inTransaction } from './locks';
import { apiHeaders, isRedirect, requestBuffered } from './upstream';

/** What the brokers and proxies share. */
export interface EdgeDeps {
    db: Pool;
    encryptionKey: Buffer;
    /** Publish card events (Redis event bridge in production). Failures are logged, never thrown. */
    publish: (events: BridgedEvent[]) => Promise<void>;
    githubBase: string;
    githubApiBase: string;
    log: EdgeLog;
}

export interface EdgeLog {
    info: (obj: Record<string, unknown>, msg: string) => void;
    warn: (obj: Record<string, unknown>, msg: string) => void;
}

export const consoleLog: EdgeLog = {
    info: (obj, msg) => console.log(JSON.stringify({ level: 'info', msg, ...obj })),
    warn: (obj, msg) => console.warn(JSON.stringify({ level: 'warn', msg, ...obj })),
};
export const silentLog: EdgeLog = { info: () => undefined, warn: () => undefined };

export function sendText(res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}) {
    if (res.headersSent) { res.destroy(); return; }
    const body = Buffer.from(`${text}\n`, 'utf8');
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': body.length, ...headers });
    res.end(body);
}

export function sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
    if (res.headersSent) { res.destroy(); return; }
    const body = Buffer.from(JSON.stringify(value), 'utf8');
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, ...headers });
    res.end(body);
}

export interface BoxRepo { owner: string; repo: string; defaultBranch: string | null; defaultCheckedAt: Date | null }

/** The attached repo, matched without regard to case; owner and repo come back as stored. */
export async function loadRepo(db: Pool, boxId: string, owner: string, repo: string): Promise<BoxRepo | null> {
    const row = (await db.query(
        `SELECT owner, repo, default_branch, default_checked_at FROM box_repos
         WHERE box_id = $1 AND lower(owner) = lower($2) AND lower(repo) = lower($3)`,
        [boxId, owner, repo]
    )).rows[0];
    return row ? { owner: row.owner, repo: row.repo, defaultBranch: row.default_branch, defaultCheckedAt: row.default_checked_at } : null;
}

/** The server owner's GitHub token, decrypted for one upstream request. */
export async function loadToken(deps: EdgeDeps, serverId: string): Promise<string | null> {
    const row = (await deps.db.query('SELECT token_enc, token_iv, token_tag FROM box_github_credentials WHERE server_id = $1', [serverId])).rows[0];
    if (!row) return null;
    try {
        return decryptString(row.token_enc, deps.encryptionKey, row.token_iv, row.token_tag);
    } catch {
        deps.log.warn({ serverId }, 'GitHub credential could not be decrypted');
        return null;
    }
}

/** The home channel's auto-allow for this box. */
export async function boxPolicy(db: Pool, box: EdgeBox): Promise<{ autoPush: boolean; autoPr: boolean }> {
    if (!box.homeChannelId) return { autoPush: false, autoPr: false };
    const row = (await db.query('SELECT auto_push, auto_pr FROM box_push_policies WHERE box_id = $1 AND channel_id = $2', [box.id, box.homeChannelId])).rows[0];
    return { autoPush: !!row?.auto_push, autoPr: !!row?.auto_pr };
}

const DEFAULT_BRANCH_TTL_MS = 60 * 60 * 1000;

/** The repo's default branch: stored, refreshed from GitHub when missing or older than an hour. Null if unknown. */
export async function defaultBranch(deps: EdgeDeps, boxId: string, repo: BoxRepo, token: string): Promise<string | null> {
    const fresh = repo.defaultBranch && repo.defaultCheckedAt && Date.now() - new Date(repo.defaultCheckedAt).getTime() < DEFAULT_BRANCH_TTL_MS;
    if (fresh) return repo.defaultBranch;
    try {
        const res = await requestBuffered(`${deps.githubApiBase}/repos/${repo.owner}/${repo.repo}`, { headers: apiHeaders(token), maxBytes: 1024 * 1024 });
        if (res.status === 200 && !isRedirect(res.status)) {
            const branch = JSON.parse(res.body.toString('utf8'))?.default_branch;
            if (typeof branch === 'string' && branch.length > 0 && branch.length <= 255) {
                await deps.db.query(
                    'UPDATE box_repos SET default_branch = $4, default_checked_at = NOW() WHERE box_id = $1 AND owner = $2 AND repo = $3',
                    [boxId, repo.owner, repo.repo, branch]
                );
                return branch;
            }
        }
        deps.log.warn({ boxId, status: res.status }, 'Default branch lookup failed');
    } catch (err) {
        deps.log.warn({ boxId, err: (err as Error).message }, 'Default branch lookup failed');
    }
    // A stale value is still the best answer; none means nothing is auto-allowed
    return repo.defaultBranch;
}

/** Record (or find) a pending request in its own transaction and publish its card. */
export async function requestApproval(deps: EdgeDeps, box: EdgeBox, kind: EdgeKind, subject: EdgeSubject): Promise<string> {
    const client = await deps.db.connect();
    let result: Awaited<ReturnType<typeof recordEdgeRequest>>;
    try {
        result = await inTransaction(client, c => recordEdgeRequest(c, { boxId: box.id, generation: box.generation, kind, subject }));
    } finally {
        client.release();
    }
    if (result.created) deps.log.info({ boxId: box.id, kind, requestId: result.id }, 'Edge request recorded');
    await deps.publish(result.events);
    return result.id;
}

/** Move a request to a new status (and record what happened), then re-render its card. */
export async function settleRequest(deps: EdgeDeps, requestId: string, status: string, result?: unknown): Promise<void> {
    const client = await deps.db.connect();
    let events: BridgedEvent[] = [];
    try {
        events = await inTransaction(client, async c => {
            await c.query(
                `UPDATE box_edge_requests SET status = $2, result = COALESCE($3::jsonb, result), updated_at = NOW() WHERE id = $1`,
                [requestId, status, result === undefined ? null : JSON.stringify(result)]
            );
            return refreshCard(c, requestId);
        });
    } finally {
        client.release();
    }
    await deps.publish(events);
}

/**
 * Frame a forwarded request's body the way it arrived. The proxies drop Transfer-Encoding as a
 * hop-by-hop header, and Node's client sends a GET (or HEAD, DELETE, OPTIONS) body without any
 * framing unless told to: the bytes after the head would reach the upstream as a second
 * request of the box's own making, unsigned (request smuggling). So a chunked request is
 * forwarded chunked, whatever its method, and a request with both framings is refused.
 * Returns false when the request must be refused (400).
 */
export function frameBody(req: IncomingMessage, headers: OutgoingHttpHeaders): boolean {
    const te = req.headers['transfer-encoding'];
    const cl = req.headers['content-length'];
    if (te !== undefined && cl !== undefined) return false;
    if (te !== undefined) {
        // Node's server has already de-chunked anything it accepted; only chunked reaches here
        if (!/^\s*chunked\s*$/i.test(String(te))) return false;
        delete headers['content-length'];
        headers['transfer-encoding'] = 'chunked';
    } else if (cl !== undefined) {
        if (!/^\d{1,15}$/.test(String(cl))) return false;
        headers['content-length'] = cl;
    } else {
        delete headers['content-length'];
        delete headers['transfer-encoding'];
    }
    return true;
}
