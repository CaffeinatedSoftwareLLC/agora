import { describe, expect, test } from 'vitest';
import { containerName } from '../../src/runtime/container-spec';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { socketProxyArgs, allowRules, allows } = require('../../scripts/lib/socket-proxy-rules.js');

/**
 * #126: the runner's socket proxy (docker-compose.prod.yml) holds each install to its own
 * code-run containers. These check the production rules as the proxy reads them: the request
 * path only, anchored. test/sandbox/proxy.sandbox.test.ts sends the same requests to a real proxy.
 */

const RUN = '01jabcdefghjkmnpqrstvwxyz0';
const rulesFor = (instance: string) => allowRules(socketProxyArgs(instance));

describe('runner socket proxy rules (#126)', () => {
    const a = rulesFor('alpha');
    const own = containerName(RUN, 'alpha');
    const other = containerName(RUN, 'beta');

    test('an install can run its own containers', () => {
        expect(own).toBe(`alpha-run-${RUN}`);
        expect(allows(a, 'POST', '/v1.47/containers/create')).toBe(true);
        for (const op of ['start', 'wait', 'kill']) expect(allows(a, 'POST', `/v1.47/containers/${own}/${op}`), op).toBe(true);
        for (const op of ['json', 'logs']) expect(allows(a, 'GET', `/containers/${own}/${op}`), op).toBe(true);
        expect(allows(a, 'DELETE', `/v1.47/containers/${own}`)).toBe(true);
        expect(allows(a, 'GET', '/v1.47/networks/alpha_sandbox')).toBe(true);
        expect(allows(a, 'GET', '/v1.47/images/agora/sandbox-deno:local/json')).toBe(true);
    });

    test("another install's containers are refused for every call", () => {
        for (const name of [other, `agora-run-${RUN}`, `alpha-run-${RUN}x`, `xalpha-run-${RUN}`]) {
            for (const op of ['start', 'wait', 'kill', 'stop', 'restart']) expect(allows(a, 'POST', `/containers/${name}/${op}`), `${name} ${op}`).toBe(false);
            for (const op of ['json', 'logs']) expect(allows(a, 'GET', `/containers/${name}/${op}`), `${name} ${op}`).toBe(false);
            expect(allows(a, 'DELETE', `/v1.47/containers/${name}`), name).toBe(false);
        }
        // Nor by ID, which Docker would also accept in place of a name
        expect(allows(a, 'DELETE', `/containers/${'a'.repeat(64)}`)).toBe(false);
        expect(allows(a, 'GET', '/v1.47/networks/beta_sandbox')).toBe(false);
    });

    test('the container list is refused: the proxy cannot hold it to one install', () => {
        expect(allows(a, 'GET', '/v1.47/containers/json')).toBe(false);
        expect(allows(a, 'GET', '/containers/json')).toBe(false);
    });

    test('an image path cannot be walked over to another container', () => {
        for (const p of [
            `/images/../containers/${other}/json`,
            `/images/agora/../../containers/${other}/json`,
            '/images/./json',
        ]) expect(allows(a, 'GET', p), p).toBe(false);
    });

    test('nothing else: no exec, attach, archive, network or volume writes', () => {
        for (const [method, p] of [
            ['POST', `/containers/${own}/exec`], ['POST', `/containers/${own}/attach`], ['PUT', `/containers/${own}/archive`],
            ['GET', `/containers/${own}/archive`], ['POST', '/networks/create'], ['POST', '/networks/alpha_sandbox/connect'],
            ['POST', '/volumes/create'], ['POST', '/images/create'], ['DELETE', '/networks/alpha_sandbox'], ['GET', '/containers/json?all=1'],
        ] as const) expect(allows(a, method, p), `${method} ${p}`).toBe(false);
    });

    test('the default install keeps the agora-run- names it always had', () => {
        const d = rulesFor('agora');
        expect(containerName(RUN)).toBe(`agora-run-${RUN}`);
        expect(allows(d, 'DELETE', `/containers/agora-run-${RUN}`)).toBe(true);
        expect(allows(d, 'DELETE', `/containers/agora2-run-${RUN}`)).toBe(false);
    });

    test('one install name never matches another: the run part is a fixed 26 characters', () => {
        // a- vs a-run-…: the ID part would have to hold a dash
        const r = rulesFor('a');
        expect(allows(r, 'DELETE', `/containers/${containerName(RUN, 'a-run-x')}`)).toBe(false);
        expect(allows(r, 'DELETE', `/containers/${containerName(RUN, 'a_b')}`)).toBe(false);
    });

    test('install names and run IDs that could widen the rules are refused', () => {
        expect(() => socketProxyArgs('a.b')).toThrow('Invalid install name');
        expect(() => containerName(RUN, 'a.b')).toThrow('Invalid install name');
        expect(() => containerName('../x', 'alpha')).toThrow('Invalid run id');
    });
});
