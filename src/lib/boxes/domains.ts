import { parse } from 'tldts';
import { DOMAIN_ENTRY } from './contract';

/**
 * Which domains a box may be offered, beyond its allowlist (docs/agent-boxes.md §4.2):
 * the telemetry hosts the edge refuses without a card, and the bounded wildcard a domain card
 * can allow. Shared by the edge and the API, so both read the same rules.
 */

/**
 * Telemetry, metrics, error-report and experiment hosts of the CLIs a box runs. Each CLI works
 * without them (its vendor documents switching them off, and the box does: agora-host's
 * childEnv and box arguments), so the edge refuses them without an approval card. A name here
 * covers its subdomains. The owner can still allow one by adding its exact name to the box's
 * allowlist; a wildcard entry never lets one through.
 */
export const TELEMETRY_DOMAINS: readonly { domain: string; cli: string; what: string }[] = [
    { domain: 'ab.chatgpt.com', cli: 'Codex', what: 'usage metrics (OpenTelemetry export; `analytics.enabled`)' },
    { domain: 'sentry.io', cli: 'Codex', what: 'feedback and crash reports (`*.ingest.us.sentry.io`)' },
    { domain: 'statsig.anthropic.com', cli: 'Claude Code', what: 'feature flags and events (older versions)' },
    { domain: 'statsig.com', cli: 'Claude Code', what: 'feature flags and events (older versions)' },
    { domain: 'datadoghq.com', cli: 'Claude Code', what: 'operational metrics (`http-intake.logs.us5.datadoghq.com`)' },
    { domain: 'browser-intake-us5-datadoghq.com', cli: 'Claude Code', what: 'error reports' },
];

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

/**
 * `*.base` where `base` is a public suffix: `*.com`, `*.co.uk`, `*.github.io`. Such an entry
 * would let a box reach every site under that suffix, whoever runs it.
 */
export function wildcardTooWide(entry: string): boolean {
    if (!entry.startsWith('*.')) return false;
    return isPublicSuffix(entry.slice(2).toLowerCase());
}

/**
 * The wildcard a domain card may offer for `host`: `*.` plus its registrable domain by the
 * Public Suffix List, private section included. `a.b.example.com` offers `*.example.com`,
 * `a.evil.github.io` offers `*.evil.github.io` (never `*.github.io`), and
 * `bucket.x.s3.amazonaws.com` offers `*.x.s3.amazonaws.com`.
 *
 * A host that is itself a private suffix has no registrable domain under the list: OpenAI lists
 * `*.oaiusercontent.com`, so every region (`sdmntprwestus.oaiusercontent.com`) is one. Its bound
 * is then the operator's own registrable domain under the ICANN rules (`oaiusercontent.com`,
 * so `*.oaiusercontent.com`), as long as that isn't a public suffix itself (`github.io`).
 *
 * Null when the host is its registrable domain already (`example.com`, `evil.github.io`), its
 * top-level suffix is not on the list, or it is an IP: nothing wider is offered.
 */
export function wildcardFor(host: string): string | null {
    const h = host.toLowerCase().replace(/\.$/, '');
    if (h.startsWith('*.') || !DOMAIN_ENTRY.test(h)) return null;
    const p = parse(h, PSL);
    if (p.isIp !== false || (!p.isIcann && !p.isPrivate)) return null;
    let base = p.domain;
    if (!base && p.isPrivate) base = parse(h, { ...PSL, allowPrivateDomains: false }).domain;
    if (!base || base === h || !h.endsWith(`.${base}`)) return null;
    const entry = `*.${base}`;
    return DOMAIN_ENTRY.test(entry) && !wildcardTooWide(entry) ? entry : null;
}
