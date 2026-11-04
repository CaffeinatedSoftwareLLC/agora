import type { Pool } from 'pg';
import type { BridgedEvent } from '../../lib/event-bridge';
import { expireEdgeRequests, refreshCard } from '../../lib/boxes/edge-requests';
import { inTransaction } from './locks';

/** Expire pending cards and allowed approvals past their time (every minute). */
export async function expireOnce(db: Pool): Promise<BridgedEvent[]> {
    const client = await db.connect();
    try {
        return await inTransaction(client, c => expireEdgeRequests(c));
    } finally {
        client.release();
    }
}

/**
 * At start: an approval left `in_flight` by a previous edge process was being forwarded when
 * it stopped, so its outcome is not known. It becomes `unknown` and can never be reused.
 */
export async function retireOrphans(db: Pool): Promise<BridgedEvent[]> {
    const client = await db.connect();
    try {
        return await inTransaction(client, async c => {
            const rows = await c.query(
                `UPDATE box_edge_requests SET status = 'unknown', result = COALESCE(result, '{}'::jsonb) || '{"edgeRestarted": true}'::jsonb, updated_at = NOW()
                 WHERE status = 'in_flight' RETURNING id`
            );
            const events: BridgedEvent[] = [];
            for (const r of rows.rows) events.push(...await refreshCard(c, r.id));
            return events;
        });
    } finally {
        client.release();
    }
}
