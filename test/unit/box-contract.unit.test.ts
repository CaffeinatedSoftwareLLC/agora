import { describe, it, expect } from 'vitest';
import {
    boxContainerName, boxNetworkName, boxVolumeName, defaultAllowlist, domainAllowed, DOMAIN_ENTRY, EDGE_HEADERS,
    instanceName, provenanceRefusal, signEdge, verifyEdge,
} from '../../src/lib/boxes/contract';
import { describe as describeRequest, edgeCard, subjectHash } from '../../src/lib/boxes/edge-requests';

/** src/lib/boxes/contract.ts and the pure parts of edge-requests.ts (docs/agent-boxes.md §4). */

const SECRET = 'ab'.repeat(32);
const BOX = '01JBQXAAAAAAAAAAAAAAAAAAAA';
const OTHER = '01JBQXBBBBBBBBBBBBBBBBBBBB';
const NOW = 1_800_000_000_000;

describe('names', () => {
    it('instance names are checked and default to agora', () => {
        expect(instanceName({})).toBe('agora');
        expect(instanceName({ AGORA_INSTANCE: 'agora2' })).toBe('agora2');
        expect(() => instanceName({ AGORA_INSTANCE: 'Bad_Name' })).toThrow();
        expect(() => instanceName({ AGORA_INSTANCE: '../x' })).toThrow();
    });

    it('box resource names are lowercase and carry the instance', () => {
        expect(boxContainerName('agora', BOX)).toBe(`agora-box-${BOX.toLowerCase()}`);
        expect(boxNetworkName('agora', BOX)).toBe(`agora_box_${BOX.toLowerCase()}`);
        expect(boxVolumeName('agora', ` ${BOX} `)).toBe(`agora-box-${BOX.toLowerCase()}-home`);
        expect(() => boxContainerName('agora', 'not-a-ulid')).toThrow();
    });
});

describe('allowlist', () => {
    it('default allowlist is the provider plus registries, never github.com', () => {
        // platform.claude.com: where `claude auth login` exchanges its code (a Log in failed without it)
        expect(defaultAllowlist('claude')).toEqual(['api.anthropic.com', 'platform.claude.com', 'claude.ai', 'console.anthropic.com',
            'registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org']);
        // auth.openai.com signs in, chatgpt.com/backend-api serves a ChatGPT-plan Codex, api.openai.com an API key
        expect(defaultAllowlist('codex')).toEqual(['api.openai.com', 'chatgpt.com', 'auth.openai.com', 'registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org']);
        expect(defaultAllowlist('codex')).not.toContain('github.com');
        expect(defaultAllowlist('unknown')).toEqual(['registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org']);
    });

    it('entries are names or *.suffix, never IPs or a bare wildcard', () => {
        for (const ok of ['example.com', '*.example.com', 'a-b.c.io']) expect(DOMAIN_ENTRY.test(ok), ok).toBe(true);
        for (const bad of ['*', '*.com.', '1.2.3.4', 'localhost', 'exa mple.com', '-a.com', 'a..com', 'EXAMPLE.COM']) expect(DOMAIN_ENTRY.test(bad), bad).toBe(false);
    });

    it('matching: exact, suffix below the suffix only, case and trailing dot ignored', () => {
        const list = ['example.com', '*.npmjs.org'];
        expect(domainAllowed('example.com', list)).toBe(true);
        expect(domainAllowed('EXAMPLE.com.', list)).toBe(true);
        expect(domainAllowed('sub.example.com', list)).toBe(false);
        expect(domainAllowed('registry.npmjs.org', list)).toBe(true);
        expect(domainAllowed('npmjs.org', list)).toBe(false);
        expect(domainAllowed('evilnpmjs.org', list)).toBe(false);
    });
});

