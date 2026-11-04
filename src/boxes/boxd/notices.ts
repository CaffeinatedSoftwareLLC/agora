import type { Pool } from 'pg';
import { postSystemMessage } from '../../gateway/post-message';
import type { BridgedEvent } from '../../lib/event-bridge';

/**
 * boxd's notices in a box's home channel (docs/agent-boxes.md §7.1, §9): a start that keeps
 * failing, a box stopped after repeated failures, a refused start (drift), an upgrade.
 * System messages, so they reach clients through the event bridge like the runner's results.
 */

export const BOX_NOTICE_EVENT = 'box_notice';
export type BoxNoticeKind = 'error' | 'failed' | 'drift' | 'upgraded';

export async function postBoxNotice(
    db: Pool,
    publish: (events: BridgedEvent[]) => Promise<void>,
    box: { id: string; name: string; homeChannelId: string | null },
    kind: BoxNoticeKind,
    content: string,
): Promise<void> {
    if (!box.homeChannelId) return;
    const { events } = await postSystemMessage(db, {
        channelId: box.homeChannelId,
        threadId: null,
        content,
        systemEvent: BOX_NOTICE_EVENT,
        systemData: { boxId: box.id, boxName: box.name, kind },
    });
    await publish(events);
}
