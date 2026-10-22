import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { bindMessageAttachments, prepareMessageAttachments, replayMessageAttachments } from '../../src/lib/message-attachments';
import { addTaggingToAttachments } from '../../src/lib/file-tags';

const row = { id: 'file', uploader_id: 'user ', channel_id: 'channel ', message_id: null,
    filename: 'note.txt', mime_type: null, content_type: 'text/plain', size_bytes: '3',
    width: null, height: null, deleted_at: null };
function client(rows: unknown[]) {
    const query = vi.fn().mockImplementation(async (sql: string) => ({ rows: sql.includes('FROM file_tag_jobs') ? [] : rows }));
    return { db: { query } as unknown as PoolClient, query };
}
describe('shared message attachments', () => {
    it.each([
        { probability: 0.99, trusted: true, warning: false },
        { probability: 0.99, trusted: false, warning: true },
        { probability: 0.1, trusted: false, warning: false },
        { probability: null, trusted: false, warning: false },
    ])('clears stale warning/trust metadata on tagged reads: %j', async ({ probability, trusted, warning }) => {
        const attachment = { id: 'file', injectionWarning: true, trustedByOwner: true, trustedBy: 'stale', trustedAt: 'stale' };
        const query = vi.fn().mockResolvedValueOnce({ rows: [{ file_id: 'file', state: 'done', injection_probability: probability,
            flag_threshold: 0.7, trusted_by: trusted ? 'owner ' : null, trusted_at: trusted ? '2026-10-22T12:00:00Z' : null }] })
            .mockResolvedValueOnce({ rows: [] });
        await addTaggingToAttachments({ query }, [attachment]);
        expect(attachment).toMatchObject({ injectionWarning: warning, trustedByOwner: trusted,
            trustedBy: trusted ? 'owner' : null, trustedAt: trusted ? '2026-10-22T12:00:00.000Z' : null });
    });
    it('locks valid files and binds their resolved IDs', async () => {
        const { db, query } = client([row]);
        const prepared = await prepareMessageAttachments(db, 'user', 'channel', ['file']);
        expect(query).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE'), [['file']]);
        expect(prepared).toEqual({ ok: true, attachments: [{ id: 'file', name: 'note.txt', mime: 'text/plain', size: 3, width: null, height: null, url: '/files/file' }] });
        if (prepared.ok) await bindMessageAttachments(db, 'message', prepared.attachments);
        expect(query).toHaveBeenLastCalledWith('UPDATE files SET message_id = $1 WHERE id = ANY($2)', ['message', ['file']]);
    });
    it('does no file query for a post with no attachments', async () => {
        const { db, query } = client([]);
        expect(await prepareMessageAttachments(db, 'user', 'channel')).toEqual({ ok: true, attachments: [] });
        await bindMessageAttachments(db, 'message', []);
        expect(query).not.toHaveBeenCalled();
    });
    it('returns numeric BIGINT sizes in replay envelopes too', async () => {
        const { db } = client([row]);
        expect((await replayMessageAttachments(db, 'message'))[0].size).toBe(3);
    });
    it('includes queued tagging metadata in new posts and completed metadata in durable replays', async () => {
        const { db, query } = client([row]);
        query.mockResolvedValueOnce({ rows: [row] })
            .mockResolvedValueOnce({ rows: [{ file_id: 'file', state: 'pending', coverage: null, injection_probability: null, tag_threshold: 0.5, flag_threshold: 0.7 }] })
            .mockResolvedValueOnce({ rows: [] });
        const prepared = await prepareMessageAttachments(db, 'user', 'channel', ['file']);
        expect(prepared.ok && prepared.attachments[0]).toMatchObject({ tagging: 'pending', tags: [] });
        query.mockResolvedValueOnce({ rows: [row] })
            .mockResolvedValueOnce({ rows: [{ file_id: 'file', state: 'done', coverage: 'partial', injection_probability: 0.99, tag_threshold: 0.5, flag_threshold: 0.7 }] })
            .mockResolvedValueOnce({ rows: [{ file_id: 'file', name: 'protocol', probability: 0.9 }] });
        expect((await replayMessageAttachments(db, 'message'))[0]).toMatchObject({ tagging: 'done', tags: ['protocol'], partial: true, injectionWarning: true });
    });
    it.each([
        { ids: ['file', 'file'], rows: [row], error: 'Duplicate attachment IDs' },
        { ids: Array.from({ length: 11 }, (_, i) => String(i)), rows: [], error: 'Too many attachments (max 10)' },
        { ids: ['file'], rows: [], error: 'One or more attachment IDs are invalid or deleted' },
        { ids: ['file'], rows: [{ ...row, deleted_at: 'now' }], error: 'One or more attachments are deleted' },
        { ids: ['file'], rows: [{ ...row, uploader_id: 'other' }], error: 'Attachment does not belong to you' },
        { ids: ['file'], rows: [{ ...row, uploader_id: null }], error: 'Attachment does not belong to you' },
        { ids: ['file'], rows: [{ ...row, channel_id: 'other' }], error: 'Attachment channel mismatch' },
        { ids: ['file'], rows: [{ ...row, message_id: 'bound' }], error: 'Attachment already bound to a message' },
    ])('refuses $error without binding any file', async ({ ids, rows, error }) => {
        const { db, query } = client(rows);
        expect(await prepareMessageAttachments(db, 'user', 'channel', ids)).toEqual({ ok: false, error });
        expect(query.mock.calls.every(([sql]) => !String(sql).startsWith('UPDATE'))).toBe(true);
    });
});
