import { updateSystemMessage } from '../gateway/post-message';
import type { BridgedEvent } from './event-bridge';
import { asService } from './agent-sessions';

/**
 * Approval cards for runs that were denied in bulk (#244): an account change (the submitting
 * bot or its owner suspended, or the owner deleted their account) denies every run that has not
 * started. A run that was awaiting approval has a `runtime_approval` card in its channel; it is
 * switched to DENIED with the reason, the same way reviewRun (src/runtime/service.ts) updates
 * it, so nobody clicks Approve on a run the server already refuses. A card that says a reviewer
 * approved it is switched too: the run was queued, not started, and will not run now. The
 * approval-expiry sweep (runtimeMaintenance) uses it as well.
 *
 * Runs in the caller's transaction, as the service role (the cards are system messages in
 * channels the caller may not see). Returns the MessageUpdate events to emit after COMMIT.
 */
export async function denyApprovalCards(db: any, runIds: string[], reason: string): Promise<BridgedEvent[]> {
    if (runIds.length === 0) return [];
    return asService(db, async () => {
        const cards = await db.query(
            `SELECT id, system_data FROM messages
             WHERE system_event = 'runtime_approval' AND system_data->>'runId' = ANY($1::text[])
               AND system_data->>'status' IN ('pending', 'approved')
             FOR UPDATE`,
            [runIds.map(id => id.trim())]
        );
        const events: BridgedEvent[] = [];
        for (const card of cards.rows) {
            const runId = String(card.system_data.runId);
            events.push(...await updateSystemMessage(db, card.id.trim(), `Run ${runId}: Denied. ${reason}.`,
                { ...card.system_data, status: 'denied', deniedReason: reason }));
        }
        return events;
    });
}
