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

/**
 * Where box/Dockerfile gets a CLI. In a URL, `{version}` is the pinned version (the Dockerfile
 * writes its ARG there) and `{arch}` the release's name for the image's CPU.
 * - `npm`: the package, installed at the pinned version.
 * - `binary`: one release file per CPU, checked against its sha256 (amd64 and arm64).
 * - `tarball`: one release archive per CPU, checked against its sha256 (amd64 and arm64) and
 *   unpacked (Devin).
 */
export type BoxImageSource =
    | { npm: string }
    | { binary: { url: string; sha256: { amd64: string; arm64: string } } }
    | { tarball: { url: string; sha256: { amd64: string; arm64: string } } };

export interface BoxAdapterSpec {
    /** Shown on cards and in Settings → Agents. */
    label: string;
    /** The pinned CLI in the box image: its version, the box/Dockerfile ARG that holds it, and its source. */
    image: { version: string; versionArg: string } & BoxImageSource;
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
    /**
     * Hosts the CLI needs only to sign in (exact names, never on the allowlist): the edge lets the
     * box reach them without a card while the owner's login for this box is open, and treats them
     * as any unknown domain otherwise (§4.2.3).
     */
    loginOnly: readonly string[];
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
        loginOnly: [],
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
        loginOnly: [],
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
        loginOnly: [],
        telemetry: [
            { domain: 'opncd.ai', what: 'session sharing (off: `share: "disabled"`, `OPENCODE_DISABLE_SHARE`)' },
        ],
    },
    omp: {
        label: 'oh-my-pi',
        // The standalone binary from the GitHub release (MIT); omp releases every few days, so it
        // is pinned by version and sha256 (SHA256SUMS.txt of the release)
        image: {
            version: '18.17.0', versionArg: 'OMP_VERSION',
            binary: {
                url: 'https://github.com/can1357/oh-my-pi/releases/download/v{version}/omp-linux-{arch}',
                sha256: {
                    amd64: 'a4ce6001ab1012ca835f4184d675437531bd1ac477a7ba8424ed0b5476e9e4cb',
                    arm64: 'a9423fd7a69d869bf514931226b21d4ff55474225f574e2911fec457fc470e68',
                },
            },
        },
        protocol: 'acp',
        // An OpenRouter key only (docs/provider-terms.md): omp's subscription logins are never used
        authModes: ['api_key'],
        apiKeyEnv: 'OPENROUTER_API_KEY',
        modelRequired: true,
        // Checked against the pinned binary (omp 18.17.0, 2026-11-06, through a logging proxy,
        // a fake key): with only OpenRouter enabled it reaches openrouter.ai/api/v1 and
        // catalog.stencil.so (model metadata, refused below; the turn runs without it). No
        // Anthropic host: omp's Claude-compatible identity is for its Anthropic provider, which
        // is disabled
        allowlist: ['openrouter.ai'],
        loginDomains: [],
        loginOnly: [],
        telemetry: [
            { domain: 'build.stencil.so', what: 'update checks and downloads (interactive mode and `omp update` only; `update.auto: false`)' },
            { domain: 'cloud.stencil.so', what: 'Spotlight experiment (off: `spotlight.experiment.enabled: false`)' },
            { domain: 'catalog.stencil.so', what: 'model metadata (models.dev), fetched at start; omp runs without it' },
        ],
    },
    devin: {
        label: 'Devin',
        // Cognition's release tarball (it is not on npm), one per CPU, checked against its sha256
        // (static.devin.ai/cli/3000.11.234/manifest.json; the x86_64 one also checked by hand)
        image: {
            version: '3000.11.234', versionArg: 'DEVIN_VERSION',
            tarball: {
                url: 'https://static.devin.ai/cli/{version}/devin-{version}-{arch}-unknown-linux.tar.gz',
                sha256: {
                    amd64: '201370cddd2924294e3ca6b46fd8ece49b5763953b644a1dd823fce5490cb41a',
                    arm64: '438ca7f8280b3ef0747afc406e827d9e182156000277a1660358ac4fbd04156e',
                },
            },
        },
        protocol: 'acp',
        // The owner's own Devin login only (docs/provider-terms.md "Devin": Cognition lets only the
        // account holder use an account), relayed into the box with Devin's paste-the-code flow
        authModes: ['subscription'],
        // Never set by boxd: with no api_key mode there is no key. `devin acp` would read an
        // account token from it, so it is named here and nowhere else.
        apiKeyEnv: 'WINDSURF_API_KEY',
        modelRequired: false,
        // Checked against the pinned binary through a logging proxy, with no login (2026-11-06): the
        // Windsurf/Codeium server its credentials name as the API server, contacted at every start
        // and by the login. It is Devin's provider seam: model calls and its own analytics go to the
        // same host and can't be told apart at the edge. api.devin.ai was never contacted, so it is
        // not listed; app.devin.ai is only the sign-in (loginOnly). Model traffic after a login may
        // need more: verify live.
        allowlist: ['server.codeium.com'],
        // The paste login's link is on app.devin.ai, or on windsurf.com when the CLI can't resolve
        // its deployment (seen offline)
        loginDomains: ['devin.ai', 'windsurf.com'],
        loginOnly: ['app.devin.ai'],
        telemetry: [
            { domain: 'unleash.codeium.com', what: 'feature flags, fetched at start (Devin keeps its defaults without them)' },
            { domain: 'ingest.us.sentry.io', what: 'error reports, sent at every session end (`o4507463137361920.ingest.us.sentry.io`)' },
            { domain: 'codeium-i5.sentry.io', what: 'error reports (named in the binary)' },
            { domain: 'static.devin.ai', what: 'update checks and downloads (`auto_update: false`; the CLI is pinned in the image)' },
            { domain: 'cli.devin.ai', what: 'the install script (updates)' },
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
