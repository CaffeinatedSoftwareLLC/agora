import { createHash } from 'node:crypto';
import { generateUlid } from '../../utils/ulid';
import { postSystemMessage, updateSystemMessage } from '../../gateway/post-message';
import type { BridgedEvent } from '../event-bridge';
import { notify } from '../notifications';
import { DOMAIN_ENTRY } from './contract';

/**
 * Edge requests (docs/agent-boxes.md §4.3): a domain, a push or a PR waiting on the server
 * owner. The edge records them; the API's decision route decides them. Both render the same
 * card (system_event 'box_edge_request') in the box's home channel.
 *
 * `db` is a client inside a transaction (BEGIN … COMMIT), with table-owner rights: boxd, the
 * edge, or asService in the API. notify() opens a SAVEPOINT, which a bare pool can't.
 */

export type EdgeKind = 'domain' | 'push' | 'pr';
export type EdgeStatus = 'pending' | 'allowed' | 'denied' | 'expired' | 'in_flight' | 'used' | 'unknown' | 'changed';
export type EdgeDecision = 'allow' | 'deny' | 'always';

/** How long a card waits for the owner, and how long an allowed approval stays usable. */
export const PENDING_TTL_HOURS = 24;
export const ALLOWED_TTL_MINUTES = 30;
/** A box can have at most this many cards waiting; past it, the edge refuses without a new card. */
export const MAX_PENDING_PER_BOX = 25;
/** The owner's phone hears about a box's new requests at most this often. */
export const NOTIFY_QUIET_MINUTES = 5;
/** After a deny, the same domain makes no new card for this long. */
export const DOMAIN_DENY_QUIET_HOURS = 24;

export const EDGE_SYSTEM_EVENT = 'box_edge_request';

export interface DomainSubject { host: string }
/** Sorted by ref; old/new are full hex object IDs, `0`×40 for create/delete. */
export interface PushSubject { owner: string; repo: string; commands: [string, string, string][] }
export interface PrSubject { owner: string; repo: string; head: string; headSha: string; base: string; baseSha: string; payloadHash: string; title: string; draft: boolean }
export type EdgeSubject = DomainSubject | PushSubject | PrSubject;

/** Canonical JSON (sorted keys) so the same subject always hashes the same. */
function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value as object).sort().map(k => `${JSON.stringify(k)}:${canonical((value as any)[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}
export function subjectHash(kind: EdgeKind, subject: EdgeSubject): string {
    return createHash('sha256').update(`${kind}\n${canonical(subject)}`).digest('hex');
}

const short = (sha: string) => /^0+$/.test(sha) ? '(none)' : sha.slice(0, 10);
/**
 * Agent-written text on a card (a PR title, a ref name) is shown as text, never as markdown:
 * one line, no backticks, and markdown's special characters escaped, so a box can't make its
 * card say something else (security review #6).
 */
export function plain(text: string, max = 120): string {
    return text.replace(/\s+/g, ' ').replace(/`/g, "'").slice(0, max)
        .replace(/[\\*_~[\]()<>#|!]/g, ch => `\\${ch}`);
}
/** A short code span for a value the edge has validated (refs may still hold backticks). */
const code = (text: string) => `\`${text.replace(/`/g, "'").replace(/[\r\n]+/g, ' ').slice(0, 200)}\``;
/** One line for the card and the notification. Subjects are validated by the edge before they get here. */
export function describe(kind: EdgeKind, subject: EdgeSubject): string {
    if (kind === 'domain') return `reach ${code((subject as DomainSubject).host)}`;
    if (kind === 'push') {
        const s = subject as PushSubject;
        const cmds = s.commands.map(([o, n, ref]) => `${code(ref.replace(/^refs\/heads\//, ''))} ${short(o)} → ${short(n)}`);
        return `push to ${code(`${s.owner}/${s.repo}`)}: ${cmds.join(', ')}`;
    }
    const s = subject as PrSubject;
    return `open a ${s.draft ? 'draft ' : ''}pull request in ${code(`${s.owner}/${s.repo}`)}: ${code(s.head)} (${short(s.headSha)}) → ${code(s.base)}, "${plain(s.title)}"`;
}

