export const LURK_WINDOW_MS = 2000;

/** Fixed collection window: continuous chatter cannot postpone a wake forever. */
export function lurkBatchReady(rows: Array<{ reason: string; created_at: Date | string }>, now = Date.now()): boolean {
    return rows.length > 0 && (rows.some(r => r.reason !== 'lurk')
        || now - Math.min(...rows.map(r => new Date(r.created_at).getTime())) >= LURK_WINDOW_MS);
}
