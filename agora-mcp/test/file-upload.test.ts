import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { AgoraApi, AgoraApiError } from '../src/api.js';
import { CursorTracker } from '../src/cursor.js';
import { registerTools } from '../src/tools.js';
import { openLocalUpload, type UploadConfig } from '../src/local-upload.js';

let fixture: string, root: string, outside: string;
beforeEach(async () => {
    fixture = await mkdtemp(join(tmpdir(), 'agora-upload-test-'));
    root = join(fixture, 'work'); outside = join(fixture, 'outside');
    await mkdir(root); await mkdir(outside);
    await writeFile(join(root, 'report.txt'), 'hello'); await writeFile(join(outside, 'secret.txt'), 'outside');
});
afterEach(async () => { vi.unstubAllGlobals(); await rm(fixture, { recursive: true, force: true }); });

function setup(extra: Record<string, unknown> = {}, config: UploadConfig = {}) {
    const api = { getMe: async () => ({ id: 'self', username: 'agent', channels: [{ id: 'C1', name: 'general' }] }),
        uploadFile: vi.fn(async (_channel, file) => { for await (const _chunk of file.stream) { /* consume */ }
            return { id: 'F1', name: file.name, size: file.size }; }), postFile: vi.fn(async () => ({ id: 'M1' })), ...extra } as any;
    const handlers = new Map<string, (args: any) => Promise<any>>();
    registerTools({ tool: (name: string, _desc: string, _schema: unknown, handler: any) => handlers.set(name, handler) } as never,
        api, new CursorTracker(api), { defaultChannel: 'general', uploadRoot: root, ...config });
    return { api, call: (args: any) => handlers.get('file_upload')!(args) };
}

describe('local file boundary', () => {
    it('accepts relative and absolute regular files within the root', async () => {
        for (const path of ['report.txt', join(root, 'report.txt')]) {
            const opened = await openLocalUpload(path, { uploadRoot: root });
            try { expect(await opened.handle.readFile('utf8')).toBe('hello'); expect(opened.name).toBe('report.txt'); }
            finally { await opened.handle.close(); }
        }
    });
    it('rejects traversal, absolute paths outside the root, sibling-prefix paths, directories and missing files', async () => {
        for (const path of ['../outside/secret.txt', join(outside, 'secret.txt'), root + '-sibling/file']) {
            await expect(openLocalUpload(path, { uploadRoot: root })).rejects.toThrow('outside');
        }
        await expect(openLocalUpload('.', { uploadRoot: root })).rejects.toThrow('regular file');
        await expect(openLocalUpload('missing', { uploadRoot: root })).rejects.toThrow();
    });
    it('rejects symlink escapes and only allows them when the operator configured outside access', async () => {
        await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
        await expect(openLocalUpload('linked/secret.txt', { uploadRoot: root })).rejects.toThrow('symlink');
        const opened = await openLocalUpload('linked/secret.txt', { uploadRoot: root, allowOutsideWorkdir: true });
        try { expect(await opened.handle.readFile('utf8')).toBe('outside'); } finally { await opened.handle.close(); }
    });
});

describe('file_upload', () => {
    it('uploads and posts an attachment-only channel message or optional text in a thread', async () => {
        const { api, call } = setup();
        expect((await call({ path: 'report.txt' })).content[0].text).toContain('as message M1');
        expect(api.uploadFile).toHaveBeenCalledWith('C1', expect.objectContaining({ name: 'report.txt', size: 5 }));
        expect(api.postFile).toHaveBeenLastCalledWith('C1', 'F1', undefined, { threadId: undefined, idempotencyKey: expect.any(String) });
        await call({ path: 'report.txt', thread: 'T1', message: 'Report attached.' });
        expect(api.postFile).toHaveBeenLastCalledWith('C1', 'F1', 'Report attached.', { threadId: 'T1', idempotencyKey: expect.any(String) });
    });
    it('does no upload when path validation fails; explains size failures without posting', async () => {
        const { api, call } = setup();
        await expect(call({ path: '../outside/secret.txt' })).rejects.toThrow('outside');
        expect(api.uploadFile).not.toHaveBeenCalled();
        api.uploadFile.mockRejectedValue(new AgoraApiError('large', 413, null, {}));
        await expect(call({ path: 'report.txt' })).rejects.toThrow('413');
        expect(api.postFile).not.toHaveBeenCalled();
    });
    it('retains the uploaded ID when posting fails and never reuploads or deletes automatically', async () => {
        const { api, call } = setup({ postFile: vi.fn(async () => { throw new Error('thread closed'); }) });
        await expect(call({ path: 'report.txt', thread: 'T1' })).rejects.toThrow(/Uploaded file F1.*posting was not confirmed.*Idempotency-Key/);
        expect(api.uploadFile).toHaveBeenCalledTimes(1);
    });
});