export function edgeCard(row: { id: string; box_id: string; kind: EdgeKind; subject: EdgeSubject; status: EdgeStatus }, boxName: string): { content: string; systemData: Record<string, unknown> } {
    const what = describe(row.kind, row.subject);
    const state: Record<EdgeStatus, string> = {
        pending: 'waits for the owner', allowed: 'allowed', denied: 'denied', expired: 'expired',
        in_flight: 'allowed', used: 'done', unknown: 'outcome unknown; check the remote', changed: 'done on a different commit than approved',
    };
    return {
        content: `Box **${boxName}** wants to ${what}. ${state[row.status]}.`,
        systemData: {
            requestId: row.id.trim(), boxId: row.box_id.trim(), boxName, kind: row.kind, status: row.status,
            summary: what, subject: row.subject,
            // "Always" sets auto-allow for this box in the home channel (push, PR) or allows the domain
            canAlways: row.kind !== 'domain',
        },
    };
}

/**
 * Record a pending request, or find the open one for the same subject. A new one posts a card in
 * the box's home channel and notifies the server owner. Returns the request ID and events to emit.
 */
export async function recordEdgeRequest(db: any, input: { boxId: string; generation: number; kind: EdgeKind; subject: EdgeSubject }): Promise<{ id: string; created: boolean; limited?: boolean; events: BridgedEvent[] }> {
    if (input.kind === 'domain' && !DOMAIN_ENTRY.test((input.subject as DomainSubject).host)) throw new Error('invalid domain subject');
    const hash = subjectHash(input.kind, input.subject);
    const box = (await db.query(
        `SELECT b.server_id, b.home_channel_id, p.name, s.owner_id
         FROM agent_boxes b JOIN agent_profiles p ON p.id = b.profile_id JOIN servers s ON s.id = b.server_id WHERE b.id = $1`,
        [input.boxId]
    )).rows[0];
    if (!box) throw new Error('unknown box');
    // A box can't flood the owner: an open card for the same subject is returned as before, but
    // past MAX_PENDING_PER_BOX waiting cards nothing new is recorded until some are decided
    const open = await db.query(`SELECT id FROM box_edge_requests WHERE box_id = $1 AND kind = $2 AND subject_hash = $3 AND status = 'pending'`, [input.boxId, input.kind, hash]);
    if (open.rows[0]) return { id: open.rows[0].id.trim(), created: false, events: [] };
    const waiting = Number((await db.query(`SELECT count(*) AS n FROM box_edge_requests WHERE box_id = $1 AND status = 'pending'`, [input.boxId])).rows[0].n);
    if (waiting >= MAX_PENDING_PER_BOX) return { id: '', created: false, limited: true, events: [] };
    const id = generateUlid();
    const inserted = await db.query(
        `INSERT INTO box_edge_requests (id, server_id, box_id, generation, kind, subject, subject_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + ($8 || ' hours')::interval)
         ON CONFLICT (box_id, kind, subject_hash) WHERE status = 'pending' DO NOTHING
         RETURNING id`,
        [id, box.server_id, input.boxId, input.generation, input.kind, JSON.stringify(input.subject), hash, String(PENDING_TTL_HOURS)]
    );
    if (inserted.rows.length === 0) {
        const open = await db.query(`SELECT id FROM box_edge_requests WHERE box_id = $1 AND kind = $2 AND subject_hash = $3 AND status = 'pending'`, [input.boxId, input.kind, hash]);
        return { id: open.rows[0].id.trim(), created: false, events: [] };
    }
    const events: BridgedEvent[] = [];
    if (box.home_channel_id) {
        const card = edgeCard({ id, box_id: input.boxId, kind: input.kind, subject: input.subject, status: 'pending' }, box.name);
        const posted = await postSystemMessage(db, { channelId: box.home_channel_id, threadId: null, content: card.content, systemEvent: EDGE_SYSTEM_EVENT, systemData: card.systemData });
        await db.query('UPDATE box_edge_requests SET message_id = $1 WHERE id = $2', [posted.messageId, id]);
        events.push(...posted.events);
        // One phone notification per box per few minutes; the cards themselves all show
        const recent = await db.query(
            `SELECT 1 FROM box_edge_requests WHERE box_id = $1 AND id <> $2 AND created_at > NOW() - ($3 || ' minutes')::interval LIMIT 1`,
            [input.boxId, id, String(NOTIFY_QUIET_MINUTES)]
        );
        if (recent.rows.length === 0) {
            await notify(db, { type: 'approval', recipients: [box.owner_id], channelId: box.home_channel_id, label: ch => `Box ${box.name} needs approval in #${ch}` });
        }
    }
    return { id, created: true, events };
}

/** A domain the owner denied recently: no new card for it. */
export async function domainRecentlyDenied(db: any, boxId: string, host: string): Promise<boolean> {
    const r = await db.query(
        `SELECT 1 FROM box_edge_requests WHERE box_id = $1 AND kind = 'domain' AND subject_hash = $2 AND status = 'denied'
           AND decided_at > NOW() - ($3 || ' hours')::interval LIMIT 1`,
        [boxId, subjectHash('domain', { host }), String(DOMAIN_DENY_QUIET_HOURS)]
    );
    return r.rows.length > 0;
}

