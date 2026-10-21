/**
 * Agent E2E with REAL CLIs (beta-test-plan §3.3, scenarios A1–A22) through a real agora-host
 * (lib/agent-host.ts) against the disposable e2e instance. Tagged @agent, never @smoke.
 *
 * Gate: runs only with E2E_AGENT_LIVE=1, all three AGORA_TEST_*_KEY values (environment or
 * ~/.agora-test/keys.env) and E2E_MODEL_CLAUDE/CODEX/GEMINI; otherwise every test is skipped
 * as `blocked`. E2E_AGENT_FAKE=1 runs the same spec against the fake CLI instead (no provider,
 * no spend): scenarios the fake can't perform are skipped with that reason.
 *
 * Assertions (§3.2) are structural, through the API with the owner's token: who posted where,
 * which run, changed paths, git refs in the host's worktrees, `node --test` in the worktree.
 * Model wording is matched with a loose regex at most.
 *
 * Cost (§3.1): every scenario's tokens (its channels' sessions) go to
 * artifacts/<run>/agent-usage.json; once the total reaches E2E_AGENT_TOKEN_CAP (default
 * 1,500,000) the remaining scenarios are skipped as `skipped_budget`.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { test, expect, apis, loadSeed } from '../lib/fixtures';
import { agentMode, nodeTest, startAgentHost, type AgentHost } from '../lib/agent-host';
import { ask, botPostsAfter, expectNoRun, latestRunId, liveChannel, post, startAgent, waitRunAfter, type Flow } from '../lib/agent-flow';
import { budgetLeft, channelUsage, record } from '../lib/agent-usage';
import { ensureDirector, messages, replies, sessionOf, sessions, trimId, type Director } from '../lib/agents';
import { git, waitFor } from '../lib/fake-host';
import { textPng } from '../lib/png';

const M = agentMode();
const FAKE = M.mode === 'fake';
const NOT_IN_FAKE = 'not_applicable: the fake CLI cannot do this (E2E_AGENT_FAKE=1); runs live only';
const PREVIEW_BASE = 47420;

let ah: AgentHost;
let dir: Director;
let f: Flow;
/** Every scenario channel, for the A21 rate-limit sweep. */
const allChannels: string[] = [];

function scenarioOf(title: string) { return /\[([^\]]+)\]/.exec(title)?.[1] ?? title; }
const name = (k: string) => ah.agents[k].name;
const bot = (k: string) => ah.agents[k].botId;

function serve(port: number, html: string) {
    const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); });
    return new Promise<{ close: () => Promise<void> }>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve({ close: () => new Promise(r => server.close(() => r())) }));
    });
}

