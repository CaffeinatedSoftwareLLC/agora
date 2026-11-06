/**
 * The box adapter registry, in-box side (docs/agent-boxes.md §8, "Adding a box adapter"):
 * how agora-host runs each CLI inside an agent box. The server's half (default allowlist,
 * telemetry hosts, login domains, the image pins) is src/lib/boxes/adapters.ts in the Agora
 * repo; test/unit/box-adapters.unit.test.ts there checks that the two agree, and that
 * box/Dockerfile installs and links every adapter.
 *
 * Everything here applies only in box mode (box.ts inBox: the flag and the image's marker
 * file), never on a machine. No imports: the server's test reads this file as it is.
 */

export interface BoxAdapterRuntime {
    /** Where box/Dockerfile links the pinned CLI (the fake one in the test image). */
    executable: string;
    /** The image's pin, the same as the server registry's (and box/Dockerfile's ARG). */
    version: string;
    /** "cli": the CLI's own headless mode; "acp": Agent Client Protocol over stdio (acp/session.ts). */
    protocol: 'cli' | 'acp';
    /** Fixed arguments that start the ACP agent; empty for "cli". */
    acpArgs: readonly string[];
    /** Sign-in modes a box of this adapter accepts, as the server registry has them. */
    authModes: readonly ('subscription' | 'api_key')[];
    /** The variable boxd sets the API key in; agora-host passes it to the CLI only. */
    apiKeyEnv: string;
    /**
     * The CLI's own login, run by the box login relay (box-login.ts, §8.2): its arguments, the
     * hosts its sign-in URL may be on (nothing else is relayed), and how the owner finishes it:
     * "device" (approve a one-time code on the vendor's page) or "paste" (paste back a code).
     * null for an adapter with no login (API key only); the relay refuses it.
     */
    login: { args: readonly string[]; hosts: readonly string[]; kind: 'device' | 'paste' } | null;
    /**
     * Non-essential traffic off (telemetry, error reports, update checks, plugin downloads):
     * each would only be refused at the edge, and the CLI is pinned in the image anyway.
     * `env` goes into the CLI's environment, `args` before its subcommand's other arguments.
     */
    quiet: { env: Readonly<Record<string, string>>; args: readonly string[] };
    /**
     * Hosts the CLI reaches without the edge's proxy, added to NO_PROXY (boxd sets `edge`): the
     * CLI's own local server, which it would otherwise ask the edge for and be refused.
     */
    noProxy: readonly string[];
    /**
     * Yeet mode (§8.1): the box is the sandbox. `args` turn the CLI's own sandbox and permission
     * prompts off; `noOpenWeb` turns off tools that reach the open web around the edge (a
     * provider-side web search). `acpAllowAll`: an ACP agent's permission requests are all
     * allowed (its own config is also set to allow, see adapters.ts opencodeConfig). `acpMode`:
     * the ACP session mode a turn switches to first (Devin's "bypass": no prompts at all).
     */
    yeet: { args: readonly string[]; noOpenWeb: readonly string[]; acpAllowAll: boolean; acpMode?: string };
    /**
     * The box rules (/opt/agora/AGENTS.md) as the CLI's global instructions file, and settings
     * files written once if absent; both relative to the profile's state directory.
     */
    state: { rulesFile: string; files: Readonly<Record<string, string>> };
}