describe('edge signature', () => {
    it('signs the documented string', async () => {
        const { createHmac } = await import('node:crypto');
        const h = signEdge(SECRET, BOX, 3, NOW);
        const ts = String(Math.floor(NOW / 1000));
        expect(h).toEqual({
            [EDGE_HEADERS.box]: BOX, [EDGE_HEADERS.generation]: '3', [EDGE_HEADERS.ts]: ts,
            [EDGE_HEADERS.sig]: createHmac('sha256', SECRET).update(`agora-edge/v1\n${BOX}\n3\n${ts}`).digest('hex'),
        });
    });

    it('verifies its own headers, and nothing without headers', () => {
        expect(verifyEdge(signEdge(SECRET, BOX, 3, NOW), SECRET, NOW)).toEqual({ boxId: BOX, generation: 3 });
        expect(verifyEdge({}, SECRET, NOW)).toBeNull();
        expect(verifyEdge({ 'user-agent': 'x' }, SECRET, NOW)).toBeNull();
    });

    it('anything else is invalid', () => {
        const h = signEdge(SECRET, BOX, 3, NOW);
        expect(verifyEdge(h, undefined, NOW)).toBe('invalid');
        expect(verifyEdge(h, 'cd'.repeat(32), NOW)).toBe('invalid');
        expect(verifyEdge({ ...h, [EDGE_HEADERS.generation]: '4' }, SECRET, NOW)).toBe('invalid');
        expect(verifyEdge({ ...h, [EDGE_HEADERS.box]: OTHER }, SECRET, NOW)).toBe('invalid');
        expect(verifyEdge({ ...h, [EDGE_HEADERS.sig]: 'f'.repeat(64) }, SECRET, NOW)).toBe('invalid');
        expect(verifyEdge({ ...h, [EDGE_HEADERS.sig]: undefined }, SECRET, NOW)).toBe('invalid');
        expect(verifyEdge({ [EDGE_HEADERS.box]: BOX }, SECRET, NOW)).toBe('invalid');
        expect(verifyEdge({ ...h, [EDGE_HEADERS.box]: [BOX, BOX] }, SECRET, NOW)).toBe('invalid');
        // 60 seconds either way
        expect(verifyEdge(h, SECRET, NOW + 60_000)).toEqual({ boxId: BOX, generation: 3 });
        expect(verifyEdge(h, SECRET, NOW + 61_000)).toBe('invalid');
        expect(verifyEdge(h, SECRET, NOW - 61_000)).toBe('invalid');
    });
});

describe('provenance rule', () => {
    const edge = { boxId: BOX, generation: 2 };
    const bound = { boxId: BOX, generation: 2 };

    it('a box credential works only through its own box at its current generation', () => {
        expect(provenanceRefusal(edge, bound, 2)).toBeNull();
        expect(provenanceRefusal(null, bound, 2)).toBe('box_token_outside_box');
        expect(provenanceRefusal({ boxId: OTHER, generation: 2 }, bound, 2)).toBe('token_not_for_this_box');
        expect(provenanceRefusal({ boxId: BOX, generation: 1 }, bound, 2)).toBe('token_not_for_this_box');
        // Token and edge agree, but the box moved on (rebuilt): the old generation is dead
        expect(provenanceRefusal({ boxId: BOX, generation: 1 }, { boxId: BOX, generation: 1 }, 2)).toBe('bad_edge_signature');
        expect(provenanceRefusal(edge, bound, null)).toBe('bad_edge_signature');
        expect(provenanceRefusal(edge, { boxId: `${BOX}`, generation: 2 }, 2)).toBeNull();
    });

    it('through a box only its credentials work; elsewhere ordinary ones do', () => {
        expect(provenanceRefusal(edge, null, null)).toBe('token_not_for_this_box');
        expect(provenanceRefusal(edge, { boxId: null, generation: null }, null)).toBe('token_not_for_this_box');
        expect(provenanceRefusal(null, null, null)).toBeNull();
        expect(provenanceRefusal(null, { boxId: '  ', generation: null }, null)).toBeNull();
    });

    it('invalid edge headers are refused whatever the credential', () => {
        expect(provenanceRefusal('invalid', null, null)).toBe('bad_edge_signature');
        expect(provenanceRefusal('invalid', bound, 2)).toBe('bad_edge_signature');
    });
});

