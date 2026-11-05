import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The fixed parts of the agent box contract (docs/agent-boxes.md), shared by the API,
 * boxd and the edge. Names here are what the socket proxy allowlist and the tests match.
 */

/** The install's name (AGORA_INSTANCE, #209); prefixes every container, network and volume. */
export function instanceName(env: NodeJS.ProcessEnv = process.env): string {
    const name = env.AGORA_INSTANCE || 'agora';
    // New installs are named by setup-env (letters, digits, dashes); an install from before #209
    // keeps its Compose project name, which may also hold underscores or start with a digit
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name)) throw new Error('AGORA_INSTANCE must be a Compose project name: lowercase letters, digits, dashes and underscores');
    return name;
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
function lowerId(boxId: string): string {
    const id = boxId.trim();
    if (!ULID.test(id)) throw new Error('Invalid box id');
    return id.toLowerCase();
}
export const boxContainerName = (instance: string, boxId: string) => `${instance}-box-${lowerId(boxId)}`;
export const boxNetworkName = (instance: string, boxId: string) => `${instance}_box_${lowerId(boxId)}`;
export const boxVolumeName = (instance: string, boxId: string) => `${instance}-box-${lowerId(boxId)}-home`;

/** Labels on everything boxd creates. */
export const LABEL_INSTANCE = 'org.agora.instance';
export const LABEL_BOX = 'org.agora.box';
export const LABEL_BOX_VERSION = 'org.agora.box.version';
export const LABEL_BOX_GENERATION = 'org.agora.box.generation';

/** Inside the box (§3, §7.1). */
export const BOX_UID = 1000;
export const BOX_HOME = '/home/agent';
export const EDGE_HOSTNAME = 'edge';
export const EDGE_AGORA_PORT = 8080;
export const EDGE_PROXY_PORT = 3128;
/** In each box's /28: .1 is Docker's bridge, the edge .2, the box .3. */
export const EDGE_HOST_OFFSET = 2;
export const BOX_HOST_OFFSET = 3;
/** The pool boxd takes /28s from, unless AGORA_BOX_SUBNETS says otherwise. */
export const DEFAULT_BOX_SUBNETS = '10.213.0.0/16';

/** Default allowlist per adapter (§4.2); github.com is deliberately absent (git goes through the broker). */
export const PROVIDER_DOMAINS: Record<string, string[]> = {
    // Checked against the pinned CLIs' binaries (2026-11-04): claude 2.1.x calls the API at
    // api.anthropic.com and exchanges its login code at platform.claude.com/v1/oauth/token; codex
    // 0.163 signs in at auth.openai.com and talks to chatgpt.com/backend-api and api.openai.com.
    // Codex also fetches content from regional *.oaiusercontent.com hosts on its first start
    // (seen live 2026-11-04: three regions, one card each). Telemetry hosts are left out and
    // refused without a card (domains.ts): the box also turns the CLIs' non-essential traffic off.
    claude: ['api.anthropic.com', 'platform.claude.com', 'claude.ai', 'console.anthropic.com'],
    codex: ['api.openai.com', 'chatgpt.com', 'auth.openai.com', '*.oaiusercontent.com'],
    gemini: ['generativelanguage.googleapis.com'],
    opencode: ['openrouter.ai'],
};
export const REGISTRY_DOMAINS = ['registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org'];
export function defaultAllowlist(adapter: string): string[] {
    return [...(PROVIDER_DOMAINS[adapter] ?? []), ...REGISTRY_DOMAINS];
}