test.describe('agent E2E with real CLIs @agent', () => {
    test.skip(M.mode === null, M.mode === null ? M.reason : '');
    test.describe.configure({ timeout: FAKE ? 240_000 : 1_200_000 });

    test.beforeAll(async () => {
        test.setTimeout(180_000);
        const seed = loadSeed();
        dir = await ensureDirector(seed);
        ah = await startAgentHost(seed, {
            label: 'ag-live', mode: M.mode!,
            profiles: [
                { key: 'claude', adapter: 'claude', verifyCommands: ['node --test'],
                    allowedTools: ['mcp__agora__subtask_start', 'mcp__agora__handoff_offer', 'mcp__agora__handoff_accept'] },
                { key: 'claudero', adapter: 'claude', toolPresets: ['readonly'] },
                { key: 'codex', adapter: 'codex', allowedTools: ['mcp__agora__handoff_accept', 'mcp__agora__handoff_offer'] },
                { key: 'codexro', adapter: 'codex', toolPresets: ['readonly'] },
                { key: 'gemini', adapter: 'gemini' },
            ],
            preview: { browser: chromium.executablePath(), portBase: PREVIEW_BASE, portsPerSession: 2 },
        });
        f = { ah, seed, owner: apis(seed).owner, fake: FAKE, runWait: FAKE ? 90_000 : 360_000, channels: [] };
    });
    test.afterAll(async () => { await ah?.stop(); });

    test.beforeEach(async ({}, ti) => {
        if (!f) return;
        f.channels = [];
        const b = budgetLeft();
        if (b.over) {
            record({ scenario: scenarioOf(ti.title), mode: M.mode!, result: 'skipped_budget', tokens: 0, wakes: 0, sessions: [], note: b.reason });
            ti.skip(true, b.reason);
        }
    });
    test.afterEach(async ({}, ti) => {
        if (!f) return;
        allChannels.push(...f.channels);
        if (ti.status === 'skipped' && !f.channels.length) return;
        const usage = await channelUsage(f.owner, f.channels);
        const note = ti.annotations.filter(a => a.type === 'outcome').map(a => a.description).join('; ') || undefined;
        record({ scenario: scenarioOf(ti.title), mode: M.mode!, result: ti.status ?? 'unknown', ...usage, note });
    });

    test('[AG-02.A1-hello] /start claude: it posts in the channel, session live, tokens > 0', async () => {
        const ch = await liveChannel(f, 'a1-hello', ['claude']);
        const { sid, hello } = await startAgent(f, ch.id, 'claude');
        expect(trimId(hello.authorId)).toBe(bot('claude'));
        const s = await sessionOf(f.owner, ch.id, name('claude'), sid);
        expect(s.state).toBe('live');
        expect(s.run.status).toBe('succeeded');
        expect(s.tokensUsed, 'usage reported').toBeGreaterThan(0);
        expect(s.authMode).toBe('api_key');
    });

    test('[AG-03.A2-codex-gemini] /start codex and gemini: each posts; gemini runs over ACP with the API-key method', async ({}, ti) => {
        for (const k of ['codex', 'gemini']) {
            const ch = await liveChannel(f, `a2-${k}`, [k]);
            const { sid, hello } = await startAgent(f, ch.id, k);
            expect(trimId(hello.authorId)).toBe(bot(k));
            const s = await sessionOf(f.owner, ch.id, name(k), sid);
            expect([s.state, s.run.status, s.authMode]).toEqual(['live', 'succeeded', 'api_key']);
        }
        if (FAKE) { ti.annotations.push({ type: 'outcome', description: 'fake mode: ACP not exercised (every fake profile is claude stream-json)' }); return; }
        // The host verified the gemini profile over ACP (agora-host index.ts) and the config
        // only allows gemini with protocol "acp"; Gemini records the auth method it was given
        expect(ah.log()).toMatch(/Verified gemini over ACP \(/);
        const g = ah.agents.gemini.stateDir;
        const settings: string[] = [];
        const walk = (d: string, depth: number) => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                const p = path.join(d, e.name);
                if (e.isDirectory() && depth < 3 && !/^wt-/.test(e.name)) walk(p, depth + 1);
                else if (e.isFile() && e.name === 'settings.json') settings.push(fs.readFileSync(p, 'utf8'));
            }
        };
        walk(g, 0);
        expect.soft(settings.join('\n'), 'gemini recorded the gemini-api-key auth method in its own home').toMatch(/gemini-api-key/);
    });

    test('[AG-07.A3-fix-test] "make npm test pass": src/sum.js changed, bot commit on its branch, node --test passes there, main untouched', async () => {
        const ch = await liveChannel(f, 'a3-fix', ['claude']);
        const { sid } = await startAgent(f, ch.id, 'claude');
        const { session: s } = await ask(f, ch.id, 'claude', sid,
            `@${name('claude')} \`npm test\` fails in this repository. Fix the bug in src/sum.js so that \`node --test\` passes. Do not change the test. Reply with one short sentence when done.`,
            { fakeDirectives: '#fake-edit=src/sum.js' });
        expect(s.run.status).toBe('succeeded');
        expect(s.run.changedPaths).toContain('src/sum.js');
        const branch = `agora/${name('claude')}/${sid}`;
        expect(s.branch).toBe(branch);
        const author = git(ah.workdir, ['log', '-1', '--format=%an|%ae', `refs/heads/${branch}`]);
        expect(author, 'the host committed the turn as the bot').toBe(`${name('claude')}|${bot('claude')}@agora.invalid`);
        expect(git(ah.workdir, ['diff', '--name-only', `${ah.initialMainSha}..refs/heads/${branch}`]).split('\n')).toContain('src/sum.js');
        expect(git(ah.workdir, ['rev-parse', 'refs/heads/main']), 'main untouched').toBe(ah.initialMainSha);
        const wt = ah.agents.claude.worktree(sid);
        if (!FAKE) {
            const t = nodeTest(wt);
            expect(t.code, `node --test in the worktree:\n${t.out}`).toBe(0);
            expect(git(wt, ['diff', '--name-only', `${ah.initialMainSha}`, '--', 'test']), 'the test file is unchanged').toBe('');
        }
        expect(nodeTest(ah.workdir).code, 'main checkout still fails').not.toBe(0);
    });

    test('[AG-02.A4-native-resume] a second mention resumes the same native session', async ({}, ti) => {
        const ch = await liveChannel(f, 'a4-resume', ['claude']);
        const { sid } = await startAgent(f, ch.id, 'claude');
        const sessionFiles = () => {
            const out: string[] = [];
            const proj = path.join(ah.agents.claude.stateDir, 'projects');
            if (!fs.existsSync(proj)) return out;
            for (const d of fs.readdirSync(proj)) for (const x of fs.readdirSync(path.join(proj, d))) if (x.endsWith('.jsonl')) out.push(`${d}/${x}`);
            return out.sort();
        };
        const first = await ask(f, ch.id, 'claude', sid, `@${name('claude')} remember the code word PAPAYA-7. Reply "noted".`);
        expect(first.session.run.status).toBe('succeeded');
        const before = FAKE ? [] : sessionFiles();
        const second = await ask(f, ch.id, 'claude', sid, `@${name('claude')} what was the code word I gave you earlier? Reply with just the word.`);
        expect(second.session.run.status).toBe('succeeded');
        if (FAKE) {
            // hello (fresh, native id X), then --resume X twice
            const t = ah.traces('claude').filter(x => x.sessionId === sid);
            expect(t.map(x => !!x.resume)).toEqual([false, true, true]);
            expect(t[2].resume, 'the same native id resumed').toBe(t[1].resume);
            return;
        }
        const after = sessionFiles();
        const fresh = after.filter(x => !before.includes(x));
        ti.annotations.push({ type: 'outcome', description: `native session files before=${before.length} after=${after.length} new=${fresh.length}` });
        expect(fresh, 'no new Claude conversation was started (the earlier one was resumed)').toEqual([]);
        expect(second.posts.length).toBeGreaterThan(0);
        expect.soft(second.posts.map(p => p.content).join('\n'), 'the reply refers to the earlier turn').toMatch(/papaya/i);
    });

    test('[AG-01.A5-thread-mention] owner replies in a thread started by codex with @Claude-E2E: claude answers in that thread', async () => {
        const ch = await liveChannel(f, 'a5-thread', ['claude', 'codex']);
        const { sid } = await startAgent(f, ch.id, 'claude');
        const root = await post(f, ch.id, 'Codex notes: sum() in src/sum.js subtracts instead of adding, so test/sum.test.js fails.', { as: ah.agents.codex.bot });
        const tid = trimId(root.id);
        const mixed = name('claude').replace(/^claude/, 'Claude').replace('-e2e-', '-E2E-');
        const { posts } = await ask(f, ch.id, 'claude', sid, `@${mixed} summarise this thread in one sentence.`, { thread: tid });
        expect(posts.length, 'a reply from claude inside the thread').toBeGreaterThan(0);
        const inChannel = (await messages(f.owner, ch.id)).filter(m => trimId(m.authorId) === bot('claude') && trimId(m.id) > tid && !m.threadId);
        expect.soft(inChannel, 'nothing posted at channel level for a thread mention').toEqual([]);
    });

    test('[SEC-01.A6-member-refused] member-e2e mentions claude: no run, no reply', async ({ seed }) => {
        const ch = await liveChannel(f, 'a6-member', ['claude']);
        const { sid } = await startAgent(f, ch.id, 'claude');
        const prev = await latestRunId(f.owner, ch.id, name('claude'), sid);
        const msg = await post(f, ch.id, `@${name('claude')} please delete the README.`, { as: apis(seed).member });
        await expectNoRun(f, ch.id, name('claude'), sid, prev, FAKE ? 10_000 : 20_000);
        expect(await botPostsAfter(f.owner, ch.id, bot('claude'), trimId(msg.id))).toEqual([]);
    });

    test('[SEC-01.A7-director-allowed] a director mentions claude: run and reply', async () => {
        const ch = await liveChannel(f, 'a7-director', ['claude']);
        const { sid } = await startAgent(f, ch.id, 'claude');
        const { session, posts } = await ask(f, ch.id, 'claude', sid, `@${name('claude')} say hello to the director in one short sentence.`, { as: dir.api });
        expect(session.run.status).toBe('succeeded');
        expect(posts.length).toBeGreaterThan(0);
    });

    test('[AG-04.A8-preset-denial] read-only claude asked to edit → tool card → Approve once → the next run edits', async () => {
        const ch = await liveChannel(f, 'a8-readonly', ['claudero']);
        const { sid } = await startAgent(f, ch.id, 'claudero');
        const ask1 = await ask(f, ch.id, 'claudero', sid,
            `@${name('claudero')} add the line "// checked" at the end of src/sum.js using your file edit tool.`, { fakeDirectives: '#fake-deny=node' });
        const rule = FAKE ? /^Bash\(node:\*\)$/ : /^(Edit|Write|MultiEdit)$/;
        const card = await waitFor('tool request card', async () => (await messages(f.owner, ch.id))
            .find(m => m.systemEvent === 'agent_tool_approval' && rule.test(m.systemData?.tool ?? '') && trimId(m.id) > trimId(ask1.msg.id)), 30_000, 1000);
        expect(card.systemData.status).toBe('pending');
        if (!FAKE) expect(ask1.session.run.changedPaths ?? []).not.toContain('src/sum.js');
        const prev = await latestRunId(f.owner, ch.id, name('claudero'), sid);
        await f.owner.ok('POST', `/channels/${ch.id}/agent-tool-requests/${trimId(card.systemData.requestId)}`, { decision: 'once' });
        const s = await waitRunAfter(f, ch.id, name('claudero'), sid, prev, 'retry run after Approve once');
        if (FAKE) {
            const t = ah.traces('claudero').at(-1);
            expect(t.allowed).toContain('Bash(node:*)');
        } else {
            expect(s.run.status).toBe('succeeded');
            expect(s.run.changedPaths, 'the approved retry edited the file').toContain('src/sum.js');
        }
    });

    test('[AG-03.A9-codex-readonly] read-only codex asked to write: a write card or a failed run (best effort, recorded)', async ({}, ti) => {
        test.skip(FAKE, NOT_IN_FAKE);
        const ch = await liveChannel(f, 'a9-codexro', ['codexro']);
        const { sid } = await startAgent(f, ch.id, 'codexro');
        const { msg, session } = await ask(f, ch.id, 'codexro', sid, `@${name('codexro')} create a file NOTES.md containing "hello" in the repository root.`);
        const cards = (await messages(f.owner, ch.id)).filter(m => m.systemEvent === 'agent_tool_approval' && trimId(m.id) > trimId(msg.id));
        const outcome = cards.length ? `card for ${cards.map(c => c.systemData?.tool).join(', ')}` : `no card; run ${session.run.status}${session.run.error ? ` (${session.run.error})` : ''}`;
        ti.annotations.push({ type: 'outcome', description: `A9: ${outcome}; changedPaths=${JSON.stringify(session.run.changedPaths ?? [])}` });
        expect(session.run.changedPaths ?? [], 'the read-only sandbox kept the file out').not.toContain('NOTES.md');
    });

    test('[AG-01.A10-budget-stop] a session budget 5,000 tokens above its use: a long task shelves it for budget', async () => {
        const ch = await liveChannel(f, 'a10-budget', ['claude']);
        const { sid, session } = await startAgent(f, ch.id, 'claude');
        await f.owner.ok('POST', `/channels/${ch.id}/agent-commands`, { command: 'budget', sessionId: sid, tokenBudget: session.tokensUsed + 5000 });
        const { session: s } = await ask(f, ch.id, 'claude', sid,
            `@${name('claude')} read every file in this repository and write a detailed explanation of each one, then post it.`, { fakeDirectives: '#fake-tokens=8000' });
        const shelved = await waitFor('shelved for budget', async () => { const x = await sessionOf(f.owner, ch.id, name('claude'), sid); return x.state === 'shelved' ? x : null; }, 30_000, 1000);
        expect(shelved.endReason).toBe('budget');
        expect(s.tokensUsed).toBeGreaterThanOrEqual(session.tokensUsed);
        const notice = (await messages(f.owner, ch.id)).find(m => /shelved: its budget is used up/.test(m.content ?? ''));
        expect(notice, 'a budget notice in the channel').toBeTruthy();
    });

    test('[AG-01.A11-project-context] pinned instruction BANANA reaches the wake', async () => {
        const ch = await liveChannel(f, 'a11-banana', ['claude']);
        const { sid } = await startAgent(f, ch.id, 'claude');
        await f.owner.ok('PUT', `/channels/${ch.id}/project`, { instructions: 'Always end every message you post with the word BANANA.' });
        const { posts } = await ask(f, ch.id, 'claude', sid, `@${name('claude')} in one sentence, what does src/sum.js export?`);
        if (FAKE) { expect(ah.traces('claude').at(-1).hasInstructions).toBe(true); return; }
        expect(posts.length).toBeGreaterThan(0);
        expect(posts.at(-1).content).toMatch(/banana\W*$/i);
    });

    test('[AG-08.A12-verify] channel verify `node --test` runs after the fix and reports', async () => {
        const ch = await liveChannel(f, 'a12-verify', ['claude']);
        const { sid } = await startAgent(f, ch.id, 'claude');
        await f.owner.ok('PUT', `/channels/${ch.id}/project/verify`, { command: 'node --test', maxRetries: 1 });
        const { msg } = await ask(f, ch.id, 'claude', sid,
            `@${name('claude')} fix the bug in src/sum.js so the test passes. Do not change the test.`, { fakeDirectives: '#fake-edit=src/sum.js' });
        const notice = await waitFor('verify notice', async () => (await messages(f.owner, ch.id))
            .find(m => trimId(m.id) > trimId(msg.id) && /verify `node --test` (passed|failed)/.test(m.content ?? '')), 60_000, 1500);
        if (!FAKE) expect(notice.content).toMatch(/verify `node --test` passed/);
    });

    test('[UI-05.A13-canvas] canvas_publish a Mermaid diagram: artifact kind mermaid, version 1 has content', async () => {
        test.skip(FAKE, NOT_IN_FAKE);
        const ch = await liveChannel(f, 'a13-canvas', ['claude']);
        const { sid } = await startAgent(f, ch.id, 'claude');
        await ask(f, ch.id, 'claude', sid, `@${name('claude')} use the canvas_publish tool to publish a Mermaid diagram (kind "mermaid") of this repository's files.`);
        const list = ((await f.owner.ok('GET', `/channels/${ch.id}/artifacts`)) as any).artifacts as any[];
        const art = list.find(a => a.kind === 'mermaid' && trimId(a.createdBy) === bot('claude'));
        expect(art, 'a mermaid artifact by the bot').toBeTruthy();
        const v1 = (await f.owner.ok('GET', `/channels/${ch.id}/artifacts/${art.id}/versions/1`)) as any;
        expect(v1.content).toMatch(/graph|flowchart/i);
        expect((await messages(f.owner, ch.id)).some(m => trimId(m.authorId) === bot('claude') && m.artifact)).toBe(true);
    });

    test('[AG-08.A14-browser-preview] browser_preview of a page on the session port: screenshot posted by the bot', async () => {
        test.skip(FAKE, NOT_IN_FAKE);
        const ch = await liveChannel(f, 'a14-preview', ['claude']);
        const { sid } = await startAgent(f, ch.id, 'claude');
        // The host allocated this session's ports for the hello run (preview-ports.json in its preview stateDir)
        const table = JSON.parse(fs.readFileSync(path.join(ah.previewStateDir!, 'preview-ports.json'), 'utf8')).sessions;
        const port = PREVIEW_BASE + table[sid].slot * 2;
        const srv = await serve(port, fs.readFileSync(path.join(ah.workdir, 'index.html'), 'utf8'));
        try {
            const { msg } = await ask(f, ch.id, 'claude', sid, `@${name('claude')} the repository's index.html is being served at http://localhost:${port}/ . Use the browser_preview tool on that URL.`);
            const shot = await waitFor('preview post', async () => (await messages(f.owner, ch.id))
                .find(m => trimId(m.authorId) === bot('claude') && trimId(m.id) > trimId(msg.id) && /^Browser preview of http:\/\/(localhost|127\.0\.0\.1):\d+/.test(m.content ?? '')), 60_000, 1500);
            expect(shot.attachments?.length).toBeGreaterThan(0);
        } finally { await srv.close(); }
    });

    test('[UI-03.A15-image-reading] an uploaded PNG reading E2E-42: the reply contains 42', async () => {
        test.skip(FAKE, NOT_IN_FAKE);
        const ch = await liveChannel(f, 'a15-image', ['claude']);
        const { sid } = await startAgent(f, ch.id, 'claude');
        const form = new FormData();
        form.append('channel_id', ch.id);
        form.append('file', new Blob([new Uint8Array(textPng('E2E-42'))], { type: 'image/png' }), 'e2e-number.png');
        const up = await f.owner.req('POST', '/files/upload', form);
        expect(up.status).toBe(201);
        const { posts } = await ask(f, ch.id, 'claude', sid, `@${name('claude')} what number comes after "E2E-" in the attached image? Reply with just the number.`, { attachments: [trimId(up.data.id)] });
        expect(posts.map(p => p.content).join('\n')).toMatch(/\b42\b/);
    });

    test('[AG-08.A16-subtask] subtask_start: child thread with the brief, child shelved done, parent woken with the summary', async () => {
        test.skip(FAKE, NOT_IN_FAKE);
        const ch = await liveChannel(f, 'a16-subtask', ['claude']);
        const { sid } = await startAgent(f, ch.id, 'claude');
        await ask(f, ch.id, 'claude', sid, `@${name('claude')} use subtask_start (parent_session_id = your sessionId) to have a child session add a NOTES.md file with one line describing src/sum.js. Then stop and wait for its summary.`);
        const child = await waitFor('child session done', async () => {
            const c = (await sessions(f.owner, ch.id)).find(s => trimId(s.parentSessionId) === sid);
            return c && c.state === 'shelved' ? c : null;
        }, f.runWait * 2, 3000);
        expect(child.endReason).toBe('done');
        expect(child.threadId, 'the child works in its own thread').toBeTruthy();
        expect((await replies(f.owner, ch.id, child.threadId)).length + 1).toBeGreaterThan(0);
        const parent = await waitFor('parent woken by the summary', async () => {
            const p = await sessionOf(f.owner, ch.id, name('claude'), sid);
            return p.wakesUsed >= 3 && !p.running ? p : null;
        }, f.runWait, 3000);
        expect(parent.wakesUsed).toBeGreaterThanOrEqual(3);
    });

    test('[AG-05.A17-handoff] claude offers a thread to codex; codex accepts; codex owns the thread', async () => {
        test.skip(FAKE, NOT_IN_FAKE);
        const ch = await liveChannel(f, 'a17-handoff', ['claude', 'codex']);
        await startAgent(f, ch.id, 'codex');
        const { sid } = await startAgent(f, ch.id, 'claude');
        const root = await post(f, ch.id, `Task: fix sum() in src/sum.js (${ah.tag}).`);
        const tid = trimId(root.id);
        await ask(f, ch.id, 'claude', sid, `@${name('claude')} do not edit anything. Use handoff_offer to hand this thread to ${name('codex')} with a one-line summary.`, { thread: tid });
        const state = await waitFor('handoff accepted', async () => {
            const h = (await f.owner.ok('GET', `/channels/${ch.id}/threads/${tid}/handoffs`)) as any;
            return h.owner && trimId(h.owner.botId) === bot('codex') ? h : null;
        }, f.runWait * 2, 3000);
        const offer = state.offers.find((o: any) => o.status === 'accepted');
        expect(offer, 'an accepted handoff offer').toBeTruthy();
    });

    test('[AG-05.A18-reservations] claude holds src/sum.js; codex asked to reserve it too: one holder, codex does not edit it', async ({}, ti) => {
        test.skip(FAKE, NOT_IN_FAKE);
        const ch = await liveChannel(f, 'a18-reserve', ['claude', 'codex']);
        const { sid: cs } = await startAgent(f, ch.id, 'claude');
        const { sid: xs } = await startAgent(f, ch.id, 'codex');
        await ask(f, ch.id, 'claude', cs, `@${name('claude')} use file_reserve to reserve src/sum.js for 900 seconds (reason "A18") and keep it. Do not edit anything. Reply "reserved".`);
        const held = (((await f.owner.ok('GET', `/channels/${ch.id}/file-reservations`)) as any).reservations as any[]).filter(r => (r.paths ?? []).includes('src/sum.js'));
        expect(held.map(r => r.holder)).toEqual([name('claude')]);
        const { session, posts } = await ask(f, ch.id, 'codex', xs, `@${name('codex')} use file_reserve to reserve src/sum.js, then fix the bug in it. If someone else holds the reservation, do not edit the file; reply with what happened.`);
        const after = (((await f.owner.ok('GET', `/channels/${ch.id}/file-reservations`)) as any).reservations as any[]).filter(r => (r.paths ?? []).includes('src/sum.js'));
        expect(after.map(r => r.holder), 'still one holder').toEqual([name('claude')]);
        expect(session.run.changedPaths ?? []).not.toContain('src/sum.js');
        ti.annotations.push({ type: 'outcome', description: `codex replied: ${posts.length} post(s)` });
        expect.soft(posts.map(p => p.content).join('\n'), 'codex says it is held').toMatch(/reserv|held|conflict|409/i);
    });

    test('[UI-06.A19-task-board] a card assigned to codex and started: card thread, scoped session, branch and status', async () => {
        const ch = await liveChannel(f, 'a19-task', ['codex']);
        const title = `Fix sum ${ah.tag}`;
        const r = (await f.owner.ok('POST', `/channels/${ch.id}/tasks`, { title, description: 'Fix the bug in src/sum.js so `node --test` passes. Reply in this thread when done.', profile: name('codex'), start: true }, [201])) as any;
        expect(r.action).not.toBe('created');
        const card = await waitFor('card with thread and session', async () => {
            const list = ((await f.owner.ok('GET', `/channels/${ch.id}/tasks`)) as any).cards as any[];
            const c = list.find(x => x.title === title);
            return c?.threadId && c?.session ? c : null;
        }, 30_000, 1000);
        expect(card.status).toBe('in_progress');
        const tid = trimId(card.threadId);
        const s = await waitRunAfter(f, ch.id, name('codex'), trimId(card.session.id), null, 'task run');
        expect(s.threadId).toBe(tid);
        const reply = await waitFor('codex reply in the card thread', async () => (await replies(f.owner, ch.id, tid)).find(m => trimId(m.authorId) === bot('codex')), 30_000, 1000);
        expect(reply).toBeTruthy();
        const after = await waitFor('card branch', async () => {
            const c = (((await f.owner.ok('GET', `/channels/${ch.id}/tasks`)) as any).cards as any[]).find(x => x.title === title);
            return c?.session?.branch ? c : null;
        }, 30_000, 1000);
        expect(after.session.branch).toBe(`agora/${name('codex')}/${trimId(card.session.id)}`);
    });

    test('[AG-01.A20-lurk] /lurk quiet: a wrong claim gets at most one correction, a harmless post gets [pass]', async ({ seed }) => {
        const member = apis(seed).member;
        const ch = await liveChannel(f, 'a20-lurk', ['claude']);
        const { sid } = await startAgent(f, ch.id, 'claude');
        await f.owner.ok('POST', `/channels/${ch.id}/agent-commands`, { command: 'lurk', profile: name('claude'), lurkMode: 'quiet' });
        expect((await sessionOf(f.owner, ch.id, name('claude'), sid)).lurkMode).toBe('quiet');
        let prev = await latestRunId(f.owner, ch.id, name('claude'), sid);
        const wrong = await post(f, ch.id, 'FYI: sum(2, 3) in src/sum.js already returns 5, so the test in this repo passes.', { as: member });
        let s = await waitRunAfter(f, ch.id, name('claude'), sid, prev, 'lurk run on the wrong claim');
        expect(s.run.status).toBe('succeeded');
        const corrections = await botPostsAfter(f.owner, ch.id, bot('claude'), trimId(wrong.id));
        expect(corrections.length, 'at most one correction').toBeLessThanOrEqual(1);
        prev = s.run.id;
        const harmless = await post(f, ch.id, 'Lunch is at noon today.', { as: member });
        s = await waitRunAfter(f, ch.id, name('claude'), sid, prev, 'lurk run on the harmless post');
        expect(s.run.status).toBe('succeeded');
        await new Promise(r => setTimeout(r, 3000));
        expect(await botPostsAfter(f.owner, ch.id, bot('claude'), trimId(harmless.id)), 'the harmless post got [pass]').toEqual([]);
    });

    test('[OP-03.A21-rate-limit] opportunistic: a session that hit a provider rate limit sleeps with a reset time', async ({}, ti) => {
        const sleeping: any[] = [];
        for (const id of new Set(allChannels)) for (const s of await sessions(f.owner, id).catch(() => [] as any[])) if (s.sleepingUntil) sleeping.push(s);
        test.skip(!sleeping.length, 'not_applicable: opportunistic, no test key hit a rate limit in this run');
        ti.annotations.push({ type: 'outcome', description: `${sleeping.length} session(s) slept for a rate limit` });
        for (const s of sleeping) expect(Date.parse(s.sleepingUntil)).toBeGreaterThan(Date.parse(s.lastActiveAt ?? 0));
    });

    test('[AG-09.A22-terminal] terminal session + one responder (manual)', async () => {
        test.skip(true, 'not_applicable: manual step (beta-test-plan §3.3 A22: interactive claude with agora-mcp on the owner\'s API-key config)');
    });
});
