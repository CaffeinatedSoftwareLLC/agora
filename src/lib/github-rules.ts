import { generateUlid } from '../utils/ulid';
import { postNotice, type Notice } from './agent-runs';
import { cardUpdate } from './task-cards';
import { issueDescription, issueUrlOk, type ListedIssue } from './github-issues';
import { wakeAuthMode } from './provider-terms';
import { sanitizeMessageText } from './sanitize-text';
import { CommandError } from '../routes/agent-commands';
import { cleanTitle, startCard } from '../routes/task-board';

/**
 * GitHub issue automation (docs/github-issues.md "Automatic import"). The owner sets a rule on
 * the channel's linked repository: which issues become task cards, and, separately, whether an
 * agent starts on each card. Polling, not webhooks: a worker (src/workers/github-poll.ts) or
 * Check now queues an `issue_scan` that the owner's host answers with `gh`; the answer is applied
 * here, in the transaction that records it. Agora holds no GitHub token and every setting is off
 * until the owner turns it on.
 */

export const DEFAULT_POLL_MINUTES = 5;
/** Protects GitHub's rate limit and the host: one scan is one `gh issue list` plus up to WATCH_LIMIT `gh issue view`. */
export const MIN_POLL_MINUTES = 2;
export const MAX_POLL_MINUTES = 1440;
/** Open issues one scan looks at (the newest). More than this and the check says so. */
export const SCAN_LIMIT = 200;
/** Cards whose issue state one scan re-reads, to notice an issue closed on GitHub. */
export const WATCH_LIMIT = 10;
/** A scan nobody claimed in this long is dropped: the host is offline. */
export const SCAN_QUEUE_MINUTES = 10;
/** A host that polled this recently counts as online. */
const HOST_FRESH_SECONDS = 180;
/** The one thing Agora ever writes on an issue because of a rule. */
export const PICKUP_COMMENT = 'Picked up in Agora';

export const LABEL_PATTERN = '^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,49}$';
export const LOGIN_PATTERN = '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$';
export const MAX_AUTHORS = 50;
export const validLabel = (s: unknown): s is string => typeof s === 'string' && new RegExp(LABEL_PATTERN).test(s);
export const validLogin = (s: unknown): s is string => typeof s === 'string' && new RegExp(LOGIN_PATTERN).test(s);

export interface ScannedIssue extends ListedIssue { createdAt: string }

/** What a failed scan says in the channel, once per code. Anything else gets the generic line. */
const SCAN_FAILURES: Record<string, string> = {
    gh_not_installed: 'the GitHub CLI (gh) is not installed on the host. Install it there.',
    gh_not_signed_in: 'gh is not signed in on the host. Run gh auth login there.',
    repo_not_found: "the host's gh can't find the repository. Check the name and that its login can see it.",
};
/** Failures that are the host's or the network's: shown in the rule's status, not worth a notice each. */
const QUIET = new Set(['host_offline', 'host_timeout', 'binding_changed', 'rule_off']);

export function ruleJson(g: any) {
    return {
        import: { mode: g.import_mode as 'off' | 'label' | 'all', label: g.import_label ?? null },
        authors: (g.import_authors ?? []) as string[],
        importSince: g.import_since ?? null,
        autostart: { profileId: g.autostart_profile_id?.trim() ?? null, profile: g.autostart_profile_name ?? null, confirmedOpen: !!g.autostart_open_ack },
        pollMinutes: g.poll_minutes as number,
        commentOnPickup: !!g.comment_on_pickup,
        status: { lastPolledAt: g.last_poll_at ?? null, lastCheckedAt: g.last_checked_at ?? null, result: g.last_check_status ?? null,
            found: g.last_check_found ?? null, created: g.last_check_created ?? null },
        limits: { defaultPollMinutes: DEFAULT_POLL_MINUTES, minPollMinutes: MIN_POLL_MINUTES, maxPollMinutes: MAX_POLL_MINUTES, scanLimit: SCAN_LIMIT },
    };
}

/**
 * Whether the rule may start this profile on a card. An API-key agent in a box may: whoever is
 * allowed to open an issue is not the account holder. An agent on a personal login (a subscription,
 * or any host-mode agent) or on a ChatGPT plan runs on the owner's own account; the owner's rule
 * counts as the owner starting it, but only while strangers' text cannot reach it unread, so it
 * needs the author filter. A plan that is not the owner's is never started by the rule.
 */