describe('edge request subjects', () => {
    const push = { owner: 'acme', repo: 'web', commands: [['0'.repeat(40), 'a'.repeat(40), 'refs/heads/feature']] as [string, string, string][] };

    it('subjectHash is canonical (key order) and kind-bound', () => {
        expect(subjectHash('domain', { host: 'example.com' })).toMatch(/^[0-9a-f]{64}$/);
        const reordered = { commands: push.commands, repo: 'web', owner: 'acme' };
        expect(subjectHash('push', reordered as any)).toBe(subjectHash('push', push));
        expect(subjectHash('push', { ...push, repo: 'api' })).not.toBe(subjectHash('push', push));
        expect(subjectHash('pr', { host: 'example.com' } as any)).not.toBe(subjectHash('domain', { host: 'example.com' }));
        const reversed = { ...push, commands: [...push.commands, ['b'.repeat(40), 'c'.repeat(40), 'refs/heads/a']] as [string, string, string][] };
        expect(subjectHash('push', reversed)).not.toBe(subjectHash('push', { ...reversed, commands: [...reversed.commands].reverse() }));
    });

    it('describe says what is asked for', () => {
        expect(describeRequest('domain', { host: 'example.com' })).toBe('reach `example.com`');
        expect(describeRequest('push', push)).toBe(`push to \`acme/web\`: \`feature\` (none) → ${'a'.repeat(10)}`);
        const pr = { owner: 'acme', repo: 'web', head: 'feature', headSha: 'b'.repeat(40), base: 'main', baseSha: 'c'.repeat(40), payloadHash: 'd'.repeat(64), title: 'Fix it', draft: true };
        expect(describeRequest('pr', pr)).toBe(`open a draft pull request in \`acme/web\`: \`feature\` (${'b'.repeat(10)}) → \`main\`, "Fix it"`);
        expect(describeRequest('pr', { ...pr, draft: false, title: 'x'.repeat(300) })).toContain(`"${'x'.repeat(120)}"`);
    });

    // Security review #6: agent text on a card is shown as text, never markdown it controls
    it('describe keeps agent text to one line with markdown escaped and code spans closed', () => {
        const pr = { owner: 'acme', repo: 'web', head: 'feat`x', headSha: 'b'.repeat(40), base: 'main', baseSha: 'c'.repeat(40), payloadHash: 'd'.repeat(64), title: 'Fix\n\n**Approved by owner** [ok](https://evil.example) `x`', draft: false };
        const text = describeRequest('pr', pr);
        expect(text).not.toContain('\n');
        expect(text).toContain('\\*\\*Approved by owner\\*\\* \\[ok\\]\\(https://evil.example\\)');
        expect(text).toContain("`feat'x`");
        expect(text.split('`').length % 2).toBe(1);
        expect(describeRequest('push', { ...push, commands: [['0'.repeat(40), 'a'.repeat(40), 'refs/heads/a`b']] })).toContain("`a'b`");
    });

    it('the card carries the fixed system_data shape', () => {
        const card = edgeCard({ id: `${BOX} `, box_id: OTHER, kind: 'push', subject: push, status: 'pending' }, 'alpha');
        expect(card.content).toBe(`Box **alpha** wants to ${describeRequest('push', push)}. waits for the owner.`);
        expect(card.systemData).toEqual({ requestId: BOX, boxId: OTHER, boxName: 'alpha', kind: 'push', status: 'pending', summary: describeRequest('push', push), subject: push, canAlways: true });
        expect(edgeCard({ id: BOX, box_id: OTHER, kind: 'domain', subject: { host: 'a.io' }, status: 'allowed' }, 'alpha').systemData.canAlways).toBe(false);
    });
});
