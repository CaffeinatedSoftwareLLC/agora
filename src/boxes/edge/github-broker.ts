import { createHash } from 'node:crypto';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { PoolClient } from 'pg';
import { ALLOWED_TTL_MINUTES, subjectHash, type PrSubject } from '../../lib/boxes/edge-requests';
import { generateUlid } from '../../utils/ulid';
import type { EdgeBox } from './identity';
import { boxPolicy, loadRepo, loadToken, requestApproval, sendJson, sendText, settleRequest, type BoxRepo, type EdgeDeps } from './common';
import { inTransaction, RefLockTimeout, withRefLocks } from './locks';
import type { GithubRoute } from './paths';
import { validBranch } from './pktline';
import { apiHeaders, isRedirect, openUpstream, readBody, requestBuffered } from './upstream';

/**
 * GitHub reads and the PR broker (docs/agent-boxes.md §5.3). Reads: an enumerated list of GET
 * paths for attached repos. PR create: bound to the head SHA and the payload hash, serialized
 * with pushes to the head ref, checked against the head SHA GitHub reports, idempotent on retry.
 */

const MAX_PR_BODY = 1024 * 1024;
const READ_RESPONSE_HEADERS = ['content-type', 'content-length', 'etag', 'last-modified', 'link', 'cache-control'];
const SHA = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

export async function handleGithub(deps: EdgeDeps, box: EdgeBox, req: IncomingMessage, res: ServerResponse, route: GithubRoute): Promise<void> {
    const repo = await loadRepo(deps.db, box.id, route.owner, route.repo);
    if (!repo) { req.resume(); return sendText(res, 404, 'not found'); }
    const token = await loadToken(deps, box.serverId);
    if (!token) { req.resume(); return sendText(res, 502, 'no GitHub credential is set for this server'); }
    if (route.kind === 'read') return read(deps, req, res, repo, token, route.rest, route.query);
    return createPr(deps, box, req, res, repo, token);
}

async function read(deps: EdgeDeps, req: IncomingMessage, res: ServerResponse, repo: BoxRepo, token: string, rest: string, query: string) {
    req.resume();
    const accept = req.headers.accept;
    const extra: OutgoingHttpHeaders = typeof accept === 'string' && /^application\/(vnd\.github[\w.+-]*|json)$/.test(accept) ? { accept } : {};
    const up = openUpstream(`${deps.githubApiBase}/repos/${repo.owner}/${repo.repo}/${rest}${query ? `?${query}` : ''}`, 'GET', apiHeaders(token, extra));
    up.req.end();
    let upRes: IncomingMessage;
    try {
        upRes = await up.response;
    } catch {
        return sendText(res, 502, 'GitHub could not be reached');
    }
    if (isRedirect(upRes.statusCode)) { upRes.resume(); return sendText(res, 502, 'GitHub answered with a redirect; not followed'); }
    const headers: OutgoingHttpHeaders = {};
    for (const n of READ_RESPONSE_HEADERS) if (upRes.headers[n] !== undefined) headers[n] = upRes.headers[n];
    res.writeHead(upRes.statusCode ?? 502, headers);
    upRes.pipe(res);
    upRes.on('error', () => res.destroy());
}

interface PrInput { title: string; body: string; head: string; base: string; draft: boolean }

function validatePr(value: unknown): PrInput | string {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'body must be a JSON object';
    const v = value as Record<string, unknown>;
    const extra = Object.keys(v).find(k => !['title', 'body', 'head', 'base', 'draft'].includes(k));
    if (extra) return `unknown field "${extra.slice(0, 40)}"`;
    if (typeof v.title !== 'string' || v.title.trim().length === 0 || v.title.length > 256) return 'title must be a string of 1-256 characters';
    if (v.body !== undefined && v.body !== null && (typeof v.body !== 'string' || v.body.length > 65536)) return 'body must be a string up to 65536 characters';
    if (typeof v.head === 'string' && v.head.includes(':')) return 'head must be a branch of this repo (no cross-fork pull requests)';
    if (!validBranch(v.head)) return 'head must be a branch name';
    if (!validBranch(v.base)) return 'base must be a branch name';
    if (v.draft !== undefined && typeof v.draft !== 'boolean') return 'draft must be a boolean';
    return { title: v.title, body: (v.body as string | null | undefined) ?? '', head: v.head, base: v.base, draft: v.draft === true };
}

/** What an approval is bound to besides the box: the title, body and draft flag. */
export const payloadHash = (pr: Pick<PrInput, 'title' | 'body' | 'draft'>) =>
    createHash('sha256').update(JSON.stringify(['agora-pr/v1', pr.title, pr.body, pr.draft])).digest('hex');

async function readJson(req: IncomingMessage): Promise<unknown | 'too_large' | 'invalid'> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
        total += (chunk as Buffer).length;
        if (total > MAX_PR_BODY) return 'too_large';
        chunks.push(chunk as Buffer);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return 'invalid'; }
}