/** Re-render a request's card after its status changed. */
export async function refreshCard(db: any, requestId: string): Promise<BridgedEvent[]> {
    const row = (await db.query(
        `SELECT r.id, r.box_id, r.kind, r.subject, r.status, r.message_id, p.name
         FROM box_edge_requests r JOIN agent_boxes b ON b.id = r.box_id JOIN agent_profiles p ON p.id = b.profile_id WHERE r.id = $1`,
        [requestId]
    )).rows[0];
    if (!row?.message_id) return [];
    const card = edgeCard(row, row.name);
    return updateSystemMessage(db, row.message_id.trim(), card.content, card.systemData);
}

export class EdgeDecisionError extends Error {
    constructor(public status: number, public code: string) { super(code); }
}

/**
 * The owner decides a pending request. allow → allowed (usable for ALLOWED_TTL_MINUTES);
 * deny → denied; always → allowed, and for push/pr the home channel's auto-allow is turned on
 * for this box; for a domain, allow and always both add it to the box's allowlist.
 * The caller has checked the user is the server owner.
 */
export async function decideEdgeRequest(db: any, requestId: string, decision: EdgeDecision, userId: string): Promise<{ status: EdgeStatus; events: BridgedEvent[] }> {
    const row = (await db.query(
        `SELECT r.id, r.box_id, r.kind, r.subject, r.status, r.expires_at < NOW() AS expired, b.home_channel_id
         FROM box_edge_requests r JOIN agent_boxes b ON b.id = r.box_id WHERE r.id = $1 FOR UPDATE OF r`,
        [requestId]
    )).rows[0];
    if (!row) throw new EdgeDecisionError(404, 'not_found');
    if (row.status !== 'pending') throw new EdgeDecisionError(409, 'already_decided');
    if (row.expired) {
        await db.query(`UPDATE box_edge_requests SET status = 'expired', updated_at = NOW() WHERE id = $1`, [requestId]);
        return { status: 'expired', events: await refreshCard(db, requestId) };
    }
    const status: EdgeStatus = decision === 'deny' ? 'denied' : 'allowed';
    await db.query(
        `UPDATE box_edge_requests SET status = $2::varchar, decided_by = $3, decided_at = NOW(), updated_at = NOW(),
                expires_at = CASE WHEN $2::varchar = 'allowed' THEN NOW() + ($4 || ' minutes')::interval ELSE expires_at END
         WHERE id = $1`,
        [requestId, status, userId, String(ALLOWED_TTL_MINUTES)]
    );
    if (status === 'allowed' && row.kind === 'domain') {
        await db.query(
            `UPDATE agent_boxes SET allowed_domains = array_append(allowed_domains, $2), updated_at = NOW()
             WHERE id = $1 AND NOT ($2 = ANY(allowed_domains))`,
            [row.box_id, (row.subject as DomainSubject).host]
        );
    }
    if (decision === 'always' && row.kind !== 'domain' && row.home_channel_id) {
        const column = row.kind === 'push' ? 'auto_push' : 'auto_pr';
        await db.query(
            `INSERT INTO box_push_policies (box_id, channel_id, ${column}, updated_by) VALUES ($1, $2, true, $3)
             ON CONFLICT (box_id, channel_id) DO UPDATE SET ${column} = true, updated_by = $3, updated_at = NOW()`,
            [row.box_id, row.home_channel_id, userId]
        );
    }
    const serverId = (await db.query('SELECT server_id FROM agent_boxes WHERE id = $1', [row.box_id])).rows[0].server_id;
    await db.query(
        `INSERT INTO audit_log (id, server_id, actor_id, action, target_type, target_id, changes) VALUES ($1, $2, $3, $4, 'box_edge_request', $5, $6)`,
        [generateUlid(), serverId, userId, status === 'denied' ? 'box_edge_deny' : 'box_edge_allow', requestId, JSON.stringify({ kind: row.kind, decision })]
    );
    return { status, events: await refreshCard(db, requestId) };
}

/** Expire pending cards and allowed approvals past their time. Run by the edge every minute. */
export async function expireEdgeRequests(db: any): Promise<BridgedEvent[]> {
    const rows = await db.query(
        `UPDATE box_edge_requests SET status = 'expired', updated_at = NOW()
         WHERE status IN ('pending', 'allowed') AND expires_at < NOW() RETURNING id`
    );
    const events: BridgedEvent[] = [];
    for (const r of rows.rows) events.push(...await refreshCard(db, r.id));
    return events;
}
