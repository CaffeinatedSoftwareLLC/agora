import type { FastifyInstance, FastifyRequest } from 'fastify';
import { canViewChannel } from '../lib/channel-access';
import { cannotDirect, isServerOwner, stampAuthority } from '../lib/direct-agents';
import { asService } from '../lib/agent-sessions';
import {
    LABEL_PATTERN, LOGIN_PATTERN, MAX_AUTHORS, MAX_POLL_MINUTES, MIN_POLL_MINUTES, autostartOptions, autostartVerdict, queueScan, ruleJson,
} from '../lib/github-rules';
import { CommandError, botInChannel, profileByName } from './agent-commands';

/**
 * Automatic import of GitHub issues (docs/github-issues.md "Automatic import").
 *
 * - Reading the rule: anyone who can see the channel (it holds no secret).
 * - Changing it: the server owner alone. The link uses the owner's own GitHub login, and an
 *   automatic start runs on the owner's account. Directors, members and bots are refused.
 * - Check now: the owner and directors, as listing issues is.
 */

const ID = { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' } as const;

export async function githubAutomationRoutes(app: FastifyInstance) {
    const root = '/channels/:id/github/automation';

    async function denied(request: FastifyRequest, channelId: string, manage: boolean) {
        const db = request.dbClient!;
        if (request.isBot) return { status: 403, body: { error: 'people_only' } };
        if (!(await canViewChannel(db, channelId, request.userId, false)).allowed) return { status: 403, body: { error: 'forbidden' } };
        if (manage && !await stampAuthority(db, channelId, request.userId, false)) return { status: 403, body: await cannotDirect(db, channelId, request.userId) };
        return null;
    }

    const read = (db: any, channelId: string) => db.query(
        `SELECT g.*, p.name AS autostart_profile_name, g.server_id AS sid, s.owner_id FROM channel_github_repos g JOIN servers s ON s.id = g.server_id
         LEFT JOIN agent_profiles p ON p.id = g.autostart_profile_id WHERE g.channel_id = $1`, [channelId]).then((r: any) => r.rows[0]);

    // GET /channels/:id/github/automation → { rule, canConfigure, autostartOptions } | { rule: null } when no repository is linked
    app.get(root, { schema: { params: { type: 'object', properties: { id: ID } } } }, async (request, reply) => {
        const { id: channelId } = request.params as any, db = request.dbClient!;
        const no = await denied(request, channelId, false);
        if (no) return reply.status(no.status).send(no.body);
        const g: any = await asService(db, () => read(db, channelId));
        if (!g) return reply.send({ rule: null, canConfigure: false, autostartOptions: [] });
        const canConfigure = await isServerOwner(db, g.sid.trim(), request.userId!);
        const options = canConfigure ? await asService(db, () => autostartOptions(db, channelId, g.sid.trim(), g.owner_id, g.import_authors)) : [];
        return reply.send({ rule: ruleJson(g), canConfigure, autostartOptions: options });
    });

    // PUT /channels/:id/github/automation → { rule }. The whole rule at once; the owner only.
    app.put(root, {
        schema: {
            params: { type: 'object', properties: { id: ID } },
            body: { type: 'object', additionalProperties: false, required: ['import'], properties: {
                import: { type: 'object', additionalProperties: false, required: ['mode'], properties: {
                    mode: { type: 'string', enum: ['off', 'label', 'all'] }, label: { type: ['string', 'null'], maxLength: 50 },
                } },
                authors: { type: 'array', maxItems: MAX_AUTHORS, items: { type: 'string', pattern: LOGIN_PATTERN } },
                autostart: { type: 'object', additionalProperties: false, properties: {
                    profile: { type: ['string', 'null'], minLength: 1, maxLength: 32 }, confirmOpen: { type: 'boolean' },
                } },
                pollMinutes: { type: 'integer', minimum: MIN_POLL_MINUTES, maximum: MAX_POLL_MINUTES },
                commentOnPickup: { type: 'boolean' },
            } },
        },
    }, async (request, reply) => {
        const { id: channelId } = request.params as any, b = request.body as any, db = request.dbClient!;
        const no = await denied(request, channelId, false);
        if (no) return reply.status(no.status).send(no.body);
        const out = await asService(db, async () => {
            const g = await read(db, channelId);
            if (!g) return { status: 409, body: { error: 'no_repo_linked' } };
            if (!await isServerOwner(db, g.sid.trim(), request.userId!)) return { status: 403, body: { error: 'owner_only' } };
            const mode = b.import.mode as 'off' | 'label' | 'all';
            const label = mode === 'label' ? (b.import.label ?? '').trim() : null;
            if (mode === 'label' && !new RegExp(LABEL_PATTERN).test(label!)) return { status: 400, body: { error: 'invalid_label' } };
            const authors = [...new Set<string>((b.authors ?? g.import_authors).map((a: string) => a.toLowerCase()))];
            const poll = b.pollMinutes ?? g.poll_minutes;
            const pickup = b.commentOnPickup ?? g.comment_on_pickup;
            let profileId: string | null = null, open = false;
            const wanted = b.autostart === undefined ? (g.autostart_profile_name ?? null) : b.autostart.profile ?? null;
            if (wanted && mode !== 'off') {
                let profile;
                try { profile = await profileByName(db, channelId, wanted); await botInChannel(db, profile.bot_id.trim(), channelId); }
                catch (err) { if (err instanceof CommandError) return { status: err.status, body: err.body }; throw err; }
                const verdict = autostartVerdict(profile, g.owner_id, authors);
                if (!verdict.allowed) return { status: 400, body: { error: 'autostart_not_allowed', message: verdict.reason } };
                profileId = profile.id.trim();
                // Every new issue, no author filter, an agent started on its text: strangers' text reaches the agent unread
                open = mode === 'all' && authors.length === 0;
                if (open && b.autostart?.confirmOpen !== true) return { status: 409, body: {
                    error: 'confirmation_required',
                    message: 'This starts an agent on every new issue, whoever opens it. If the repository is public, strangers\' text will reach the agent without anyone reading it first. Confirm to save.',
                } };
            }
            // 'all' takes issues opened after it was switched on; the backlog is never imported
            const sinceReset = mode === 'all' && g.import_mode !== 'all';
            await db.query(
                `UPDATE channel_github_repos SET import_mode = $2::text, import_label = $3, import_authors = $4,
                        import_since = CASE WHEN $2::text <> 'all' THEN NULL WHEN $5 THEN NOW() ELSE import_since END,
                        autostart_profile_id = $6, autostart_open_ack = $7, poll_minutes = $8, comment_on_pickup = $9,
                        rule_updated_by = $10, rule_updated_at = NOW(),
                        last_poll_at = CASE WHEN $2::text = 'off' THEN NULL ELSE last_poll_at END
                 WHERE channel_id = $1`,
                [channelId, mode, label, authors, sinceReset, profileId, open, poll, pickup, request.userId]);
            return { status: 200, body: { rule: ruleJson(await read(db, channelId)) } };
        });
        return reply.status(out.status).send(out.body);
    });

    // POST /channels/:id/github/automation/check → 202 { id, status } | 409 { error }: Check now
    app.post(`${root}/check`, { schema: { params: { type: 'object', properties: { id: ID } } } }, async (request, reply) => {
        const { id: channelId } = request.params as any, db = request.dbClient!;
        const no = await denied(request, channelId, true);
        if (no) return reply.status(no.status).send(no.body);
        const r = await asService(db, () => queueScan(db, channelId, request.userId!));
        if (r.status === 'skipped') return reply.status(409).send({ error: r.reason });
        if (r.status === 'too_soon') return reply.status(429).send({ error: 'too_soon' });
        return reply.status(202).send({ id: r.id, status: r.status });
    });
}
