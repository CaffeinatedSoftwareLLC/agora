/** Exact repository-relative files and explicit directory prefixes (trailing /).
 * Case folding is conservative on case-sensitive filesystems and portable to Windows.
 */
export function normalizeReservationPath(input: string): string {
    const path = input.normalize('NFC').replace(/\\/g, '/').toLowerCase();
    if (!path || path.startsWith('/') || /[:*?\[\]{}\x00-\x1f\x7f]/.test(path)) throw new Error('invalid_reservation_path');
    const prefix = path.endsWith('/');
    const parts = path.split('/').filter(p => p !== '' && p !== '.');
    if (!parts.length || parts.includes('..') || parts.some(p => /[. ]$/.test(p))) throw new Error('invalid_reservation_path');
    return parts.join('/') + (prefix ? '/' : '');
}
export function reservationPathsOverlap(a: string, b: string): boolean {
    return a.replace(/\/$/, '') === b.replace(/\/$/, '') || (a.endsWith('/') && b.startsWith(a)) || (b.endsWith('/') && a.startsWith(b));
}
export function reservationJson(r: any) {
    return { id: r.id.trim(), serverId: r.server_id.trim(), workspaceId: r.workspace_id,
        sessionId: r.session_id.trim(), channelId: r.channel_id.trim(), holder: r.profile_name,
        threadId: r.thread_id?.trim() ?? null, paths: r.paths, reason: r.reason, expiresAt: r.expires_at };
}
/** Quoted path list for a system notice, kept under the 4000-character message limit. */
export function noticePathList(paths: string[], separator = ', ', budget = 3000): string {
    const shown: string[] = [];
    let used = 0;
    for (const p of paths) {
        const q = JSON.stringify(p.length > 300 ? `${p.slice(0, 300)}...` : p);
        if (used + q.length + separator.length > budget) break;
        shown.push(q); used += q.length + separator.length;
    }
    const more = paths.length - shown.length;
    return shown.join(separator) + (more > 0 ? `${separator}... and ${more} more` : '');
}