/** An allowlist entry: an exact host name or `*.suffix`; never an IP, never a bare `*`. */
export const DOMAIN_ENTRY = /^(\*\.)?(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
export function domainAllowed(host: string, allowlist: string[]): boolean {
    const h = host.toLowerCase().replace(/\.$/, '');
    return allowlist.some(entry => entry.startsWith('*.') ? h.endsWith(entry.slice(1)) && h.length > entry.length - 1 : h === entry);
}

// ─── Edge provenance (§4.1) ───

export const EDGE_HEADERS = {
    box: 'x-agora-edge-box',
    generation: 'x-agora-edge-gen',
    ts: 'x-agora-edge-ts',
    sig: 'x-agora-edge-sig',
} as const;
/** How far an edge timestamp may be from the API's clock. */
export const EDGE_SKEW_SECONDS = 60;

function edgeMac(secret: string, boxId: string, generation: number, ts: number): string {
    return createHmac('sha256', secret).update(`agora-edge/v1\n${boxId}\n${generation}\n${ts}`).digest('hex');
}

/** The headers the edge adds to every request it forwards to the API. */
export function signEdge(secret: string, boxId: string, generation: number, now = Date.now()): Record<string, string> {
    const ts = Math.floor(now / 1000);
    return {
        [EDGE_HEADERS.box]: boxId,
        [EDGE_HEADERS.generation]: String(generation),
        [EDGE_HEADERS.ts]: String(ts),
        [EDGE_HEADERS.sig]: edgeMac(secret, boxId, generation, ts),
    };
}

export type EdgeProvenance = { boxId: string; generation: number } | 'invalid' | null;

/**
 * What the edge headers on a request say: null when there are none, 'invalid' when any is
 * present but they don't verify (or the API has no AGORA_EDGE_SECRET), else the box.
 */
export function verifyEdge(headers: Record<string, string | string[] | undefined>, secret: string | undefined, now = Date.now()): EdgeProvenance {
    const one = (name: string) => { const v = headers[name]; return Array.isArray(v) ? (v.length === 1 ? v[0] : undefined) : v; };
    const present = Object.values(EDGE_HEADERS).some(h => headers[h] !== undefined);
    if (!present) return null;
    const boxId = one(EDGE_HEADERS.box); const gen = one(EDGE_HEADERS.generation);
    const ts = one(EDGE_HEADERS.ts); const sig = one(EDGE_HEADERS.sig);
    if (!secret || !boxId || !ULID.test(boxId) || !gen || !/^\d{1,9}$/.test(gen) || !ts || !/^\d{1,12}$/.test(ts) || !sig || !/^[0-9a-f]{64}$/.test(sig)) return 'invalid';
    if (Math.abs(Math.floor(now / 1000) - Number(ts)) > EDGE_SKEW_SECONDS) return 'invalid';
    const expected = Buffer.from(edgeMac(secret, boxId, Number(gen), Number(ts)), 'hex');
    const given = Buffer.from(sig, 'hex');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return 'invalid';
    return { boxId, generation: Number(gen) };
}

/** A credential's box binding, from agent_hosts or bot_tokens (box_id, box_generation). */
export interface BoxBinding { boxId: string | null; generation: number | null }

export type ProvenanceRefusal = 'bad_edge_signature' | 'box_token_outside_box' | 'token_not_for_this_box';

/**
 * The two-way rule (§4.1): a box credential works only through its own box's edge at its
 * current generation, and through a box's edge only that box's credentials work.
 * `currentGeneration` is agent_boxes.generation for the credential's box (null if none).
 */
export function provenanceRefusal(edge: EdgeProvenance, binding: BoxBinding | null, currentGeneration: number | null): ProvenanceRefusal | null {
    if (edge === 'invalid') return 'bad_edge_signature';
    const boxId = binding?.boxId?.trim() || null;
    if (boxId) {
        if (!edge) return 'box_token_outside_box';
        if (edge.boxId !== boxId || binding!.generation !== edge.generation) return 'token_not_for_this_box';
        if (currentGeneration === null || currentGeneration !== edge.generation) return 'bad_edge_signature';
        return null;
    }
    // Not a box credential (a person, a host-mode bot, an unbound token): never from inside a box
    if (edge) return 'token_not_for_this_box';
    return null;
}
