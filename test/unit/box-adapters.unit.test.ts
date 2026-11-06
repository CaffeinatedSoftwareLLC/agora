import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOX_ADAPTER_REGISTRY, BOX_ADAPTERS, boxAdapterSpec, boxHasLogin } from '../../src/lib/boxes/adapters';
import { defaultAllowlist, DOMAIN_ENTRY, PROVIDER_DOMAINS, REGISTRY_DOMAINS } from '../../src/lib/boxes/contract';
import { isTelemetryHost, TELEMETRY_DOMAINS, wildcardTooWide } from '../../src/lib/boxes/domains';
import { LOGIN_PROVIDER_DOMAINS } from '../../src/lib/boxes/edge-requests';
import { API_KEY_ENV } from '../../src/lib/boxes/service';
import { validApiKeyEnv } from '../../src/boxes/boxd/spec';
// The in-box half of the registry has no imports, so the server's tests can read it as it is
import { BOX_ADAPTERS as HOST_ADAPTERS } from '../../agora-host/src/box-adapters';

/**
 * The box adapter registry (docs/agent-boxes.md, "Adding a box adapter"): the server's half
 * (src/lib/boxes/adapters.ts) and agora-host's (agora-host/src/box-adapters.ts) agree with
 * each other, with box/Dockerfile and with the UI's list; claude and codex resolve to exactly
 * what they were before the registry; opencode's box defaults.
 */