describe('multipart API', () => {
    it('works with native fetch and a real HTTP receiver without buffering the local file', async () => {
        let received = Buffer.alloc(0);
        const server = createServer(async (request, response) => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            received = Buffer.concat(chunks);
            response.writeHead(201, { 'content-type': 'application/json' }); response.end(JSON.stringify({ id: 'F1' }));
        });
        server.listen(0, '127.0.0.1'); await once(server, 'listening');
        try {
            const address = server.address() as { port: number };
            const file = await openLocalUpload('report.txt', { uploadRoot: root });
            try {
                const uploaded = await new AgoraApi(`http://127.0.0.1:${address.port}`, 'bot_test').uploadFile('C1', {
                    name: file.name, size: file.size, stream: file.handle.createReadStream({ autoClose: false }),
                });
                expect(uploaded.id).toBe('F1');
                expect(received.toString()).toContain('filename="report.txt"');
                expect(received.toString()).toContain('\r\n\r\nhello\r\n');
            } finally { await file.handle.close(); }
        } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    });
    it('streams exact binary bytes with channel_id first and posts the attachment to the correct destination', async () => {
        const bodies: Buffer[] = [];
        const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
            const chunks: Buffer[] = [];
            if (init.body instanceof Readable) for await (const chunk of init.body) chunks.push(Buffer.from(chunk));
            else chunks.push(Buffer.from(String(init.body)));
            bodies.push(Buffer.concat(chunks));
            return new Response(JSON.stringify({ id: bodies.length === 1 ? 'F1' : 'M1' }), { status: 201, headers: { 'content-type': 'application/json' } });
        });
        vi.stubGlobal('fetch', fetchMock);
        const api = new AgoraApi('http://localhost:3000', 'bot_x');
        const bytes = Buffer.from([0, 1, 255, 13, 10]);
        await api.uploadFile('C1', { name: 'photo.png', size: bytes.length, stream: Readable.from([bytes]) });
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('http://localhost:3000/files/upload');
        expect(init.headers).toMatchObject({ Authorization: 'Bot bot_x', 'Content-Type': expect.stringContaining('multipart/form-data; boundary='), 'Content-Length': String(bodies[0].length) });
        expect(bodies[0].indexOf('name="channel_id"')).toBeLessThan(bodies[0].indexOf('name="file"'));
        expect(bodies[0].includes(bytes)).toBe(true);
        await api.postFile('C1', 'F1', '', { threadId: 'T1', idempotencyKey: 'key' });
        expect(fetchMock.mock.calls[1][0]).toContain('/channels/C1/messages/T1/replies');
        expect(JSON.parse(bodies[1].toString())).toEqual({ attachments: ['F1'] });
        await api.postFile('C1', 'F1', undefined, { idempotencyKey: 'key2' });
        expect(fetchMock.mock.calls[2][0]).toBe('http://localhost:3000/channels/C1/messages');
        expect(JSON.parse(bodies[2].toString())).toEqual({ attachments: ['F1'] });
    });
    it.each([403, 413, 415, 507, 503])('surfaces %i and never retries the upload', async status => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'refused' }), { status }));
        vi.stubGlobal('fetch', fetchMock);
        await expect(new AgoraApi('http://localhost:3000', 'bot_x').uploadFile('C1', { name: 'a.txt', size: 1, stream: Readable.from(['a']) })).rejects.toMatchObject({ status });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
