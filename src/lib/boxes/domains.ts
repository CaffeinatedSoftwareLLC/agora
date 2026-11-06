import { parse } from 'tldts';
import { BOX_ADAPTER_REGISTRY } from './adapters';
import { DOMAIN_ENTRY, PROVIDER_DOMAINS } from './contract';

/**
 * Which domains a box may be offered, beyond its allowlist (docs/agent-boxes.md §4.2):
 * the telemetry hosts the edge refuses without a card, and the bounded wildcard a domain card
 * can allow. Shared by the edge and the API, so both read the same rules.
 */

/**
 * Telemetry, metrics and error-report hosts of the CLIs a box runs, from each adapter's entry in
 * the box adapter registry (adapters.ts). Each CLI works without them
 * (its vendor documents switching them off, and the box does: agora-host's childEnv and box
 * arguments), so the edge refuses them without an approval card. A name here covers its
 * subdomains. Only the ingest hosts are listed, never a vendor's whole domain: an agent working
 * on a project that uses Sentry or Datadog still reaches their APIs (with a card). The owner can
 * let one through by adding its exact name to the box's allowlist; a wildcard never does.
 */
export const TELEMETRY_DOMAINS: readonly { domain: string; cli: string; what: string }[] = Object.values(BOX_ADAPTER_REGISTRY)
    .flatMap(spec => spec.telemetry.map(t => ({ domain: t.domain, cli: spec.label, what: t.what })));

const under = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** A telemetry host (or a subdomain of one). */
export function isTelemetryHost(host: string): boolean {
    const h = host.toLowerCase().replace(/\.$/, '');
    return TELEMETRY_DOMAINS.some(t => under(h, t.domain));
}

const PSL = { allowPrivateDomains: true, extractHostname: false, detectIp: true } as const;

/**
 * A public suffix by the Public Suffix List, private section included: `com`, `co.uk`, and
 * names like `github.io` or `herokuapp.com` whose subdomains belong to different people. A name
 * the list doesn't know (tldts's default rule: any unknown last label) counts as one too.
 */
function isPublicSuffix(name: string): boolean {
    const p = parse(name, PSL);
    return p.isIp !== false || !p.domain || p.publicSuffix === name;
}

// ─── Rules beneath a name ───
// tldts answers "what is this name's suffix", not "does any rule sit under this name", which a
// wildcard needs: `*.amazonaws.com` is over no suffix itself but covers `s3.amazonaws.com` (a
// suffix: everyone's buckets). So the list's own rule trie is read here. It ships as plain data
// in the pinned tldts (exact version in package.json); anything unexpected fails closed.

interface RuleTrie {
    nodeFlags: ArrayLike<number>; edgeStart: ArrayLike<number>; edgeLength: ArrayLike<number>;
    edgeChild: ArrayLike<number>; labelText: string; rulesRoot: number;
}
let trie: { t: RuleTrie; offsets: Uint32Array } | null | undefined;
function ruleTrie(): { t: RuleTrie; offsets: Uint32Array } | null {
    if (trie !== undefined) return trie;
    trie = null;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const t = require('tldts/dist/cjs/src/data/trie') as RuleTrie;
        const n = t.edgeLength?.length;
        if (typeof t.labelText !== 'string' || !Number.isInteger(t.rulesRoot) || !n || t.edgeChild?.length !== n
            || t.edgeStart?.length !== (t.nodeFlags?.length ?? -1) + 1 || t.edgeStart[t.nodeFlags.length] !== n) return trie;
        // Edge labels are stored back to back in labelText, in edge order
        const offsets = new Uint32Array(n);
        let at = 0;
        for (let e = 0; e < n; e++) { offsets[e] = at; at += t.edgeLength[e]; }
        if (at !== t.labelText.length) return trie;
        trie = { t, offsets };
    } catch { /* stays null */ }
    return trie;
}

/**
 * Whether the Public Suffix List has any rule strictly under `name` (`s3.amazonaws.com` under
 * `amazonaws.com`, `*.oaiusercontent.com` under `oaiusercontent.com`). True when the list's data
 * can't be read: a wildcard is then never considered safe.
 */
export function hasRulesBeneath(name: string): boolean {
    const loaded = ruleTrie();
    if (!loaded) return true;
    const { t, offsets } = loaded;
    let node = t.rulesRoot;
    for (const label of name.toLowerCase().split('.').reverse()) {
        let next = -1; let star = -1;
        for (let e = t.edgeStart[node]; e < t.edgeStart[node + 1]; e++) {
            const text = t.labelText.slice(offsets[e], offsets[e] + t.edgeLength[e]);
            if (text === label) { next = e; break; }
            if (text === '*') star = e;
        }
        if (next === -1) next = star;
        // No rule reaches this far down: nothing is under the name
        if (next === -1) return false;
        node = t.edgeChild[next];
    }
    return t.edgeStart[node + 1] > t.edgeStart[node];
}

/**
 * The wildcards Agora itself puts on default allowlists (contract.ts): reviewed per provider,
 * so they are kept even though the list puts per-user suffixes under them
 * (`*.oaiusercontent.com`: OpenAI's own content hosts).
 */
const REVIEWED_WILDCARDS = new Set(Object.values(PROVIDER_DOMAINS).flat().filter(d => d.startsWith('*.')));

/**
 * `*.base` that would reach sites of more than one owner: `base` is a public suffix (`*.com`,
 * `*.co.uk`, `*.github.io`) or has one under it (`*.amazonaws.com` covers every S3 bucket,
 * `*.windows.net` every Azure blob account). A reviewed default (`*.oaiusercontent.com`) is not.
 */
export function wildcardTooWide(entry: string): boolean {
    if (!entry.startsWith('*.')) return false;
    const e = entry.toLowerCase();
    if (REVIEWED_WILDCARDS.has(e)) return false;
    const base = e.slice(2);
    return isPublicSuffix(base) || hasRulesBeneath(base);
}

/**
 * The wildcard a domain card may offer for `host`: `*.` plus its registrable domain by the
 * Public Suffix List, private section included, when that covers no other public suffix.
 * `a.b.example.com` offers `*.example.com`, `a.evil.github.io` `*.evil.github.io` (never
 * `*.github.io`), `bucket.x.s3.amazonaws.com` `*.x.s3.amazonaws.com`. `sts.amazonaws.com`
 * offers nothing: `*.amazonaws.com` would cover `s3.amazonaws.com`.
 *
 * Null also when the host is its registrable domain already (`example.com`, `evil.github.io`),
 * is itself a public suffix (`s3.amazonaws.com`, `x.oaiusercontent.com`), its top-level suffix
 * isn't on the list, or it is an IP: nothing wider is offered.
 */
export function wildcardFor(host: string): string | null {
    const h = host.toLowerCase().replace(/\.$/, '');
    if (h.startsWith('*.') || !DOMAIN_ENTRY.test(h)) return null;
    const p = parse(h, PSL);
    if (p.isIp !== false || (!p.isIcann && !p.isPrivate)) return null;
    const base = p.domain;
    if (!base || base === h || !h.endsWith(`.${base}`)) return null;
    const entry = `*.${base}`;
    return DOMAIN_ENTRY.test(entry) && !wildcardTooWide(entry) ? entry : null;
}