const encBranch = (b: string) => b.split('/').map(encodeURIComponent).join('/');

/** A branch's SHA on GitHub; null if it doesn't exist; throws if GitHub can't say. */
async function resolveBranch(deps: EdgeDeps, repo: BoxRepo, token: string, branch: string): Promise<string | null> {
    const res = await requestBuffered(`${deps.githubApiBase}/repos/${repo.owner}/${repo.repo}/git/ref/heads/${encBranch(branch)}`, { headers: apiHeaders(token), maxBytes: 1024 * 1024 });
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error(`ref lookup answered ${res.status}`);
    const sha = JSON.parse(res.body.toString('utf8'))?.object?.sha;
    if (typeof sha !== 'string' || !SHA.test(sha)) throw new Error('ref lookup gave no sha');
    return sha;
}

/** Open PRs from head to base (same repo); throws if GitHub can't say. */
async function openPrs(deps: EdgeDeps, repo: BoxRepo, token: string, head: string, base: string): Promise<any[]> {
    const q = new URLSearchParams({ state: 'open', head: `${repo.owner}:${head}`, base, per_page: '20' });
    const res = await requestBuffered(`${deps.githubApiBase}/repos/${repo.owner}/${repo.repo}/pulls?${q}`, { headers: apiHeaders(token), maxBytes: 10 * 1024 * 1024 });
    if (res.status !== 200) throw new Error(`pull list answered ${res.status}`);
    const list = JSON.parse(res.body.toString('utf8'));
    if (!Array.isArray(list)) throw new Error('pull list is not a list');
    return list.filter(pr => pr && typeof pr.number === 'number');
}

type Claim = { requestId: string; auto: boolean } | { refuse: 'busy' } | { refuse: 'needs_approval'; requestId: string };

async function claim(deps: EdgeDeps, box: EdgeBox, client: PoolClient, subject: PrSubject): Promise<Claim> {
    const binding = { owner: subject.owner, repo: subject.repo, head: subject.head, headSha: subject.headSha, base: subject.base, payloadHash: subject.payloadHash };
    const policy = await boxPolicy(deps.db, box);
    if (policy.autoPr) {
        // Auto-allowed: recorded so a retry can find the PR it made; it carries no owner decision
        const id = generateUlid();
        await client.query(
            `INSERT INTO box_edge_requests (id, server_id, box_id, generation, kind, subject, subject_hash, status, decided_at, expires_at)
             VALUES ($1, $2, $3, $4, 'pr', $5, $6, 'in_flight', NOW(), NOW() + ($7 || ' minutes')::interval)`,
            [id, box.serverId, box.id, box.generation, JSON.stringify(subject), subjectHash('pr', subject), String(ALLOWED_TTL_MINUTES)]
        );
        return { requestId: id, auto: true };
    }
    const claimed = await inTransaction(client, async c => {
        const row = (await c.query(
            `SELECT id FROM box_edge_requests
             WHERE box_id = $1 AND generation = $2 AND kind = 'pr' AND status = 'allowed' AND expires_at > NOW() AND decided_by IS NOT NULL
               AND subject @> $3::jsonb
             ORDER BY decided_at LIMIT 1 FOR UPDATE`,
            [box.id, box.generation, JSON.stringify(binding)]
        )).rows[0];
        if (!row) {
            const busy = await c.query(
                `SELECT 1 FROM box_edge_requests WHERE box_id = $1 AND kind = 'pr' AND status = 'in_flight' AND subject @> $2::jsonb LIMIT 1`,
                [box.id, JSON.stringify(binding)]
            );
            return busy.rows.length > 0 ? 'busy' : null;
        }
        await c.query(`UPDATE box_edge_requests SET status = 'in_flight', updated_at = NOW() WHERE id = $1`, [row.id]);
        return row.id.trim() as string;
    });
    if (claimed === 'busy') return { refuse: 'busy' };
    if (claimed) return { requestId: claimed, auto: false };
    return { refuse: 'needs_approval', requestId: await requestApproval(deps, box, 'pr', subject) };
}

