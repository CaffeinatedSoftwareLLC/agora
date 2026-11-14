import { describe, it, expect, beforeAll } from 'vitest';
import { BOX_ADAPTER_REGISTRY } from '../../src/lib/boxes/adapters';
import { BOX_ADAPTERS as HOST_ADAPTERS } from '../../agora-host/src/box-adapters';
import { api, connectFromBox, createBox, docker, inBox, instance, psql, type Instance } from './harness';

/**
 * Every adapter in the box adapter registry starts in a box (docs/agent-boxes.md, "Adding a
 * box adapter"): the test image's fake CLI passes agora-host's start-up check, its host checks
 * in through the edge, its state directory is laid out as the registry says, and an adapter
 * with no login of its own (opencode) gets no Log in and its key from boxd. A new registry
 * entry is covered here without a new test.
 */

let inst: Instance;
beforeAll(async () => { inst = await instance(); }, 600_000);

describe('every box adapter runs in a box', () => {
    for (const [adapter, spec] of Object.entries(BOX_ADAPTER_REGISTRY)) {
        it(`${adapter}: starts, checks in, and has its rules file`, async () => {
            const name = `ad-${adapter}`.slice(0, 32);
            const apiKeyOnly = spec.authModes[0] === 'api_key';
            const box = await createBox(inst, name, adapter, {
                ...(apiKeyOnly ? { auth: 'api_key', apiKey: `fake-${adapter}-key-0123456789` } : {}),
                ...(spec.modelRequired ? { model: 'fake/model' } : {}),
            });
            // createBox waited for the box's agora-host to check in: its start-up check passed
            const state = `~/.agora/state/${name}`;
            const rules = await inBox(box.container, `readlink ${state}/${HOST_ADAPTERS[adapter as keyof typeof HOST_ADAPTERS].state.rulesFile}`);
            expect(rules.stdout.trim(), rules.stderr).toBe('/opt/agora/AGENTS.md');

            const listed = (await api(`/servers/${inst.serverId}/boxes`, { auth: inst.admin })).body.boxes.find((b: any) => b.id === box.id);
            expect(listed.allowedDomains.slice(0, spec.allowlist.length)).toEqual([...spec.allowlist]);

            if (apiKeyOnly) {
                // No login to relay: refused at once, nothing for the box's host to claim
                const login = await api(`/boxes/${box.id}/login`, { method: 'POST', auth: inst.admin });
                expect(login.status).toBe(409);
                expect(login.body).toEqual({ error: 'login_not_supported' });
                // boxd set the key under the registry's variable, for agora-host to pass to the CLI only
                const inspected = JSON.parse((await docker('inspect', box.container)).stdout)[0].Config.Env as string[];
                expect(inspected.map(e => e.split('=')[0])).toContain(spec.apiKeyEnv);
                // ... and the agent's host (not the operator's relay) is where it ends up
                const host = await inBox(box.container, `for f in /proc/[0-9]*; do tr '\\0' ' ' < $f/cmdline 2>/dev/null | grep -q '[a]gora-host/dist/index.js --config' && tr '\\0' '\\n' < $f/environ | cut -d= -f1; done | grep -x ${spec.apiKeyEnv} | head -1`);
                expect(host.stdout.trim()).toBe(spec.apiKeyEnv);
            }
            // Its telemetry hosts are refused without a card
            for (const t of spec.telemetry) {
                const r = await connectFromBox(box.container, `${t.domain}:443`);
                expect(r.status, t.domain).toBe(403);
                expect(r.requestId, t.domain).toBeNull();
            }
            expect(await psql(`SELECT count(*) FROM box_edge_requests WHERE box_id = '${box.id}'`)).toBe('0');
            expect((await api(`/boxes/${box.id}`, { method: 'DELETE', auth: inst.admin })).status).toBeLessThan(300);
        }, 600_000);
    }
});
