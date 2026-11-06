import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { retryWhileUnavailable } from '../../src/lib/startup-retry';

/** A reboot starts box-edge and boxd beside Postgres; they wait for it instead of exiting. */

function refused(): Error {
    return Object.assign(new Error('connect ECONNREFUSED 172.18.0.2:5432'), { code: 'ECONNREFUSED' });
}

function clock() {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

describe('retryWhileUnavailable', () => {
    it('retries while Postgres refuses or is starting up, then returns the result', async () => {
        const c = clock();
        const errors = [refused(), Object.assign(new Error('the database system is starting up'), { code: '57P03' })];
        const logs: string[] = [];
        let calls = 0;
        const out = await retryWhileUnavailable('Box edge', async () => {
            calls++;
            const e = errors.shift();
            if (e) throw e;
            return 'ok';
        }, { ...c, log: m => logs.push(m) });
        expect(out).toBe('ok');
        expect(calls).toBe(3);
        expect(logs).toHaveLength(2);
        expect(logs[0]).toMatch(/^Box edge: dependency not ready \(ECONNREFUSED\)/);
    });

    it('throws a non-transient error at once', async () => {
        const c = clock();
        let calls = 0;
        await expect(retryWhileUnavailable('Box edge', async () => {
            calls++;
            throw new Error('AGORA_ENCRYPTION_KEY does not match');
        }, { ...c, log: () => {} })).rejects.toThrow('does not match');
        expect(calls).toBe(1);
    });

    it('gives up after the timeout with the last error', async () => {
        const c = clock();
        let calls = 0;
        await expect(retryWhileUnavailable('boxd', async () => { calls++; throw refused(); },
            { ...c, timeoutMs: 10_000, delayMs: 2_000, log: () => {} })).rejects.toThrow('ECONNREFUSED');
        expect(calls).toBe(6);
        expect(c.now()).toBe(10_000);
    });
});

describe('docker-compose.prod.yml start order', () => {
    // `docker compose up` honours these; a daemon restart does not, hence the retry above
    const compose = readFileSync(join(__dirname, '../../docker-compose.prod.yml'), 'utf8');
    const service = (name: string) => {
        const m = compose.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z0-9-]*:\\n|\\n[a-z])`));
        if (!m) throw new Error(`no ${name} service`);
        return m[1];
    };
    for (const name of ['box-edge', 'boxd']) {
        it(`${name} waits for healthy Postgres and Redis`, () => {
            const s = service(name);
            expect(s).toMatch(/\n {6}postgres:\n {8}condition: service_healthy/);
            expect(s).toMatch(/\n {6}redis:\n {8}condition: service_healthy/);
        });
    }
});