const ROOT = join(__dirname, '../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const names = Object.keys(BOX_ADAPTER_REGISTRY);

describe('the two halves of the registry agree', () => {
    it('same adapters, in the same order', () => {
        expect(Object.keys(HOST_ADAPTERS)).toEqual(names);
        expect(BOX_ADAPTERS).toEqual(names);
    });

    for (const name of names) {
        it(`${name}: protocol, sign-in, key variable, version and login`, () => {
            const server = boxAdapterSpec(name)!;
            const host = HOST_ADAPTERS[name as keyof typeof HOST_ADAPTERS];
            expect(host.protocol).toBe(server.protocol);
            expect([...host.authModes]).toEqual([...server.authModes]);
            expect(host.apiKeyEnv).toBe(server.apiKeyEnv);
            expect(host.version).toBe(server.image.version);
            expect(host.executable).toBe(`/opt/agora/bin/${name}`);
            // A login to relay exactly when the CLI can sign in with its own account, and then the
            // edge knows its sign-in domains (§4.2.3) and the relay its URL hosts
            const login = server.authModes.includes('subscription');
            expect(boxHasLogin(name)).toBe(login);
            expect(host.login !== null).toBe(login);
            expect(server.loginDomains.length > 0).toBe(login);
            for (const h of host.login?.hosts ?? []) expect(server.loginDomains.some(d => h === d || h.endsWith(`.${d}`) || d.endsWith(`.${h}`))).toBe(true);
            // ACP agents are started with their arguments; CLI ones with none
            expect(host.acpArgs.length > 0).toBe(server.protocol === 'acp');
        });
    }
});

describe('each entry is sound', () => {
    for (const [name, spec] of Object.entries(BOX_ADAPTER_REGISTRY)) {
        it(`${name}: allowlist, telemetry hosts and key variable`, () => {
            expect(spec.authModes.length).toBeGreaterThan(0);
            for (const d of spec.allowlist) {
                expect(DOMAIN_ENTRY.test(d), d).toBe(true);
                expect(wildcardTooWide(d), d).toBe(false);
                // Git goes through the broker; telemetry is refused, never allowed by default
                expect(d === 'github.com' || d.endsWith('.github.com')).toBe(false);
                expect(isTelemetryHost(d.replace(/^\*\./, '')), d).toBe(false);
            }
            for (const t of spec.telemetry) expect(DOMAIN_ENTRY.test(t.domain), t.domain).toBe(true);
            // boxd sets the key under this name; it must pass boxd's own check
            expect(validApiKeyEnv(spec.apiKeyEnv)).toBe(true);
            expect(defaultAllowlist(name)).toEqual([...spec.allowlist, ...REGISTRY_DOMAINS]);
        });
    }
});

describe('box/Dockerfile installs and links every adapter', () => {
    const dockerfile = read('box/Dockerfile');
    const stage = (name: string) => {
        const start = dockerfile.search(new RegExp(`^FROM \\S+ AS ${name}$`, 'm'));
        expect(start, `stage ${name}`).toBeGreaterThanOrEqual(0);
        const rest = dockerfile.slice(start + 1);
        const next = rest.search(/^FROM /m);
        return next < 0 ? rest : rest.slice(0, next);
    };
    for (const [name, spec] of Object.entries(BOX_ADAPTER_REGISTRY)) {
        it(`${name}: the pinned version in the box stage, a fake CLI in the test stage`, () => {
            const box = stage('box');
            expect(box).toContain(`ARG ${spec.image.versionArg}=${spec.image.version}\n`);
            expect(box).toContain(`"${spec.image.npm}@\${${spec.image.versionArg}}"`);
            expect(box).toMatch(new RegExp(`ln -s \\S+ /opt/agora/bin/${name}\\b`));
            expect(box).toContain(`/opt/agora/bin/${name} --version`);
            expect(stage('test')).toMatch(new RegExp(`ln -s /opt/agora/fake/${name}\\.mjs /opt/agora/bin/${name}\\b`));
        });
    }
});

describe('the UI offers every adapter', () => {
    it('BOX_ADAPTER_OPTIONS lists the registry with its sign-in modes', () => {
        const source = read('agora-ui/src/features/boxes/boxRules.ts');
        const options = [...source.matchAll(/\{ value: '([a-z0-9-]+)', label: '([^']+)', auth: \[([^\]]*)\]/g)]
            .map(m => ({ value: m[1], label: m[2], auth: [...m[3].matchAll(/'([a-z_]+)'/g)].map(a => a[1]) }));
        expect(options.map(o => o.value)).toEqual(names);
        for (const o of options) {
            const spec = boxAdapterSpec(o.value)!;
            expect(o.label).toBe(spec.label);
            expect(o.auth).toEqual([...spec.authModes]);
        }
        expect(read('agora-ui/src/features/boxes/api.ts')).toContain(`export type BoxAdapter = ${names.map(n => `'${n}'`).join(' | ')};`);
    });
});

// The registry replaced constants spread over the server, boxd and the edge: claude and codex
// must resolve to exactly what those were (no behaviour change)
describe('claude and codex resolve to what they were before the registry', () => {
    it('server side', () => {
        expect(BOX_ADAPTERS.slice(0, 2)).toEqual(['claude', 'codex']);
        expect(API_KEY_ENV.claude).toBe('ANTHROPIC_API_KEY');
        expect(API_KEY_ENV.codex).toBe('CODEX_API_KEY');
        expect(PROVIDER_DOMAINS.claude).toEqual(['api.anthropic.com', 'platform.claude.com', 'claude.ai', 'console.anthropic.com']);
        expect(PROVIDER_DOMAINS.codex).toEqual(['api.openai.com', 'chatgpt.com', 'auth.openai.com', '*.oaiusercontent.com']);
        expect(LOGIN_PROVIDER_DOMAINS.claude).toEqual(['anthropic.com', 'claude.ai', 'claude.com']);
        expect(LOGIN_PROVIDER_DOMAINS.codex).toEqual(['openai.com', 'chatgpt.com']);
        const telemetry = (cli: string) => TELEMETRY_DOMAINS.filter(t => t.cli === cli).map(({ domain, what }) => ({ domain, what }));
        expect(telemetry('Codex')).toEqual([
            { domain: 'ab.chatgpt.com', what: 'usage metrics (OpenTelemetry export; `analytics.enabled`)' },
            { domain: 'ingest.sentry.io', what: 'feedback and crash reports' },
            { domain: 'ingest.us.sentry.io', what: 'feedback and crash reports (`o33249.ingest.us.sentry.io`)' },
            { domain: 'ingest.de.sentry.io', what: 'feedback and crash reports' },
        ]);
        expect(telemetry('Claude Code')).toEqual([
            { domain: 'statsig.anthropic.com', what: 'feature flags and events (older versions)' },
            { domain: 'http-intake.logs.us5.datadoghq.com', what: 'operational metrics' },
            { domain: 'browser-intake-us5-datadoghq.com', what: 'error reports' },
        ]);
        expect(BOX_ADAPTER_REGISTRY.claude.image).toEqual({ npm: '@anthropic-ai/claude-code', version: '2.1.311', versionArg: 'CLAUDE_CODE_VERSION' });
        expect(BOX_ADAPTER_REGISTRY.codex.image).toEqual({ npm: '@openai/codex', version: '0.163.0', versionArg: 'CODEX_VERSION' });
    });

    it('in the box', () => {
        expect(HOST_ADAPTERS.claude).toMatchObject({
            executable: '/opt/agora/bin/claude', protocol: 'cli',
            login: { args: ['auth', 'login', '--claudeai'], hosts: ['claude.ai', 'claude.com', 'anthropic.com'], kind: 'paste' },
            quiet: { env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1' }, args: [] },
            noProxy: [],
            yeet: { args: ['--dangerously-skip-permissions'], noOpenWeb: ['--disallowedTools', 'WebSearch'], acpAllowAll: false },
            state: { rulesFile: 'CLAUDE.md', files: { 'settings.json': '{\n  "env": { "DISABLE_AUTOUPDATER": "1" }\n}\n' } },
        });
        expect(HOST_ADAPTERS.codex).toMatchObject({
            executable: '/opt/agora/bin/codex', protocol: 'cli',
            login: { args: ['login', '--device-auth'], hosts: ['openai.com', 'chatgpt.com'], kind: 'device' },
            quiet: { env: {}, args: ['-c', 'analytics.enabled=false', '-c', 'feedback.enabled=false', '-c', 'check_for_update_on_startup=false'] },
            noProxy: [],
            yeet: { args: ['--dangerously-bypass-approvals-and-sandbox'], noOpenWeb: ['-c', 'web_search="disabled"'], acpAllowAll: false },
            state: { rulesFile: 'AGENTS.md', files: {} },
        });
    });
});

describe('opencode in a box', () => {
    it('an OpenRouter key only, its model required, OpenRouter and the model catalog allowed, sharing refused', () => {
        expect(BOX_ADAPTER_REGISTRY.opencode).toMatchObject({ protocol: 'acp', authModes: ['api_key'], apiKeyEnv: 'OPENROUTER_API_KEY', modelRequired: true, loginDomains: [] });
        expect(defaultAllowlist('opencode')).toEqual(['openrouter.ai', 'models.opencode.ai', 'registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org']);
        expect(LOGIN_PROVIDER_DOMAINS.opencode).toBeUndefined();
        expect(isTelemetryHost('opncd.ai')).toBe(true);
        expect(isTelemetryHost('eu.opncd.ai')).toBe(true);
        expect(isTelemetryHost('opencode.ai')).toBe(false);
        expect(HOST_ADAPTERS.opencode).toMatchObject({ acpArgs: ['acp'], login: null, noProxy: ['localhost', '127.0.0.1', '::1'], yeet: { args: [], noOpenWeb: [], acpAllowAll: true },
            state: { rulesFile: 'config/opencode/AGENTS.md' } });
    });
});
