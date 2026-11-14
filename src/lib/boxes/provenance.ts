import { generateUlid } from '../../utils/ulid';
import { postNotice, type Notice } from '../agent-runs';
import { EDGE_HEADERS, provenanceRefusal, verifyEdge, type ProvenanceRefusal } from './contract';

/**
 * Edge provenance in the API's auth step (docs/agent-boxes.md §4.1). Every bot-token, host-token
 * and JWT/cookie authentication, REST and the Socket.IO handshake, runs `checkProvenance`; a
 * refusal is answered 403 `{ error: code }`, written to the audit log and, at most once per hour
 * per box, posted to the box's home channel for the owner.
 *
 * The box columns come from the auth step's own token SELECT (no extra query on success).
 */

/** Read at call time, so a test (or a restart with a new value) needs no module reload. */
export function edgeSecret(): string | undefined {
    return process.env.AGORA_EDGE_SECRET || undefined;
}

/** Any edge header at all: requests without one skip the check entirely. */
export function hasEdgeHeaders(headers: Record<string, unknown>): boolean {
    return Object.values(EDGE_HEADERS).some(h => headers[h] !== undefined);
}

export interface ProvenanceCredential {
    kind: 'bot' | 'host' | 'relay' | 'user';
    /** Bot or user ID (users.id), or the agent host's ID */
    id: string;
    serverId: string | null;
    /** bot_tokens.box_id / agent_hosts.box_id and their generation; null for anything not minted for a box */
    boxId: string | null;
    generation: number | null;
    /** agent_boxes.generation of that box (null if none) */
    currentGeneration: number | null;
}

export interface ProvenanceVerdict {
    code: ProvenanceRefusal;
    /** The verified box the request came through, if any */
    edgeBoxId: string | null;
}

export function checkProvenance(headers: Record<string, string | string[] | undefined>, cred: ProvenanceCredential): ProvenanceVerdict | null {
    if (!cred.boxId && !hasEdgeHeaders(headers)) return null;
    const edge = verifyEdge(headers, edgeSecret());
    const code = provenanceRefusal(edge, { boxId: cred.boxId, generation: cred.generation }, cred.currentGeneration);
    if (!code) return null;
    return { code, edgeBoxId: edge && edge !== 'invalid' ? edge.boxId : null };
}

/** How often one box's home channel hears about refused credentials. */
export const NOTICE_INTERVAL_MINUTES = 60;

const NOTICE_TEXT: Record<ProvenanceRefusal, string> = {
    box_token_outside_box: 'was used from outside its box',
    token_not_for_this_box: 'was refused: a credential that isn\'t this box\'s own was used through it',
    bad_edge_signature: 'was refused: the request carried an invalid or outdated box signature',
};

/**
 * Record a refusal: an audit row for the credential, and a notice in the box's home channel
 * unless one went out in the last hour. `db` is a client inside a transaction, as the table
 * owner (the auth step runs before the RLS role is set). Returns the notices to emit after commit.
 */
export async function recordRefusal(db: any, cred: ProvenanceCredential, verdict: ProvenanceVerdict, where: { method: string; route: string }): Promise<Notice[]> {
    // The box to tell: the one it came through, else the credential's own
    const noticeBoxId = verdict.edgeBoxId ?? cred.boxId?.trim() ?? null;
    const box = noticeBoxId ? (await db.query(
        `SELECT b.server_id, b.home_channel_id, p.name FROM agent_boxes b JOIN agent_profiles p ON p.id = b.profile_id WHERE b.id = $1`,
        [noticeBoxId]
    )).rows[0] : null;
    const serverId = cred.serverId?.trim() || box?.server_id?.trim() || null;
    await db.query(
        `INSERT INTO audit_log (id, server_id, actor_id, action, target_type, target_id, changes)
         VALUES ($1, $2, $3, 'box_provenance_refused', $4, $5, $6)`,
        [generateUlid(), serverId, cred.kind === 'host' || cred.kind === 'relay' ? null : cred.id, cred.kind === 'host' || cred.kind === 'relay' ? 'agent_host' : cred.kind, cred.id,
         JSON.stringify({ code: verdict.code, credentialBox: cred.boxId?.trim() ?? null, edgeBox: verdict.edgeBoxId, method: where.method, route: where.route })]
    );
    if (!box?.home_channel_id || !noticeBoxId) return [];

    // One notice per box per hour, also across concurrent refusals
    await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`box-provenance-notice:${noticeBoxId}`]);
    const recent = await db.query(
        `SELECT 1 FROM audit_log WHERE action = 'box_provenance_notice' AND target_type = 'box' AND target_id = $1
           AND created_at > NOW() - make_interval(mins => $2) LIMIT 1`,
        [noticeBoxId, NOTICE_INTERVAL_MINUTES]
    );
    if (recent.rows.length > 0) return [];
    await db.query(
        `INSERT INTO audit_log (id, server_id, actor_id, action, target_type, target_id, changes)
         VALUES ($1, $2, NULL, 'box_provenance_notice', 'box', $3, $4)`,
        [generateUlid(), box.server_id, noticeBoxId, JSON.stringify({ code: verdict.code })]
    );
    const what = cred.kind === 'user' ? 'A person\'s login' : cred.kind === 'host' ? 'A host token' : cred.kind === 'relay' ? 'A terminal relay credential' : 'A bot token';
    const text = `Box **${box.name}**: ${what} ${NOTICE_TEXT[verdict.code]} (\`${verdict.code}\`). It is in the audit log; further refusals for this box are not posted for an hour.`;
    return [await postNotice(db, box.home_channel_id.trim(), text)];
}

/** Notices as the per-request pendingEvents entries (as agent-hosts.ts queueNotices does). */
export function noticeEvents(notices: Notice[]): Array<{ room: string; event: string; data: any }> {
    return notices.map(n => ({ room: `channel:${n.channelId}`, event: n.eventName ?? 'Message', data: n.event }));
}
