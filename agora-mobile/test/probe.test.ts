import { describe, expect, it } from 'vitest';
import { MESSAGES } from '../src/lib/errors';
import { probeInstance, ProbeError } from '../src/lib/probe';
import { fakeHttp } from './helpers';

const ORIGIN = 'https://agora.example.com';
const HEALTH = `${ORIGIN}/health`;
const STATUS = `${ORIGIN}/instance/status`;

const agora = {
    [HEALTH]: { status: 200, data: { status: 'ok' } },
    [STATUS]: { status: 200, data: { initialized: true, registrationPolicy: 'invite_only', instanceName: 'Team Agora', instanceServerId: null } },
};

describe('probeInstance', () => {
    it('returns the instance name for an Agora server', async () => {
        const http = fakeHttp(agora);
        await expect(probeInstance(ORIGIN, http)).resolves.toEqual({ name: 'Team Agora' });
        expect(http.request.mock.calls.map(([o]) => [o.method, o.url])).toEqual([['GET', HEALTH], ['GET', STATUS]]);
    });

    it('accepts JSON that arrives as a string', async () => {
        const http = fakeHttp({
            [HEALTH]: { status: 200, data: '{"status":"ok"}' },
            [STATUS]: { status: 200, data: JSON.stringify({ initialized: false, registrationPolicy: 'open', instanceName: '' }) },
        });
        await expect(probeInstance(ORIGIN, http)).resolves.toEqual({ name: 'agora.example.com' });
    });

    it('refuses a server that only has a /health', async () => {
        const http = fakeHttp({ [HEALTH]: agora[HEALTH], [STATUS]: { status: 200, data: '<html></html>' } });
        await expect(probeInstance(ORIGIN, http)).rejects.toBeInstanceOf(ProbeError);
        await expect(probeInstance(ORIGIN, http)).rejects.toMatchObject({ kind: 'not_agora', message: MESSAGES.notAgora });
    });

    it("refuses a server whose /health is not Agora's, or that answers non-2xx", async () => {
        await expect(probeInstance(ORIGIN, fakeHttp({ [HEALTH]: { status: 200, data: '<html></html>' } }))).rejects.toMatchObject({ kind: 'not_agora' });
        await expect(probeInstance(ORIGIN, fakeHttp({}))).rejects.toMatchObject({ kind: 'not_agora', detail: expect.stringContaining('404') });
        await expect(probeInstance(ORIGIN, fakeHttp({ [HEALTH]: agora[HEALTH], [STATUS]: { status: 502, data: '' } }))).rejects.toMatchObject({ kind: 'not_agora' });
    });

    it('reports unreachable servers without the raw error text', async () => {
        const raw = 'failed to connect to agora.example.com/100.64.0.1 (port 443) after 8000ms';
        const err = await probeInstance(ORIGIN, fakeHttp({ [HEALTH]: new Error(raw) })).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ProbeError);
        expect(err).toMatchObject({ kind: 'unreachable', message: MESSAGES.unreachable });
        expect((err as ProbeError).message).not.toContain('8000ms');
        expect((err as ProbeError).detail).toContain(raw);
    });

    it('reports a failure on /instance/status as unreachable too', async () => {
        const http = fakeHttp({ [HEALTH]: agora[HEALTH], [STATUS]: new Error('timeout') });
        await expect(probeInstance(ORIGIN, http)).rejects.toMatchObject({ kind: 'unreachable' });
    });
});
