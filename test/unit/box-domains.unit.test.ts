import { describe, expect, it } from 'vitest';
import { defaultAllowlist, domainAllowed, DOMAIN_ENTRY } from '../../src/lib/boxes/contract';
import { hasRulesBeneath, isTelemetryHost, TELEMETRY_DOMAINS, wildcardFor, wildcardTooWide } from '../../src/lib/boxes/domains';
import { loginProviderHost } from '../../src/boxes/edge/forward-proxy';

/** docs/agent-boxes.md §4.2: telemetry refused without a card, and a card's bounded wildcard. */

describe('wildcardFor: bounded to the registrable domain', () => {
    it.each([
        ['files.example.com', '*.example.com'],
        ['a.b.c.example.com', '*.example.com'],
        ['cdn.example.co.uk', '*.example.co.uk'],
        ['a.evil.github.io', '*.evil.github.io'],
        ['x.y.something.herokuapp.com', '*.something.herokuapp.com'],
        ['bucket.x.s3.amazonaws.com', '*.x.s3.amazonaws.com'],
        ['FILES.Example.COM.', '*.example.com'],
    ])('%s → %s', (host, entry) => {
        expect(wildcardFor(host)).toBe(entry);
    });

    it.each([
        // The host is already its registrable domain: nothing below it to widen to
        'example.com', 'example.co.uk', 'evil.github.io', 'something.herokuapp.com', 'oaiusercontent.com',
        // The registrable domain has other people's suffixes under it (security review): S3
        // buckets, Azure blob accounts, Lambda URLs, Fastly, EC2
        'sts.amazonaws.com', 'foo.amazonaws.com', 'a.b.windows.net', 'x.core.windows.net', 'a.b.on.aws', 'a.b.fastly.net',
        'a.b.cn-north-1.amazonaws.com.cn',
        // Hosts that are public suffixes themselves
        's3.amazonaws.com', 's3.us-east-1.amazonaws.com', 'x.elb.amazonaws.com', 'us-east-2.compute.amazonaws.com',
        'sdmntprwestus.oaiusercontent.com',
        // Public suffixes themselves, IPs, wildcards, invalid names
        'com', 'co.uk', 'github.io', '1.2.3.4', '*.example.com', 'exa mple.com', '',
        // A top-level suffix the list doesn't know
        'a.b.notarealtld',
    ])('%s → none', host => {
        expect(wildcardFor(host)).toBeNull();
    });

    it('never offers a wildcard over a public suffix, whatever the host', () => {
        const hosts = ['a.b.co.uk', 'x.github.io', 'q.r.blogspot.com', 'deep.a.b.c.d.example.com', 'one.two.s3.amazonaws.com', 'z.appspot.com', 'z.vercel.app',
            'sts.amazonaws.com', 'a.b.windows.net', 'x.y.cloudfront.net', 'a.b.googleusercontent.com', 'a.b.azurewebsites.net', 'x.y.z.workers.dev'];
        for (const h of hosts) {
            const w = wildcardFor(h);
            if (w === null) continue;
            expect(wildcardTooWide(w)).toBe(false);
            // Nothing that is a public suffix sits under the offered wildcard
            expect(hasRulesBeneath(w.slice(2)), w).toBe(false);
            expect(DOMAIN_ENTRY.test(w)).toBe(true);
            // The wildcard covers the host it was offered for
            expect(domainAllowed(h, [w])).toBe(true);
        }
    });
});

describe('the rule trie', () => {
    it('reads the list shipped with tldts', () => {
        expect(hasRulesBeneath('amazonaws.com')).toBe(true);
        expect(hasRulesBeneath('oaiusercontent.com')).toBe(true);
        expect(hasRulesBeneath('com')).toBe(true);
        expect(hasRulesBeneath('example.com')).toBe(false);
        expect(hasRulesBeneath('chatgpt.com')).toBe(false);
    });
});

describe('wildcardTooWide', () => {
    it.each(['*.com', '*.co.uk', '*.github.io', '*.herokuapp.com', '*.s3.amazonaws.com', '*.blogspot.com', '*.notarealtld',
        '*.amazonaws.com', '*.windows.net', '*.on.aws', '*.fastly.net', '*.amazonaws.com.cn', '*.compute.amazonaws.com', '*.Amazonaws.COM'])('%s is too wide', e => {
        expect(wildcardTooWide(e)).toBe(true);
    });
    // *.oaiusercontent.com has per-user suffixes under it, but it is a reviewed default (contract.ts)
    it.each(['*.oaiusercontent.com', '*.example.com', '*.example.co.uk', '*.evil.github.io', '*.cdn.example.net', 'example.com', 'github.io', 'amazonaws.com'])('%s is fine', e => {
        // Exact names are not wildcards: they reach one host
        expect(wildcardTooWide(e)).toBe(false);
    });
});

describe('telemetry hosts', () => {
    it.each(['ab.chatgpt.com', 'o33249.ingest.us.sentry.io', 'o1.ingest.sentry.io', 'statsig.anthropic.com',
        'http-intake.logs.us5.datadoghq.com', 'browser-intake-us5-datadoghq.com', 'AB.ChatGPT.com.'])('%s is telemetry', h => {
        expect(isTelemetryHost(h)).toBe(true);
    });
    // Only the ingest hosts: a project's own use of a vendor's API still gets a card
    it.each(['chatgpt.com', 'api.openai.com', 'api.anthropic.com', 'platform.claude.com', 'notsentry.io', 'xab.chatgpt.com',
        'sentry.io', 'api.datadoghq.com', 'api.statsig.com'])('%s is not', h => {
        expect(isTelemetryHost(h)).toBe(false);
    });
    it('no default allowlist reaches a telemetry host', () => {
        for (const adapter of ['claude', 'codex', 'gemini', 'opencode']) {
            for (const t of TELEMETRY_DOMAINS) expect(defaultAllowlist(adapter)).not.toContain(t.domain);
        }
    });
});

describe('login provider hosts (what a login may wait on)', () => {
    it('only the box CLI\'s own provider', () => {
        expect(loginProviderHost('claude', 'platform.claude.com')).toBe(true);
        expect(loginProviderHost('claude', 'api.anthropic.com')).toBe(true);
        expect(loginProviderHost('claude', 'auth.openai.com')).toBe(false);
        expect(loginProviderHost('codex', 'auth.openai.com')).toBe(true);
        expect(loginProviderHost('codex', 'evilopenai.com')).toBe(false);
        expect(loginProviderHost(null, 'auth.openai.com')).toBe(false);
        expect(loginProviderHost('gemini', 'platform.claude.com')).toBe(false);
    });
});
