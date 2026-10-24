import { describe, expect, it } from 'vitest';
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
    });

    it("refuses a server whose /health is not Agora's", async () => {
        await expect(probeInstance(ORIGIN, fakeHttp({ [HEALTH]: { status: 200, data: '<html></html>' } }))).rejects.toThrow(/did not answer/);
        await expect(probeInstance(ORIGIN, fakeHttp({}))).rejects.toThrow(/404/);
    });

    it('reports unreachable servers', async () => {
        await expect(probeInstance(ORIGIN, fakeHttp({ [HEALTH]: new Error('ssl') }))).rejects.toThrow(/Could not reach/);
    });
});