export function autostartVerdict(profile: { auth_mode?: string | null; host_mode?: boolean | null; plan_owner_id?: string | null },
    ownerId: string, authors: string[]): { allowed: boolean; planOwned: boolean; reason: string | null } {
    const mode = wakeAuthMode(profile);
    if (mode === 'api_key') return { allowed: true, planOwned: false, reason: null };
    if (mode === 'siwc' && profile.plan_owner_id?.trim() !== ownerId.trim())
        return { allowed: false, planOwned: true, reason: "This agent runs on someone else's ChatGPT plan, and only they can start it." };
    if (!authors.length)
        return { allowed: false, planOwned: true, reason: 'This agent runs on a personal login. Set "Only issues opened by these GitHub users" first, so nobody else\'s text reaches it.' };
    return { allowed: true, planOwned: true, reason: null };
}

/** Profiles of the channel's server that the rule could start (their bot has access to the channel). */
export async function autostartOptions(db: any, channelId: string, serverId: string, ownerId: string, authors: string[]) {
    const rows = (await db.query(
        `SELECT p.name, p.auth_mode, p.host_mode, p.plan_owner_id FROM agent_profiles p
         JOIN bot_channel_access a ON a.bot_id = p.bot_id AND a.channel_id = $2 WHERE p.server_id = $1 ORDER BY p.name`, [serverId, channelId])).rows;
    return rows.map((p: any) => {
        const v = autostartVerdict(p, ownerId, authors);
        return { name: p.name, planOwned: v.planOwned, allowed: v.allowed, reason: v.reason };
    });
}

// ─── Queueing a scan ───

/** Every scan the host has not claimed in SCAN_QUEUE_MINUTES is dropped: the host is offline. */
async function expireQueuedScans(db: any, channelId: string): Promise<void> {
    await db.query(
        `UPDATE github_commands SET status = 'failed', result = '{"error":"host_offline"}', finished_at = NOW()
         WHERE channel_id = $1 AND action = 'issue_scan' AND status = 'queued' AND created_at < NOW() - make_interval(mins => $2)`,
        [channelId, SCAN_QUEUE_MINUTES]);
}

export type QueueResult = { status: 'queued' | 'pending'; id: string } | { status: 'skipped'; reason: string } | { status: 'too_soon' };

/**
 * Queue a scan for the channel unless one is waiting. A host that is revoked, offline or too old
 * to know the command is not asked: the reason is recorded in the rule's status and nothing else
 * happens (no notice). Runs in the caller's transaction.
 */
export async function queueScan(db: any, channelId: string, requestedBy: string | null): Promise<QueueResult> {
    const g = (await db.query(
        `SELECT g.*, h.revoked_at, h.last_seen_at > NOW() - make_interval(secs => $2) AS seen, h.github_scan_seen_at > NOW() - make_interval(secs => $2) AS scan_ready,
                g.last_poll_at > NOW() - interval '10 seconds' AS recent
         FROM channel_github_repos g JOIN agent_hosts h ON h.id = g.host_id WHERE g.channel_id = $1 FOR UPDATE OF g`, [channelId, HOST_FRESH_SECONDS])).rows[0];
    if (!g || g.import_mode === 'off') return { status: 'skipped', reason: 'rule_off' };
    await expireQueuedScans(db, channelId);
    const pending = (await db.query(
        `SELECT btrim(id) AS id FROM github_commands WHERE channel_id = $1 AND action = 'issue_scan' AND status IN ('queued', 'claimed') ORDER BY id DESC LIMIT 1`, [channelId])).rows[0];
    if (pending) return { status: 'pending', id: pending.id };
    const reason = g.revoked_at ? 'host_revoked' : g.scan_ready ? null : g.seen ? 'host_old' : 'host_offline';
    if (reason) {
        await db.query('UPDATE channel_github_repos SET last_poll_at = NOW(), last_check_status = $2 WHERE channel_id = $1', [channelId, reason]);
        return { status: 'skipped', reason };
    }
    if (requestedBy && g.recent) return { status: 'too_soon' };
    // Cards whose issue state is re-read: the open ones not read for longest (an issue closed on GitHub)
    const watch = (await db.query(
        `SELECT issue_number FROM task_cards WHERE channel_id = $1 AND lower(issue_repo) = lower($2) AND status <> 'done'
         ORDER BY issue_state_checked_at NULLS FIRST, id LIMIT $3`, [channelId, g.repo, WATCH_LIMIT])).rows.map((r: any) => Number(r.issue_number));
    const id = generateUlid();
    await db.query(
        `INSERT INTO github_commands (id, server_id, channel_id, host_id, requested_by, action, repo, payload)
         VALUES ($1, $2, $3, $4, $5, 'issue_scan', $6, $7)`,
        [id, g.server_id, channelId, g.host_id, requestedBy, g.repo,
         { mode: g.import_mode, ...(g.import_mode === 'label' ? { label: g.import_label } : {}), limit: SCAN_LIMIT, watch }]);
    await db.query('UPDATE channel_github_repos SET last_poll_at = NOW() WHERE channel_id = $1', [channelId]);
    return { status: 'queued', id };
}

