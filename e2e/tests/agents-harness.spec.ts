/**
 * Self-test of the real-CLI agent harness (lib/agent-host.ts, lib/agent-keys.ts,
 * lib/agent-usage.ts) using the FAKE CLI only: no provider, no key, no spend. Proves the
 * isolation rules of beta-test-plan §3.1 before any live run: api_key-only refusal, fresh
 * empty state dirs that are deleted afterwards, provider keys only in the host child, and the
 * leak scan catching a planted key value. Tagged @agent (not @smoke).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, apis, loadSeed } from '../lib/fixtures';
import { AgentHostRefusal, assertEmptyStateDirs, checkHostConfig, nodeTest, startAgentHost, type AgentHost } from '../lib/agent-host';
import { PROVIDER_ENVS } from '../lib/agent-keys';
import { budgetLeft, channelUsage, readLedger, record, usageFile } from '../lib/agent-usage';
import { scanSecrets } from '../lib/finalize';
import { scanDir, scanText } from '../lib/leak-scan';
import { artifactsDir } from '../lib/env';
import { git } from '../lib/fake-host';
import { sessionOf, startSession, trimId, waitIdle, waitRuns } from '../lib/agents';

const DUMMY = `e2e-dummy-anthropic-${crypto.randomBytes(9).toString('hex')}`;
const sha16 = (v: string) => crypto.createHash('sha256').update(v).digest('hex').slice(0, 16);
const tmpHosts = () => fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('agora-e2e-ah-')).sort();

let ah: AgentHost;
let stateDirs: string[] = [];

test.describe('agent harness self-test with the fake CLI @agent', () => {
    test.describe.configure({ timeout: 150_000 });
    test.beforeAll(async () => {
        test.setTimeout(150_000);
        ah = await startAgentHost(loadSeed(), {
            label: 'ag-harness', mode: 'fake', dummyKeys: { ANTHROPIC_API_KEY: DUMMY },
            profiles: [{ key: 'hclaude', adapter: 'claude' }, { key: 'hcodex', adapter: 'codex' }],
        });
        stateDirs = Object.values(ah.agents).map(a => a.stateDir);
    });
    test.afterAll(async () => { await ah?.stop(); });

    test('[AG-02.harness-refusal] subscription and siwc profiles are refused before anything is created', async ({ seed }) => {
        const { owner } = apis(seed);
        const hostsBefore = ((await owner.ok('GET', `/servers/${seed.serverId}/agent-hosts`)) as any[]).length;
        const tmpBefore = tmpHosts();
        for (const [adapter, auth] of [['claude', 'subscription'], ['codex', 'siwc'], ['gemini', 'subscription']] as const) {
            const p = startAgentHost(seed, { label: 'ag-refuse', mode: 'fake', profiles: [{ key: 'ok', adapter: 'claude' }, { key: 'bad', adapter, auth }] });
            await expect(p).rejects.toThrow(AgentHostRefusal);
            await expect(p).rejects.toThrow(new RegExp(`refused: profile bad uses auth "${auth}"`));
        }
        expect(((await owner.ok('GET', `/servers/${seed.serverId}/agent-hosts`)) as any[]).length, 'no host registered').toBe(hostsBefore);
        expect(tmpHosts(), 'no temp folder made').toEqual(tmpBefore);
        // The generated config is checked again before it is written
        expect(() => checkHostConfig({ profiles: { x: { auth: 'subscription', apiKeyEnv: undefined, stateDir: os.tmpdir() } } })).toThrow(/uses auth "subscription"/);
        expect(() => checkHostConfig({ profiles: { x: { auth: 'api_key', apiKeyEnv: 'ANTHROPIC_API_KEY', stateDir: path.join(os.homedir(), '.claude') } } })).toThrow(/stateDir points into ~\/\.claude/);
        // A state dir that is not empty is refused
        const dirty = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-e2e-sd-'));
        try {
            expect(() => assertEmptyStateDirs([dirty])).not.toThrow();
            fs.writeFileSync(path.join(dirty, '.credentials.json'), '{}');
            expect(() => assertEmptyStateDirs([dirty])).toThrow(/is not empty/);
        } finally { fs.rmSync(dirty, { recursive: true, force: true }); }
    });

    test('[AG-02.harness-state] fresh per-profile state dirs in a temp folder; the CLI config dir points there; tiny repo with a failing test', async ({ seed }) => {
        const { owner } = apis(seed);
        const home = os.homedir().toLowerCase();
        expect(new Set(stateDirs).size).toBe(stateDirs.length);
        for (const d of stateDirs) {
            expect(fs.statSync(d).isDirectory()).toBe(true);
            expect(path.dirname(d)).toBe(ah.root);
            expect(ah.root.startsWith(fs.realpathSync(os.tmpdir())) || ah.root.startsWith(os.tmpdir())).toBe(true);
            for (const own of ['.claude', '.codex', '.gemini']) expect(d.toLowerCase().startsWith(path.join(home, own))).toBe(false);
        }
        // The workdir: one function with a bug and one failing node --test test, committed on main
        expect(fs.readFileSync(path.join(ah.workdir, 'src', 'sum.js'), 'utf8')).toContain('return a - b;');
        expect(nodeTest(ah.workdir).code, 'the test fails before any agent works').not.toBe(0);
        expect(git(ah.workdir, ['rev-parse', 'refs/heads/main'])).toBe(ah.initialMainSha);
        expect(git(ah.workdir, ['status', '--porcelain'])).toBe('');

        // A run writes its CLI state into its own state dir (CLAUDE_CONFIG_DIR) and works in a worktree under it
        const ch = (await owner.ok('POST', `/servers/${seed.serverId}/channels`, { name: `ag-harness-${ah.tag}`, channelType: 3 }, [201])) as any;
        const chId = trimId(ch.id);
        await owner.ok('POST', `/channels/${chId}/bots/${ah.agents.hclaude.botId}`, undefined, [200, 201]);
        const sid = await startSession(owner, chId, ah.agents.hclaude.name);
        const fakeHostLike = { traces: (k: string) => ah.traces(k) } as any;
        const [t] = await waitRuns(fakeHostLike, 'hclaude', 1);
        await waitIdle(owner, chId, ah.agents.hclaude.name, sid);
        expect(fs.existsSync(path.join(ah.agents.hclaude.stateDir, 'fake-runs.jsonl'))).toBe(true);
        expect(path.resolve(t.cwd).toLowerCase()).toBe(path.resolve(ah.agents.hclaude.worktree(sid)).toLowerCase());
        expect(fs.readdirSync(ah.agents.hcodex.stateDir), 'the other profile\'s state dir is untouched').toEqual([]);
        // The server profile carries the §3.1 caps
        const prof = ((await owner.ok('GET', `/servers/${seed.serverId}/agent-profiles`)) as any[]).find(p => trimId(p.id) === ah.agents.hclaude.profileId);
        expect([prof.wakeBudget, prof.tokenBudget, prof.runTimeoutSec]).toEqual([10, 200_000, 300]);
        const s = await sessionOf(owner, chId, ah.agents.hclaude.name, sid);
        expect(s.authMode).toBe('api_key');

        // Usage ledger: the channel's tokens are recorded; the cap turns into skipped_budget
        const usage = await channelUsage(owner, [chId]);
        expect(usage.tokens).toBeGreaterThan(0);
        const prevCap = process.env.E2E_AGENT_TOKEN_CAP;
        try {
            record({ scenario: 'harness:ledger', mode: 'fake', result: 'passed', ...usage });
            const total = readLedger().total_tokens;
            expect(readLedger().scenarios.find(r => r.scenario === 'harness:ledger')?.tokens).toBe(usage.tokens);
            process.env.E2E_AGENT_TOKEN_CAP = String(total + 1);
            expect(budgetLeft().over).toBe(false);
            process.env.E2E_AGENT_TOKEN_CAP = String(total);
            const b = budgetLeft();
            expect(b.over).toBe(true);
            if (b.over) expect(b.reason).toMatch(/^skipped_budget: /);
        } finally {
            if (prevCap === undefined) delete process.env.E2E_AGENT_TOKEN_CAP; else process.env.E2E_AGENT_TOKEN_CAP = prevCap;
            // Leave only real scenario rows in the ledger
            const l = readLedger();
            l.scenarios = l.scenarios.filter(r => !r.scenario.startsWith('harness:'));
            l.total_tokens = l.scenarios.reduce((n, r) => n + r.tokens, 0);
            fs.writeFileSync(usageFile(), JSON.stringify(l, null, 2));
        }
    });

    test('[SEC-04.agent-key-child-only] the key reaches the host child and its CLI, never the test runner env or the host log', async () => {
        for (const k of PROVIDER_ENVS) expect(process.env[k], `${k} in the test runner`).toBeUndefined();
        expect(ah.childKeyNames).toEqual(['ANTHROPIC_API_KEY']);
        const t = ah.traces('hclaude');
        expect(t.length).toBeGreaterThan(0);
        // The CLI the host started saw exactly the dummy under ANTHROPIC_API_KEY, and no other provider key
        expect(t.at(-1).providerKeys).toEqual({ ANTHROPIC_API_KEY: sha16(DUMMY) });
        expect(ah.log()).not.toContain(DUMMY);
        expect(ah.log()).toMatch(/Profile hclaude-e2e-[0-9a-f]{4}: API key from ANTHROPIC_API_KEY\./);
    });

    test('[SEC-04.agent-leak-scan] a dummy key value planted in a retained file is caught by the end-of-run scan', async ({ seed }) => {
        // Not pattern-shaped: only the exact-value check (the key registered at host start) can catch it
        expect(scanText(`key=${DUMMY}`, [])).toEqual([]);
        const probe = path.join(artifactsDir(), 'harness-leak-probe');
        fs.mkdirSync(probe, { recursive: true });
        try {
            fs.writeFileSync(path.join(probe, 'host-tail.log'), `claim_failed\nANTHROPIC_API_KEY=${DUMMY}\n`);
            fs.writeFileSync(path.join(probe, 'clean.log'), 'claim_failed\nreport_failed\n');
            const hits = scanDir(probe, scanSecrets(seed.secrets as any));
            expect(hits.map(h => [path.basename(h.file), h.kind])).toEqual([['host-tail.log', 'exact-secret']]);
        } finally { fs.rmSync(probe, { recursive: true, force: true }); }
    });

    test('[AG-02.harness-cleanup] stop() kills the host and deletes every state dir and the temp folder', async () => {
        expect(ah.running()).toBe(true);
        await ah.stop();
        expect(ah.running()).toBe(false);
        for (const d of stateDirs) expect(fs.existsSync(d), `${path.basename(d)} deleted`).toBe(false);
        expect(fs.existsSync(ah.root)).toBe(false);
    });
});