export const BOX_ADAPTERS = {
    claude: {
        executable: '/opt/agora/bin/claude',
        version: '2.1.311',
        protocol: 'cli',
        acpArgs: [],
        authModes: ['subscription', 'api_key'],
        apiKeyEnv: 'ANTHROPIC_API_KEY',
        login: { args: ['auth', 'login', '--claudeai'], hosts: ['claude.ai', 'claude.com', 'anthropic.com'], kind: 'paste' },
        // code.claude.com/docs/en/network-config
        quiet: {
            env: {
                // Telemetry, error reports, auto-updates, /feedback, release notes and feature flags
                CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
                DISABLE_AUTOUPDATER: '1',
                // The official plugin marketplace is cloned from github.com, which a box reaches only
                // through the git broker: every start would make a card
                CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
            },
            args: [],
        },
        noProxy: [],
        yeet: { args: ['--dangerously-skip-permissions'], noOpenWeb: ['--disallowedTools', 'WebSearch'], acpAllowAll: false },
        // The CLI is pinned in the image; it must not try to update itself (§6)
        state: { rulesFile: 'CLAUDE.md', files: { 'settings.json': '{\n  "env": { "DISABLE_AUTOUPDATER": "1" }\n}\n' } },
    },
    codex: {
        executable: '/opt/agora/bin/codex',
        version: '0.163.0',
        protocol: 'cli',
        acpArgs: [],
        authModes: ['subscription', 'api_key'],
        apiKeyEnv: 'CODEX_API_KEY',
        login: { args: ['login', '--device-auth'], hosts: ['openai.com', 'chatgpt.com'], kind: 'device' },
        // Usage metrics to ab.chatgpt.com, feedback reports to Sentry, and the update check (§4.2.1).
        // Root-level `-c` overrides, accepted by `codex exec`, `codex app-server` and `codex login`
        // alike (Codex type-checks them, so a renamed key fails loudly)
        quiet: { env: {}, args: ['-c', 'analytics.enabled=false', '-c', 'feedback.enabled=false', '-c', 'check_for_update_on_startup=false'] },
        noProxy: [],
        yeet: { args: ['--dangerously-bypass-approvals-and-sandbox'], noOpenWeb: ['-c', 'web_search="disabled"'], acpAllowAll: false },
        state: { rulesFile: 'AGENTS.md', files: {} },
    },
    opencode: {
        executable: '/opt/agora/bin/opencode',
        version: '1.18.34',
        protocol: 'acp',
        acpArgs: ['acp'],
        // An OpenRouter key only (terms.ts OPENCODE_ACP_ONLY); opencode reads OPENROUTER_API_KEY
        authModes: ['api_key'],
        apiKeyEnv: 'OPENROUTER_API_KEY',
        login: null,
        // On top of the switches every opencode run gets (adapters.ts OPENCODE_FLAGS: no update
        // checks, sharing, LSP downloads, external plugins): no default plugins either, which
        // opencode would otherwise install from npm at start
        quiet: { env: { OPENCODE_DISABLE_DEFAULT_PLUGINS: '1' }, args: [] },
        // `opencode acp` talks to its own server on 127.0.0.1:4096 over HTTP, and Bun sends that
        // through HTTP_PROXY too: without this every session/new fails (checked on 1.18.34)
        noProxy: ['localhost', '127.0.0.1', '::1'],
        // Its permission config allows everything but web search (adapters.ts opencodeConfig)
        yeet: { args: [], noOpenWeb: [], acpAllowAll: true },
        // XDG_CONFIG_HOME is <state>/config (adapters.ts): opencode's global rules file
        state: { rulesFile: 'config/opencode/AGENTS.md', files: {} },
    },
    devin: {
        executable: '/opt/agora/bin/devin',
        version: '3000.11.234',
        protocol: 'acp',
        acpArgs: ['acp'],
        // The owner's own Devin login, relayed into the box (Cognition's terms: account holder only)
        authModes: ['subscription'],
        // Never set by boxd (no api_key mode): the variable `devin acp` would read an account token from
        apiKeyEnv: 'WINDSURF_API_KEY',
        // `devin auth login` opens a browser on a localhost redirect; this flow prints the sign-in
        // URL on app.devin.ai and reads the code the owner pastes back (checked on 3000.11.234)
        login: { args: ['auth', 'login', '--force-manual-token-flow'], hosts: ['devin.ai'], kind: 'paste' },
        // No switches for these: auto-update and every config import are off in the config each run
        // gets (adapters.ts devinConfig) and in the settings file below, which the login reads. Its
        // feature flags, Sentry reports and update checks are refused at the edge (the server half)
        quiet: { env: {}, args: [] },
        noProxy: [],
        // The session starts in Devin's "Code" mode; a box turn switches it to "bypass" and allows
        // whatever it still asks. Web search is denied in its config (adapters.ts devinConfig)
        yeet: { args: [], noOpenWeb: [], acpAllowAll: true, acpMode: 'bypass' },
        // XDG_CONFIG_HOME is <state>/config (adapters.ts): Devin's global rules file and user config
        state: {
            rulesFile: 'config/devin/AGENTS.md',
            files: {
                'config/devin/config.json': '{\n  "auto_update": false,\n  "read_config_from": { "agents_standard": false, "cursor": false, "windsurf": false, "claude": false, '
                    + '"copilot": false, "opencode": false, "zed": false, "cloud": false }\n}\n',
            },
        },
    },
} as const satisfies Record<string, BoxAdapterRuntime>;

export type BoxAdapterName = keyof typeof BOX_ADAPTERS;
export const BOX_ADAPTER_NAMES = Object.keys(BOX_ADAPTERS) as [BoxAdapterName, ...BoxAdapterName[]];

/** The adapter's in-box entry, or null when boxes don't run it. */
export function boxAdapter(adapter: string): BoxAdapterRuntime | null {
    return Object.prototype.hasOwnProperty.call(BOX_ADAPTERS, adapter) ? BOX_ADAPTERS[adapter as BoxAdapterName] : null;
}