// ─── Applying a scan's answer ───

/** Comments that the rule makes on an issue: fixed text, queued like any other GitHub call. */
async function queuePickupComment(db: any, g: any, number: number): Promise<void> {
    await db.query(
        `INSERT INTO github_commands (id, server_id, channel_id, host_id, requested_by, action, repo, payload)
         VALUES ($1, $2, $3, $4, NULL, 'issue_comment', $5, $6)`,
        [generateUlid(), g.server_id, g.channel_id, g.host_id, g.repo, { number, body: PICKUP_COMMENT, pickup: true }]);
}

/** The scan failed (the host's error code) or was dropped. One notice per code until a scan works. */
export async function scanFailed(db: any, cmd: any, error: string, notices: Notice[]): Promise<void> {
    const g = (await db.query('SELECT * FROM channel_github_repos WHERE channel_id = $1 FOR UPDATE', [cmd.channel_id])).rows[0];
    if (!g || g.repo.toLowerCase() !== cmd.repo.toLowerCase() || g.host_id.trim() !== cmd.host_id.trim()) return;
    const code = error.slice(0, 40);
    const say = !QUIET.has(code) && g.last_notice_code !== code;
    await db.query(
        `UPDATE channel_github_repos SET last_checked_at = NOW(), last_check_status = $2, last_check_found = NULL, last_check_created = NULL,
                last_notice_code = CASE WHEN $3 THEN $2 ELSE last_notice_code END WHERE channel_id = $1`, [g.channel_id, code, say]);
    if (say) notices.push(await postNotice(db, g.channel_id.trim(),
        `GitHub automation for ${g.repo} can't check for issues: ${SCAN_FAILURES[code] ?? `the host's gh failed (${code}). Check the host log.`} This is said once; the rule's status in the task board shows the latest result.`));
}

/** The author filter and the 'all' cut-off. The label was applied by `gh`. */
function matches(g: any, issue: ScannedIssue): boolean {
    if (g.import_authors.length && !g.import_authors.includes(issue.author.toLowerCase())) return false;
    if (g.import_mode === 'all') {
        const opened = Date.parse(issue.createdAt);
        if (!g.import_since || !Number.isFinite(opened) || opened <= Date.parse(g.import_since)) return false;
    }
    return true;
}

/**
 * A scan finished: make a card for each matching issue that has never been a card in this
 * channel, start the chosen agent on it if the rule says so, and note issues closed on GitHub.
 * Runs in the host-result request's transaction, with the link row locked, so two answers can't
 * both make a card; the github_issue_imports primary key is the backstop.
 */
export async function applyScan(db: any, cmd: any, result: { issues: ScannedIssue[]; watched: Array<{ number: number; closed: boolean }>; truncated: boolean }, notices: Notice[]): Promise<{ found: number; created: number }> {
    const g = (await db.query(
        `SELECT g.*, s.owner_id, u.username AS owner_name FROM channel_github_repos g JOIN servers s ON s.id = g.server_id JOIN users u ON u.id = s.owner_id
         WHERE g.channel_id = $1 FOR UPDATE OF g`, [cmd.channel_id])).rows[0];
    // The link moved or the rule was switched off while the host worked: the answer is dropped
    if (!g || g.repo.toLowerCase() !== cmd.repo.toLowerCase() || g.host_id.trim() !== cmd.host_id.trim()) return { found: 0, created: 0 };
    const channelId = g.channel_id.trim(), ownerId = g.owner_id.trim();
    let created = 0, found = 0;

    if (g.import_mode !== 'off') {
        const profile = g.autostart_profile_id
            ? (await db.query('SELECT * FROM agent_profiles WHERE id = $1 FOR SHARE', [g.autostart_profile_id])).rows[0] : null;
        for (const issue of [...result.issues].sort((a, b) => a.number - b.number)) {
            if (!matches(g, issue)) continue;
            found++;
            await db.query('SAVEPOINT gh_rule_card');
            try {
                const first = (await db.query(
                    `INSERT INTO github_issue_imports (channel_id, issue_repo, issue_number, source) VALUES ($1, lower($2), $3, 'rule')
                     ON CONFLICT DO NOTHING RETURNING 1`, [channelId, g.repo, issue.number])).rows.length;
                if (!first) { await db.query('RELEASE SAVEPOINT gh_rule_card'); continue; }
                const cardId = generateUlid();
                const title = cleanTitle(issue.title) || `Issue #${issue.number}`;
                await db.query(
                    `INSERT INTO task_cards (id, server_id, channel_id, title, description, status, profile_id, created_by, issue_repo, issue_number, issue_url, from_rule, issue_state_checked_at)
                     VALUES ($1, $2, $3, $4, $5, 'todo', $6, $7, $8, $9, $10, TRUE, NOW())`,
                    [cardId, g.server_id, channelId, title.slice(0, 200), sanitizeMessageText(issueDescription(issue)), profile?.id ?? null, ownerId,
                     g.repo, issue.number, issueUrlOk(issue.url, issue.number) ? issue.url : null]);
                await db.query('UPDATE github_issue_imports SET card_id = $4 WHERE channel_id = $1 AND issue_repo = lower($2) AND issue_number = $3',
                    [channelId, g.repo, issue.number, cardId]);
                await db.query('RELEASE SAVEPOINT gh_rule_card');
                created++;
                const ref = `${g.repo}#${issue.number}`;
                notices.push(await postNotice(db, channelId, `GitHub issue ${ref} became a task card by this channel's automation rule.`));
                if (profile) await autoStart(db, g, profile, ownerId, cardId, ref, notices);
                if (g.comment_on_pickup) await queuePickupComment(db, g, issue.number);
                const update = await cardUpdate(db, cardId);
                if (update) notices.push(update);
            } catch (err: any) {
                // Someone imported the same issue by hand at the same moment: theirs stands
                await db.query('ROLLBACK TO SAVEPOINT gh_rule_card');
                if (err.code !== '23505') throw err;
            }
        }
    }

    // Issues closed (or reopened) on GitHub while their card is open: a note on the card
    for (const w of result.watched) {
        const changed = (await db.query(
            `UPDATE task_cards SET issue_state_checked_at = NOW(), issue_closed_at = CASE WHEN $4 THEN COALESCE(issue_closed_at, NOW()) ELSE NULL END
             WHERE channel_id = $1 AND lower(issue_repo) = lower($2) AND issue_number = $3 RETURNING id`,
            [channelId, g.repo, w.number, w.closed])).rows;
        for (const row of changed) { const update = await cardUpdate(db, row.id.trim()); if (update) notices.push(update); }
    }

    await db.query(
        `UPDATE channel_github_repos SET last_checked_at = NOW(), last_check_status = $2, last_check_found = $3, last_check_created = $4, last_notice_code = NULL
         WHERE channel_id = $1`, [channelId, result.truncated ? 'truncated' : 'ok', found, created]);
    return { found, created };
}

