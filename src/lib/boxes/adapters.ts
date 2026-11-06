/**
 * The box adapter registry, server side (docs/agent-boxes.md §6, "Adding a box adapter"):
 * everything the API, boxd and the edge need to know about each CLI an agent box can run.
 * The in-box half (executables, login commands, quiet and yeet switches) is
 * agora-host/src/box-adapters.ts; test/unit/box-adapters.unit.test.ts checks that the two
 * agree with each other, with box/Dockerfile and with the UI's list.
 *
 * Adding a box adapter is one entry here, its twin in agora-host, an install block and a fake
 * CLI in box/Dockerfile, and tests. Nothing else in the server names an adapter.
 *
 * This file has no imports: contract.ts and domains.ts read it, never the other way round.
 */

export interface BoxTelemetryHost {
    /** An ingest host; a name here covers its subdomains. */
    domain: string;
    /** What the CLI sends there, and the switch that turns it off in a box. */
    what: string;
}

export interface BoxAdapterSpec {
    /** Shown on cards and in Settings → Agents. */
    label: string;
    /** The pinned CLI in the box image: npm package, version and the box/Dockerfile ARG that holds it. */
    image: { npm: string; version: string; versionArg: string };
    /** How agora-host drives it: the CLI's own headless mode, or the Agent Client Protocol. */
    protocol: 'cli' | 'acp';
    /**
     * How it signs in, first one the default. "subscription": the CLI's own login, run inside the
     * box through the login relay (§8.2), owner-only. "api_key": a key the owner gives at
     * creation, stored encrypted per box and set by boxd as `apiKeyEnv` in the box's environment.
     */
    authModes: readonly ('subscription' | 'api_key')[];
    /** The variable the box delivers the API key under (agora-host passes it to the CLI only). */
    apiKeyEnv: string;
    /** A box of this adapter must name its model at creation (opencode has no usable default). */
    modelRequired: boolean;
    /**
     * Default allowlist (§4.2): the provider's API, sign-in and content hosts the pinned CLI needs.
     * Package registries are added by contract.ts. Never github.com (git goes through the broker).
     */
    allowlist: readonly string[];
    /**
     * The domains the CLI's own sign-in and API live under: during an open login the edge holds a
     * request to these for the owner's card instead of refusing it (§4.2.3). Empty without a login.
     */
    loginDomains: readonly string[];
    /** Telemetry, metrics, error-report and share hosts the edge refuses without a card (§4.2.1). */
    telemetry: readonly BoxTelemetryHost[];
}

export const BOX_ADAPTER_REGISTRY = {
    claude: {
        label: 'Claude Code',
        image: { npm: '@anthropic-ai/claude-code', version: '2.1.311', versionArg: 'CLAUDE_CODE_VERSION' },
        protocol: 'cli',
        authModes: ['subscription', 'api_key'],
        apiKeyEnv: 'ANTHROPIC_API_KEY',
        modelRequired: false,
        // Checked against the pinned CLI's binary (2026-11-04): the API at api.anthropic.com, the
        // login code exchanged at platform.claude.com/v1/oauth/token
        allowlist: ['api.anthropic.com', 'platform.claude.com', 'claude.ai', 'console.anthropic.com'],
        loginDomains: ['anthropic.com', 'claude.ai', 'claude.com'],
        telemetry: [
            { domain: 'statsig.anthropic.com', what: 'feature flags and events (older versions)' },
            { domain: 'http-intake.logs.us5.datadoghq.com', what: 'operational metrics' },
            { domain: 'browser-intake-us5-datadoghq.com', what: 'error reports' },
        ],
    },
    codex: {
        label: 'Codex',
        image: { npm: '@openai/codex', version: '0.163.0', versionArg: 'CODEX_VERSION' },
        protocol: 'cli',
        authModes: ['subscription', 'api_key'],
        // The codex CLI reads only CODEX_API_KEY (agora-host src/adapters.ts)
        apiKeyEnv: 'CODEX_API_KEY',
        modelRequired: false,
        // codex 0.163 signs in at auth.openai.com and talks to chatgpt.com/backend-api and
        // api.openai.com; it fetches content from regional *.oaiusercontent.com hosts on its first
        // start (seen live 2026-11-04: three regions, one card each)
        allowlist: ['api.openai.com', 'chatgpt.com', 'auth.openai.com', '*.oaiusercontent.com'],
        loginDomains: ['openai.com', 'chatgpt.com'],
        telemetry: [
            { domain: 'ab.chatgpt.com', what: 'usage metrics (OpenTelemetry export; `analytics.enabled`)' },
            { domain: 'ingest.sentry.io', what: 'feedback and crash reports' },
            { domain: 'ingest.us.sentry.io', what: 'feedback and crash reports (`o33249.ingest.us.sentry.io`)' },
            { domain: 'ingest.de.sentry.io', what: 'feedback and crash reports' },
        ],
    },
    opencode: {
        label: 'opencode',
        image: { npm: 'opencode-ai', version: '1.18.34', versionArg: 'OPENCODE_VERSION' },
        protocol: 'acp',
        // No account login to host (docs/provider-terms.md): an OpenRouter key only
        authModes: ['api_key'],
        apiKeyEnv: 'OPENROUTER_API_KEY',
        modelRequired: true,
        // Checked against the pinned binary (opencode 1.18.34, 2026-11-06): OpenRouter's API at
        // openrouter.ai/api/v1, and the model catalog opencode reads at start and hourly
        // (models.opencode.ai; OPENCODE_DISABLE_MODELS_FETCH would leave it no OpenRouter models)
        allowlist: ['openrouter.ai', 'models.opencode.ai'],
        loginDomains: [],
        telemetry: [
            { domain: 'opncd.ai', what: 'session sharing (off: `share: "disabled"`, `OPENCODE_DISABLE_SHARE`)' },
        ],
    },
} as const satisfies Record<string, BoxAdapterSpec>;

export type BoxAdapter = keyof typeof BOX_ADAPTER_REGISTRY;
export const BOX_ADAPTERS = Object.keys(BOX_ADAPTER_REGISTRY) as BoxAdapter[];

export function isBoxAdapter(adapter: string): adapter is BoxAdapter {
    return Object.prototype.hasOwnProperty.call(BOX_ADAPTER_REGISTRY, adapter);
}

/** The adapter's entry, or null for one boxes don't run. */
export function boxAdapterSpec(adapter: string): BoxAdapterSpec | null {
    return isBoxAdapter(adapter) ? BOX_ADAPTER_REGISTRY[adapter] : null;
}

/** Whether the owner can press Log in on a box of this adapter (a CLI login to relay). */
export function boxHasLogin(adapter: string): boolean {
    return boxAdapterSpec(adapter)?.authModes.includes('subscription') ?? false;
}