async function createPr(deps: EdgeDeps, box: EdgeBox, req: IncomingMessage, res: ServerResponse, repo: BoxRepo, token: string) {
    const raw = await readJson(req);
    if (raw === 'too_large') return sendText(res, 413, 'body too large');
    if (raw === 'invalid') return sendJson(res, 400, { error: 'invalid_json' });
    const pr = validatePr(raw);
    if (typeof pr === 'string') return sendJson(res, 400, { error: 'invalid_request', message: pr });
    const hash = payloadHash(pr);

    try {
        await withRefLocks(deps.db, repo.owner, repo.repo, [`refs/heads/${pr.head}`], async client => {
            let headSha: string | null; let baseSha: string | null; let before: any[];
            try {
                headSha = await resolveBranch(deps, repo, token, pr.head);
                baseSha = await resolveBranch(deps, repo, token, pr.base);
                if (!headSha) return sendJson(res, 422, { error: 'head_not_found', message: `branch ${pr.head} is not on GitHub; push it first` });
                if (!baseSha) return sendJson(res, 422, { error: 'base_not_found', message: `branch ${pr.base} is not on GitHub` });
                before = await openPrs(deps, repo, token, pr.head, pr.base);
            } catch (err) {
                deps.log.warn({ boxId: box.id, err: (err as Error).message }, 'PR lookup failed');
                return sendText(res, 502, 'GitHub could not be reached');
            }

            // A retry: an open PR from head to base that one of this box's requests created
            for (const existing of before) {
                const mine = await deps.db.query(
                    `SELECT id FROM box_edge_requests WHERE box_id = $1 AND kind = 'pr' AND status IN ('used', 'changed')
                       AND subject @> $2::jsonb AND result->>'number' = $3 LIMIT 1`,
                    [box.id, JSON.stringify({ owner: repo.owner, repo: repo.repo, head: pr.head, base: pr.base, payloadHash: hash }), String(existing.number)]
                );
                if (mine.rows.length > 0) return sendJson(res, 200, existing, { 'x-agora-edge-request': mine.rows[0].id.trim() });
            }

            const subject: PrSubject = { owner: repo.owner, repo: repo.repo, head: pr.head, headSha, base: pr.base, baseSha, payloadHash: hash, title: pr.title, draft: pr.draft };
            const c = await claim(deps, box, client, subject);
            if ('refuse' in c) {
                if (c.refuse === 'busy') return sendJson(res, 409, { error: 'in_progress', message: 'this pull request is being opened by another request' });
                return sendJson(res, 403, {
                    error: 'needs_approval', requestId: c.requestId,
                    message: `opening this pull request needs the owner's approval (request ${c.requestId}); send the same request again after it's approved`,
                }, { 'x-agora-edge-request': c.requestId });
            }
            // An auto row that wrote nothing is retired, never left 'allowed' for something else to claim
            const nothingWritten = c.auto ? 'expired' : 'allowed';

            const settleCreated = async (created: any) => {
                const reported = created?.head?.sha;
                const status = reported === headSha ? 'used' : 'changed';
                await settleRequest(deps, c.requestId, status, { number: created.number, url: created.html_url ?? null, headSha: typeof reported === 'string' ? reported : null });
                return status;
            };

            const payload = Buffer.from(JSON.stringify({ title: pr.title, body: pr.body, head: pr.head, base: pr.base, draft: pr.draft }), 'utf8');
            const up = openUpstream(`${deps.githubApiBase}/repos/${repo.owner}/${repo.repo}/pulls`, 'POST',
                apiHeaders(token, { 'content-type': 'application/json', 'content-length': payload.length }));
            up.req.end(payload);
            let status = 0; let body: Buffer | null = null;
            try {
                const upRes = await up.response;
                status = upRes.statusCode ?? 0;
                body = await readBody(upRes, 10 * 1024 * 1024);
            } catch (err) {
                deps.log.warn({ boxId: box.id, err: (err as Error).message }, 'PR create failed; reading back');
            }

            if (status === 201 && body) {
                let created: any = null;
                try { created = JSON.parse(body.toString('utf8')); } catch { /* handled below */ }
                if (created && typeof created.number === 'number') {
                    const outcome = await settleCreated(created);
                    return sendJson(res, 201, created, { 'x-agora-edge-request': c.requestId, 'x-agora-edge-pr-status': outcome });
                }
            } else if (status >= 400 && status < 500 && body) {
                // GitHub refused it: nothing was created
                await settleRequest(deps, c.requestId, nothingWritten, { refused: status });
                res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
                return res.end(body);
            }

            // Unclear (dropped, timed out, 5xx, a redirect, an unreadable 201): look for the PR on GitHub
            try {
                const knownBefore = new Set(before.map(p => p.number));
                const after = (await openPrs(deps, repo, token, pr.head, pr.base)).filter(p => !knownBefore.has(p.number));
                if (after.length === 0) {
                    await settleRequest(deps, c.requestId, nothingWritten, { readBack: 'none' });
                    return sendText(res, 502, 'GitHub did not open the pull request; send the request again');
                }
                const outcome = await settleCreated(after[0]);
                return sendJson(res, 201, after[0], { 'x-agora-edge-request': c.requestId, 'x-agora-edge-pr-status': outcome });
            } catch {
                await settleRequest(deps, c.requestId, 'unknown', { readBack: 'failed' });
                return sendText(res, 502, 'GitHub could not be reached; whether the pull request was opened is unknown');
            }
        });
    } catch (err) {
        if (!(err instanceof RefLockTimeout)) throw err;
        return sendJson(res, 409, { error: 'in_progress', message: 'another write to this branch is in progress; try again' });
    }
}
