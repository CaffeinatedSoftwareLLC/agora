/**
 * Seeds the disposable agora-e2e instance through the HTTP API only (never SQL), then logs
 * each seeded user in through the real login page and saves storageState under secrets/.
 *
 * Idempotent per instance: the first run performs instance setup; later runs log in with the
 * instance-lifetime passwords from .env.e2e and create their own run-tagged channels/agents,
 * so runs never share mutable fixtures.
 */
import fs from 'node:fs';
import { chromium, type FullConfig } from '@playwright/test';
import { Api } from './lib/api';
import { artifactsDir, e2eEnv, runId, SECRETS_DIR, SEED_FILE, storageStatePath } from './lib/env';
import { selfTest } from './lib/leak-scan';
import type { Seed } from './lib/seed-types';

const LOREM = [
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
    'Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
    'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.',
    'Duis aute irure dolor in reprehenderit in voluptate velit esse.',
];

async function loginBearer(api: Api, login: string, password: string): Promise<string | null> {
    const r = await api.req('POST', '/auth/login', { login, password });
    return r.status === 200 && r.data?.accessToken ? r.data.accessToken : null;
}

export default async function globalSetup(_config: FullConfig) {
    const env = e2eEnv();
    const run = runId();
    const tag = Math.random().toString(16).slice(2, 6);
    fs.mkdirSync(SECRETS_DIR, { recursive: true });
    fs.mkdirSync(artifactsDir(), { recursive: true });
    if (!selfTest()) throw new Error('leak scanner self-test failed');

    const ownerPassword = env.raw.E2E_OWNER_PASSWORD;
    const memberPassword = env.raw.E2E_MEMBER_PASSWORD;
    if (!ownerPassword || !memberPassword) throw new Error('.env.e2e lacks E2E_*_PASSWORD; recreate it with E2E_FRESH_ENV=1 e2e/up.sh');

    const api = new Api(env.apiURL);
    const health = await api.req('GET', '/health');
    if (health.status !== 200) throw new Error(`e2e API not healthy at ${env.apiURL}; run e2e/up.sh`);

    // ---- instance + owner ----
    const status = (await api.ok('GET', '/instance/status')) as any;
    if (!status.initialized) {
        await api.ok('POST', '/instance/setup', {
            setupToken: env.setupToken,
            username: 'owner-e2e',
            email: 'owner-e2e@example.test',
            password: ownerPassword,
            instanceName: 'Agora E2E',
            registrationPolicy: 'open',
        }, [201]);
    }
    const ownerToken = await loginBearer(api, 'owner-e2e', ownerPassword);
    if (!ownerToken) throw new Error('owner-e2e login failed: instance was set up by someone else? Recreate with down.sh + up.sh');
    const owner = api.with(`Bearer ${ownerToken}`);
    await owner.ok('PATCH', '/admin/instance', { registrationPolicy: 'open' });

    // ---- member ----
    let memberToken = await loginBearer(api, 'member-e2e', memberPassword);
    if (!memberToken) {
        await api.ok('POST', '/auth/register', { username: 'member-e2e', email: 'member-e2e@example.test', password: memberPassword }, [201]);
        memberToken = await loginBearer(api, 'member-e2e', memberPassword);
        if (!memberToken) throw new Error('member-e2e login failed after register');
    }
    const member = api.with(`Bearer ${memberToken}`);
    const ownerSession = (await owner.ok('GET', '/auth/session')) as any;
    const memberSession = (await member.ok('GET', '/auth/session')) as any;

    // ---- server + channels ----
    const serverId: string = ((await api.ok('GET', '/instance/status')) as any).instanceServerId.trim();
    const chans = (await owner.ok('GET', `/servers/${serverId}/channels`)) as any[];
    const general = chans.find(c => c.name === 'general')?.id?.trim();
    if (!general) throw new Error('no #general channel');
    const mk = async (name: string) => ((await owner.ok('POST', `/servers/${serverId}/channels`, { name, channelType: 3 }, [201])) as any).id.trim();
    const channels = {
        general,
        agents: await mk(`agents-${tag}`),
        notices: await mk(`notices-${tag}`),
        history: await mk(`history-${tag}`),
    };

    // ---- agent host + profiles (no host process runs; the harness reports auth modes itself) ----
    const host = (await owner.ok('POST', `/servers/${serverId}/agent-hosts`, { name: `e2e-host-${tag}` }, [201])) as any;
    const hostId: string = host.host.id.trim();
    const hostToken: string = host.token;
    const mkAgent = async (name: string, adapter: 'claude' | 'codex') => {
        const r = (await owner.ok('POST', `/servers/${serverId}/agents`, {
            name, adapter, hostId, workdirAlias: 'e2e', channelId: channels.agents,
        }, [201])) as any;
        return { profileId: r.profile.id.trim(), botId: r.bot.id.trim(), name, token: r.token as string };
    };
    const claude = await mkAgent(`claude-e2e-${tag}`, 'claude');
    const codexKey = await mkAgent(`codex-key-${tag}`, 'codex');
    const codexSub = await mkAgent(`codex-sub-${tag}`, 'codex');
    const codexPlan = await mkAgent(`codex-plan-${tag}`, 'codex');
    const hostApi = api.with(`AgentHost ${hostToken}`);
    await hostApi.ok('POST', '/agent-hosts/@me/profiles', {
        profiles: [
            { name: claude.name, adapter: 'claude', authMode: 'api_key', apiKeyEnv: 'ANTHROPIC_API_KEY', runApproval: false },
            { name: codexKey.name, adapter: 'codex', authMode: 'api_key', apiKeyEnv: 'OPENAI_API_KEY', runApproval: false },
            { name: codexSub.name, adapter: 'codex', authMode: 'subscription', runApproval: false },
            { name: codexPlan.name, adapter: 'codex', authMode: 'siwc', runApproval: false },
        ],
    });
    for (const ch of [channels.general, channels.notices]) {
        await owner.ok('POST', `/channels/${ch}/bots/${claude.botId}`, undefined, [200, 201]);
    }
    await owner.ok('POST', `/channels/${channels.notices}/bots/${codexSub.botId}`, undefined, [200, 201]);

    // ---- seed messages (fake text only) ----
    for (let i = 0; i < LOREM.length; i++) {
        await (i % 2 ? member : owner).ok('POST', `/channels/${channels.agents}/messages`, { content: LOREM[i] }, [201]);
    }
    for (let i = 1; i <= 120; i++) {
        await owner.ok('POST', `/channels/${channels.history}/messages`, { content: `History ${String(i).padStart(3, '0')}: ${LOREM[i % 4]}` }, [201]);
    }
    // Four consecutive plain system notices: start / end / start fresh / end on a subscription
    // profile (owner may direct it; no host needs to run for the notices to be posted).
    for (const body of [
        { command: 'start', profile: codexSub.name },
        { command: 'end', profile: codexSub.name },
        { command: 'start', profile: codexSub.name, fresh: true },
        { command: 'end', profile: codexSub.name },
    ]) {
        await owner.ok('POST', `/channels/${channels.notices}/agent-commands`, body, [200, 201, 202]);
    }

    const seed: Seed = {
        runTag: tag,
        serverId,
        channels,
        users: {
            owner: { id: ownerSession.user.id.trim(), username: 'owner-e2e', email: 'owner-e2e@example.test' },
            member: { id: memberSession.user.id.trim(), username: 'member-e2e', email: 'member-e2e@example.test' },
        },
        hostId,
        agents: {
            claude: { profileId: claude.profileId, botId: claude.botId, name: claude.name },
            codexKey: { profileId: codexKey.profileId, botId: codexKey.botId, name: codexKey.name },
            codexSub: { profileId: codexSub.profileId, botId: codexSub.botId, name: codexSub.name },
            codexPlan: { profileId: codexPlan.profileId, botId: codexPlan.botId, name: codexPlan.name },
        },
        secrets: { ownerPassword, memberPassword, ownerToken, memberToken, botToken: claude.token, hostToken },
    };
    fs.writeFileSync(SEED_FILE, JSON.stringify(seed, null, 2), { mode: 0o600 });

    // ---- storageState via the real login page ----
    const browser = await chromium.launch();
    try {
        for (const [user, password] of [['owner', ownerPassword], ['member', memberPassword]] as const) {
            const ctx = await browser.newContext({ baseURL: env.baseURL });
            const page = await ctx.newPage();
            await page.goto('/login');
            await page.getByLabel('Username or email').fill(`${user}-e2e`);
            await page.getByLabel('Password').fill(password);
            await page.getByRole('button', { name: 'Sign in', exact: true }).click();
            await page.waitForURL(/\/app/, { timeout: 20_000 });
            await page.getByPlaceholder(/^Message #/).waitFor({ timeout: 20_000 });
            await ctx.storageState({ path: storageStatePath(user) });
            await ctx.close();
        }
    } finally {
        await browser.close();
    }

    fs.writeFileSync(`${artifactsDir()}/run.json`, JSON.stringify({
        run_id: run, base_url: env.baseURL, compose_project: 'agora-e2e', run_tag: tag, started_at: new Date().toISOString(),
    }, null, 2));
}