/**
 * Start the rule's agent on a card the rule just made, through the path a person's Start uses
 * (startCard), with the server owner as the one who started it: the owner set the rule, so for
 * the subscription terms (docs/provider-terms.md) it is the owner's own automation on the owner's
 * own account. A profile the rule may not start (see autostartVerdict) is not started, and the
 * channel is told why; the card stays on the board for a person.
 */
async function autoStart(db: any, g: any, profile: any, ownerId: string, cardId: string, ref: string, notices: Notice[]): Promise<void> {
    const channelId = g.channel_id.trim();
    const verdict = autostartVerdict(profile, ownerId, g.import_authors);
    if (!verdict.allowed) {
        notices.push(await postNotice(db, channelId, `Not starting ${profile.name} on ${ref}: ${verdict.reason}`));
        return;
    }
    await db.query('SAVEPOINT gh_rule_start');
    try {
        await startCard(db, channelId, cardId, ownerId, `${g.owner_name}'s GitHub rule`, notices);
        await db.query('RELEASE SAVEPOINT gh_rule_start');
    } catch (err: any) {
        await db.query('ROLLBACK TO SAVEPOINT gh_rule_start');
        if (!(err instanceof CommandError)) throw err;
        const why = err.body?.message ?? err.body?.error ?? 'refused';
        notices.push(await postNotice(db, channelId, `Not starting ${profile.name} on ${ref}: ${why}. The card is on the board; start it there once that is fixed.`));
    }
}
