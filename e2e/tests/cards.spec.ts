/**
 * Approval cards, permission relays, handoffs and file reservations with the fake host
 * (beta-test-plan §2.2). Authority is checked for owner, director (role with DirectAgents) and
 * member; every refusal asserts the HTTP decision and that nothing changed (§0).
 */
import { test, expect, apis, openChannel, storageStateFor, loadSeed } from '../lib/fixtures';
import { snap } from '../lib/snap';
import { startFakeHost, waitFor, type FakeHost } from '../lib/fake-host';
import { agentChannel, ensureDirector, expectNotice, loginContext, messages, replies, sessionOf, startSession, trimId, waitIdle, waitMessage, waitReply, waitRuns, compose, type Director } from '../lib/agents';

let fh: FakeHost;
let dir: Director;

const card = (page: import('@playwright/test').Page, header: string) => page.locator('[data-index]').filter({ hasText: header }).last();

test.describe('agent cards with the fake host', () => {
    test.describe.configure({ timeout: 150_000 });
    test.beforeAll(async () => {
        const seed = loadSeed();
        dir = await ensureDirector(seed);
        fh = await startFakeHost(seed, {
            label: 'fk-cards',
            profiles: [{ key: 'tool' }, { key: 'appr', requireRunApproval: true }, { key: 'relay' }, { key: 'hone' }, { key: 'htwo' }, { key: 'rone' }, { key: 'rtwo' }],
        });
    });
    test.afterAll(async () => { await fh?.stop(); });

    test('[AG-04.tool-card] denial → card; member refused; director Approve once re-wakes with the grant; Always allow is owner only', async ({ page, browser, seed }, ti) => {
        const { owner, member } = apis(seed);
        const a = fh.agents.tool;
        const ch = await agentChannel(seed, fh, 'fk-tool', ['tool']);
        const sid = await startSession(owner, ch.id, a.name);
        await waitRuns(fh, 'tool', 1);
        await waitIdle(owner, ch.id, a.name, sid);
        await openChannel(page, ch.id, ch.name);
        await compose(page, ch.name, `@${a.name} open the PR list #fake-deny=gh`);
        const header = `Tool request from ${a.name}`;
        const c1 = card(page, header);
        await expect(c1).toBeVisible({ timeout: 45_000 });
        await expect(c1).toContainText(`${a.name} was denied Bash(gh:*)`);
        await expect(c1).toContainText('PENDING');
        for (const name of ['Approve once', 'Always allow', 'Deny']) await expect(c1.getByRole('button', { name, exact: true })).toBeVisible();
        await snap(page, ti, 'AG-04.tool-card', '01-card', 'A tool request card with Approve once, Always allow and Deny buttons', { ready: c1.getByRole('button', { name: 'Approve once' }) });
        const cardMsg = await waitMessage(owner, ch.id, m => m.systemEvent === 'agent_tool_approval' && m.systemData?.tool === 'Bash(gh:*)', 'tool card message');
        const requestId = trimId(cardMsg.systemData.requestId);
        expect(cardMsg.systemData.status).toBe('pending');
        const runsAfterDenial = (await waitRuns(fh, 'tool', 2)).length;

        // Member: refused by the server, nothing changes
        const mctx = await browser.newContext({ storageState: storageStateFor('member') });
        const mp = await mctx.newPage();
        await openChannel(mp, ch.id, ch.name);
        const mc = card(mp, header);
        await expect(mc).toBeVisible();
        const mr = await member.req('POST', `/channels/${ch.id}/agent-tool-requests/${requestId}`, { decision: 'once' });
        expect([mr.status, mr.data.error]).toEqual([403, 'cannot_direct']);
        // Plan: a member sees no approval buttons (the server refusal above is the real guard)
        await expect.soft(mc.getByRole('button', { name: /^(Approve once|Always allow|Deny)$/ }), 'member sees no approval buttons').toHaveCount(0);
        if (await mc.getByRole('button', { name: 'Approve once' }).count()) {
            await mc.getByRole('button', { name: 'Approve once' }).click();
            await expect(mc.getByRole('alert')).toHaveText('Only the owner and directors can approve agent tools.');
        }
        await mctx.close();
        expect((await messages(owner, ch.id)).find(m => trimId(m.id) === trimId(cardMsg.id))?.systemData.status).toBe('pending');
        expect(fh.traces('tool')).toHaveLength(runsAfterDenial);

        // Director: Approve once → card decided, notice, the agent re-woken with the rule granted
        const dctx = await loginContext(browser, dir.username, dir.password);
        const dp = await dctx.newPage();
        await openChannel(dp, ch.id, ch.name);
        const dc = card(dp, header);
        await dc.getByRole('button', { name: 'Approve once' }).click();
        await expect(dc).toContainText('APPROVED ONCE');
        await expect(dc).toContainText(`${dir.username} approved Bash(gh:*) for ${a.name} once.`);
        await expectNotice(dp, `${dir.username} approved once \`Bash(gh:*)\` for ${a.name}. Retry the step that needed it.`);
        const t = await waitRuns(fh, 'tool', runsAfterDenial + 1);
        expect(t[runsAfterDenial].allowed, 'the re-wake carries the one-time grant').toContain('Bash(gh:*)');
        await waitMessage(owner, ch.id, m => trimId(m.authorId) === a.botId && m.content === '[fake] running with Bash(gh:*)', 'retry reply');
        await waitIdle(owner, ch.id, a.name, sid);

        // Second denial: Always allow is owner only
        await compose(page, ch.name, `@${a.name} run the tests #fake-deny=npm`);
        const c2msg = await waitMessage(owner, ch.id, m => m.systemEvent === 'agent_tool_approval' && m.systemData?.tool === 'Bash(npm:*)', 'second tool card');
        const req2 = trimId(c2msg.systemData.requestId);
        await waitIdle(owner, ch.id, a.name, sid);
        const runsBeforeAlways = fh.traces('tool').length;
        const dc2 = dp.locator('[data-index]').filter({ hasText: 'was denied Bash(npm:*)' }).last();
        // A director gets Approve once and Deny, never Always allow (#146), and the API refuses it too
        await expect(dc2.getByRole('button', { name: 'Approve once' })).toBeVisible();
        await expect(dc2.getByRole('button', { name: 'Always allow' })).toHaveCount(0);
        const dr = await dir.api.req('POST', `/channels/${ch.id}/agent-tool-requests/${req2}`, { decision: 'always' });
        expect(dr.status).toBe(403);
        const profiles = async () => ((await owner.ok('GET', `/servers/${seed.serverId}/agent-profiles`)) as any[]).find(p => trimId(p.id) === a.profileId);
        expect((await profiles()).allowedTools).not.toContain('Bash(npm:*)');
        expect(fh.traces('tool')).toHaveLength(runsBeforeAlways);
        await dctx.close();

        const oc2 = page.locator('[data-index]').filter({ hasText: 'was denied Bash(npm:*)' }).last();
        await oc2.getByRole('button', { name: 'Always allow' }).click();
        await expect(page.locator('[data-index]').filter({ hasText: `owner-e2e always allowed Bash(npm:*) for ${a.name}.` }).last()).toContainText('ALWAYS ALLOWED');
        expect((await profiles()).allowedTools).toContain('Bash(npm:*)');
        const t2 = await waitRuns(fh, 'tool', runsBeforeAlways + 1);
        expect(t2[runsBeforeAlways].allowed).toContain('Bash(npm:*)');
    });

    test('[AG-04.run-approval] run request card: only the owner\'s Approve run starts the run', async ({ page, browser, seed }, ti) => {
        const { owner, member } = apis(seed);
        const a = fh.agents.appr;
        const ch = await agentChannel(seed, fh, 'fk-appr', ['appr']);
        const sid = await startSession(owner, ch.id, a.name);
        const cardMsg = await waitMessage(owner, ch.id, m => m.systemEvent === 'agent_run_approval', 'run approval card');
        const approvalId = trimId(cardMsg.systemData.approvalId);
        expect(cardMsg.systemData.status).toBe('pending');
        await openChannel(page, ch.id, ch.name);
        const c = card(page, `Run request from ${a.name}`);
        await expect(c).toContainText('PENDING');
        await expect(c.getByRole('button', { name: 'Approve run' })).toBeVisible();
        await snap(page, ti, 'AG-04.run-approval', '01-card', 'A run request card with Approve run and Deny buttons', { ready: c.getByRole('button', { name: 'Approve run' }) });

        // Member and director are refused; no run starts
        const mr = await member.req('POST', `/channels/${ch.id}/agent-run-approvals/${approvalId}`, { decision: 'approve' });
        expect(mr.status).toBe(403);
        const dctx = await loginContext(browser, dir.username, dir.password);
        const dp = await dctx.newPage();
        await openChannel(dp, ch.id, ch.name);
        const dc = card(dp, `Run request from ${a.name}`);
        await dc.getByRole('button', { name: 'Approve run' }).click();
        await expect(dc.getByRole('alert')).toHaveText('Only the server owner can approve agent runs');
        await dctx.close();
        await new Promise(r => setTimeout(r, 4000));
        expect(fh.traces('appr'), 'no run before the owner approves').toHaveLength(0);
        const s0 = await sessionOf(owner, ch.id, a.name, sid);
        expect(s0.recentRuns ?? []).toHaveLength(0);

        await c.getByRole('button', { name: 'Approve run' }).click();
        await expect(c).toContainText('APPROVED');
        await expect(c).toContainText(`owner-e2e approved this run of ${a.name}.`);
        await waitRuns(fh, 'appr', 1);
        await waitMessage(owner, ch.id, m => trimId(m.authorId) === a.botId && /hello from the fake CLI/.test(m.content), 'approved run replies');
        await waitIdle(owner, ch.id, a.name, sid);
        expect(fh.traces('appr')).toHaveLength(1);
    });

    test('[AG-04.permission-relay] a bot\'s permission relay card: only the owner can Allow', async ({ page, browser, seed }, ti) => {
        const { owner, member } = apis(seed);
        const a = fh.agents.relay;
        const ch = await agentChannel(seed, fh, 'fk-relay', ['relay']);
        const relayId = 'e' + Array.from({ length: 4 }, () => 'abcdefghijkmnopqrstuvwxyz'[Math.floor(Math.random() * 25)]).join('');
        const r = (await a.bot.ok('POST', `/channels/${ch.id}/permission-relays`, { relayId, toolName: 'Bash', description: 'Run the unit tests', inputPreview: 'npm test' }, [201])) as any;
        const reqId = trimId(r.id);
        await openChannel(page, ch.id, ch.name);
        const c = card(page, `Permission request from ${a.name}`);
        await expect(c).toContainText('PENDING');
        await expect(c).toContainText('Run the unit tests');
        await snap(page, ti, 'AG-04.permission-relay', '01-card', 'A permission request card showing a tool name and Allow/Deny', { ready: c.getByRole('button', { name: 'Allow' }) });

        const status = async () => ((await a.bot.ok('GET', `/channels/${ch.id}/permission-relays/${reqId}`)) as any).status;
        const mctx = await browser.newContext({ storageState: storageStateFor('member') });
        const mp = await mctx.newPage();
        await openChannel(mp, ch.id, ch.name);
        const mc = card(mp, `Permission request from ${a.name}`);
        await mc.getByRole('button', { name: 'Allow', exact: true }).click();
        await expect(mc.getByRole('alert')).toHaveText('Only the server owner can answer this.');
        await mctx.close();
        const mr = await member.req('POST', `/channels/${ch.id}/permission-relays/${reqId}`, { decision: 'allow' });
        expect([mr.status, mr.data.error]).toEqual([403, 'owner_only']);
        const dr = await dir.api.req('POST', `/channels/${ch.id}/permission-relays/${reqId}`, { decision: 'allow' });
        expect([dr.status, dr.data.error]).toEqual([403, 'owner_only']);
        expect(await status()).toBe('pending');

        await c.getByRole('button', { name: 'Allow', exact: true }).click();
        await expect(c).toContainText('ALLOWED');
        expect(await status()).toBe("allow");
        const again = await owner.req('POST', `/channels/${ch.id}/permission-relays/${reqId}`, { decision: 'deny' });
        expect([again.status, again.data.error]).toEqual([409, 'already_decided']);
        expect(await status()).toBe("allow");
    });

    test('[AG-05.handoff] offer → pending card; accept → owner in the thread header; an expired offer is refused with 410', async ({ page, seed }, ti) => {
        test.setTimeout(200_000);
        const { owner } = apis(seed);
        const [h1, h2] = [fh.agents.hone, fh.agents.htwo];
        const ch = await agentChannel(seed, fh, 'fk-hand', ['hone', 'htwo']);
        const s1 = await startSession(owner, ch.id, h1.name);
        const s2 = await startSession(owner, ch.id, h2.name);
        await waitRuns(fh, 'hone', 1); await waitRuns(fh, 'htwo', 1);
        const w1 = await waitIdle(owner, ch.id, h1.name, s1);
        await waitIdle(owner, ch.id, h2.name, s2);
        const root = (await owner.ok('POST', `/channels/${ch.id}/messages`, { content: `Handoff task ${fh.tag}` }, [201])) as any;
        const tid = trimId(root.id);
        await owner.ok('POST', `/channels/${ch.id}/messages/${tid}/replies`, { content: 'Thread for the handoff.' }, [201]);

        const offer = ((await h1.bot.ok('POST', `/channels/${ch.id}/handoffs`, { threadId: tid, to: h2.name, summary: 'Half done; finish the parser.', ttlSeconds: 600 }, [201])) as any).offer;
        expect(offer.status).toBe('pending');
        expect([offer.branch, offer.headSha]).toEqual([w1.branch, w1.headSha]);
        // Only the named agent can answer
        const human = await owner.req('POST', `/channels/${ch.id}/handoffs/${offer.id}`, { action: 'accept' });
        expect([human.status, human.data.error]).toEqual([403, 'not_recipient']);

        await openChannel(page, ch.id, ch.name);
        const row = page.locator('[data-index]').filter({ hasText: root.content }).first();
        await row.hover();
        await row.getByRole('button', { name: /Reply in thread|\d+ repl/ }).first().click();
        const panel = page.locator('aside[aria-label="thread"]');
        const hc = panel.getByTestId('handoff-card');
        await expect(hc).toContainText(`Handoff: ${h1.name} → ${h2.name}`);
        await expect(hc).toContainText('PENDING');
        await expect(hc).toContainText(`${w1.branch} @ ${w1.headSha.slice(0, 12)}`);
        await expect(panel.getByTestId('thread-owner')).toHaveCount(0);

        const acc = (await h2.bot.ok('POST', `/channels/${ch.id}/handoffs/${offer.id}`, { action: 'accept' })) as any;
        expect(acc.offer.status).toBe('accepted');
        await expect(hc).toContainText('ACCEPTED', { timeout: 15_000 });
        await expect(panel.getByTestId('thread-owner')).toHaveText(new RegExp(`^Owner: ${h2.name}`), { timeout: 15_000 });
        await expectNotice(page, `${h2.name} now owns this (from ${h1.name} @ ${w1.branch}@${w1.headSha.slice(0, 12)}).`, 20_000, panel);
        await snap(page, ti, 'AG-05.handoff', '01-accepted', 'A handoff card marked accepted, with the new owner shown in the thread header', { ready: hc });
        const ownerNow = ((await owner.ok('GET', `/channels/${ch.id}/threads/${tid}/handoffs`)) as any).owner;
        expect(trimId(ownerNow.botId)).toBe(h2.botId);
        // h1 no longer owns the task: it can't offer it again
        const reoffer = await h1.bot.req('POST', `/channels/${ch.id}/handoffs`, { threadId: tid, to: h2.name, summary: 'again' });
        expect([reoffer.status, reoffer.data.error]).toEqual([403, 'not_task_owner']);

        // Expired: a 60 s offer in another thread, answered too late
        const root2 = (await owner.ok('POST', `/channels/${ch.id}/messages`, { content: `Second handoff task ${fh.tag}` }, [201])) as any;
        const tid2 = trimId(root2.id);
        const late = ((await h1.bot.ok('POST', `/channels/${ch.id}/handoffs`, { threadId: tid2, to: h2.name, summary: 'Short offer.', ttlSeconds: 60 }, [201])) as any).offer;
        await new Promise(r => setTimeout(r, Math.max(0, Date.parse(late.expiresAt) - Date.now()) + 2000));
        const tooLate = await h2.bot.req('POST', `/channels/${ch.id}/handoffs/${late.id}`, { action: 'accept' });
        expect([tooLate.status, tooLate.data.error]).toEqual([410, 'offer_expired']);
        const state2 = (await owner.ok('GET', `/channels/${ch.id}/threads/${tid2}/handoffs`)) as any;
        expect(state2.owner).toBeNull();
        expect(state2.offers.find((o: any) => o.id === late.id).status).toBe('expired');
        await page.reload();
        const row2 = page.locator('[data-index]').filter({ hasText: root2.content }).first();
        await row2.hover();
        await row2.getByRole('button', { name: /Reply in thread|\d+ repl/ }).first().click();
        const hc2 = panel.getByTestId('handoff-card');
        await expect(hc2).toContainText('EXPIRED');
        await expect(hc2).toContainText('Expired without an answer.');
        await expect(panel.getByTestId('thread-owner')).toHaveCount(0);
    });

    test('[AG-05.reservations] second reservation of a path gets 409; owner force-release notifies the holder', async ({ page, seed }) => {
        const { owner, member } = apis(seed);
        const [r1, r2] = [fh.agents.rone, fh.agents.rtwo];
        const ch = await agentChannel(seed, fh, 'fk-resv', ['rone', 'rtwo']);
        const s1 = await startSession(owner, ch.id, r1.name);
        const s2 = await startSession(owner, ch.id, r2.name);
        await waitRuns(fh, 'rone', 1); await waitRuns(fh, 'rtwo', 1);
        await waitIdle(owner, ch.id, r1.name, s1); await waitIdle(owner, ch.id, r2.name, s2);
        const path = `src/shared-${fh.tag}.ts`;
        const held = ((await r1.bot.ok('POST', `/channels/${ch.id}/file-reservations`, { action: 'reserve', paths: [path], reason: 'editing' }, [201])) as any).reservation;
        const clash = await r2.bot.req('POST', `/channels/${ch.id}/file-reservations`, { action: 'reserve', paths: [path] });
        expect(clash.status).toBe(409);
        expect(clash.data.error).toBe('reservation_conflict');
        expect([clash.data.holder.profile, trimId(clash.data.holder.reservationId)]).toEqual([r1.name, trimId(held.id)]);
        const list = async () => ((await owner.ok('GET', `/channels/${ch.id}/file-reservations`)) as any).reservations as any[];
        expect((await list()).map(r => [r.holder, r.paths])).toEqual([[r1.name, [path]]]);

        // A member can't force-release; nothing changes
        const mr = await member.req('POST', `/channels/${ch.id}/file-reservations`, { action: 'release', reservationId: held.id, force: true });
        expect(mr.status).toBe(403);
        expect(await list()).toHaveLength(1);

        const runs1 = fh.traces('rone').length;
        const rel = (await owner.ok('POST', `/channels/${ch.id}/file-reservations`, { action: 'release', reservationId: held.id, force: true })) as any;
        expect(rel.released.map(trimId)).toEqual([trimId(held.id)]);
        expect(await list()).toHaveLength(0);
        await openChannel(page, ch.id, ch.name);
        await expectNotice(page, `Reservation ${trimId(held.id)} held by ${r1.name} (session ${s1}) was force-released by a channel owner/director. Paths: "${path}"`);
        // The holder is woken about it
        const t = await waitRuns(fh, 'rone', runs1 + 1);
        expect(t[runs1].batchCount).toBeGreaterThanOrEqual(1);
        const now = await r2.bot.req('POST', `/channels/${ch.id}/file-reservations`, { action: 'reserve', paths: [path] });
        expect(now.status).toBe(201);
    });
});
