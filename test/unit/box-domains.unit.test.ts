import { describe, expect, it } from 'vitest';
import { defaultAllowlist, domainAllowed, DOMAIN_ENTRY } from '../../src/lib/boxes/contract';
import { isTelemetryHost, TELEMETRY_DOMAINS, wildcardFor, wildcardTooWide } from '../../src/lib/boxes/domains';
import { loginProviderHost } from '../../src/boxes/edge/forward-proxy';

/** docs/agent-boxes.md §4.2: telemetry refused without a card, and a card's bounded wildcard. */

describe('wildcardFor: bounded to the registrable domain', () => {
    it.each([
        ['sdmntprwestus.oaiusercontent.com', '*.oaiusercontent.com'],
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
        // Public suffixes themselves, IPs, wildcards, invalid names
        'com', 'co.uk', 'github.io', '1.2.3.4', '*.example.com', 'exa mple.com', '',
        // A top-level suffix the list doesn't know
        'a.b.notarealtld',
    ])('%s → none', host => {
        expect(wildcardFor(host)).toBeNull();
    });

    it('never offers a wildcard over a public suffix, whatever the host', () => {
        const hosts = ['a.b.co.uk', 'x.github.io', 'q.r.blogspot.com', 'deep.a.b.c.d.example.com', 'one.two.s3.amazonaws.com', 'z.appspot.com', 'z.vercel.app'];
        for (const h of hosts) {
            const w = wildcardFor(h);
            if (w === null) continue;
            expect(wildcardTooWide(w)).toBe(false);
            expect(DOMAIN_ENTRY.test(w)).toBe(true);
            // The wildcard covers the host it was offered for
            expect(domainAllowed(h, [w])).toBe(true);
        }
    });
});

describe('wildcardTooWide', () => {
    it.each(['*.com', '*.co.uk', '*.github.io', '*.herokuapp.com', '*.s3.amazonaws.com', '*.blogspot.com', '*.notarealtld'])('%s is too wide', e => {
        expect(wildcardTooWide(e)).toBe(true);
    });
    it.each(['*.oaiusercontent.com', '*.example.com', '*.example.co.uk', '*.evil.github.io', '*.cdn.example.net', 'example.com', 'github.io'])('%s is fine', e => {
        // Exact names are not wildcards: they reach one host
        expect(wildcardTooWide(e)).toBe(false);
    });
});

describe('telemetry hosts', () => {
    it.each(['ab.chatgpt.com', 'o33249.ingest.us.sentry.io', 'sentry.io', 'statsig.anthropic.com', 'api.statsig.com',
        'http-intake.logs.us5.datadoghq.com', 'browser-intake-us5-datadoghq.com', 'AB.ChatGPT.com.'])('%s is telemetry', h => {
        expect(isTelemetryHost(h)).toBe(true);
    });
    it.each(['chatgpt.com', 'api.openai.com', 'api.anthropic.com', 'platform.claude.com', 'notsentry.io', 'xab.chatgpt.com', 'evilsentry.io'])('%s is not', h => {
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
