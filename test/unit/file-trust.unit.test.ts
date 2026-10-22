import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { fileRoutes } from '../../src/routes/files';

const id = '01M5J000000000000000000000';
vi.mock('../../src/lib/file-attachment-updates', () => ({
    fileAttachmentUpdateInTransaction: vi.fn(async () => ({ channelId: 'channel', messageId: 'message', fileId: id,
        tags: [], tagging: 'done', partial: false, injectionWarning: false, trustedByOwner: true, trustedBy: 'owner', trustedAt: 'now' })),
}));

describe('file trust request event queue', () => {
    it('initializes a fresh request queue before adding the audit and attachment events', async () => {
        const app = Fastify();
        let events: { event: string }[] | undefined;
        const query = vi.fn(async (sql: string) => {
            if (sql.includes('FROM files f JOIN channels')) return { rows: [{ channel_id: 'channel', message_id: 'message', filename: 'notes.md',
                server_id: 'server', owner_id: 'owner', injection_probability: 0.99, flag_threshold: 0.7 }] };
            if (sql.startsWith('SELECT trusted_by')) return { rows: [{ trusted_by: null, trusted_at: null }] };
            if (sql.startsWith('SELECT username')) return { rows: [{ username: 'owner' }] };
            if (sql.includes('RETURNING created_at')) return { rows: [{ created_at: new Date().toISOString() }] };
            return { rows: [{ id: 'exists' }] };
        });
        app.addHook('preHandler', async request => {
            Object.assign(request, { userId: 'owner', dbClient: { query } });
            expect(request.pendingEvents).toBeUndefined();
        });
        app.addHook('onSend', async request => { events = request.pendingEvents; });
        await app.register(fileRoutes);
        try {
            const response = await app.inject({ method: 'POST', url: `/files/${id}/trust`, payload: {} });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ trustedByOwner: true, injectionWarning: false });
            expect(events?.map(event => event.event)).toEqual(['Message', 'FileAttachmentUpdate']);
        } finally { await app.close(); }
    });
});
