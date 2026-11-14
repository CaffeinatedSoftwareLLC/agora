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
/** One notice per error code per hour, however often a host flaps between working and failing. */
export const NOTICE_QUIET_MINUTES = 60;
/** Check now: at most this many per channel (anyone), and this many per person (all channels), in an hour. The 10-second gap between two stays. */
export const MANUAL_CHECKS_PER_CHANNEL_HOUR = 12;
export const MANUAL_CHECKS_PER_PERSON_HOUR = 30;
/** The login is refreshed from the host at least this often while the rule is on. */
const LOGIN_REFRESH_HOURS = 24;
export const validLabel = (s: unknown): s is string => typeof s === 'string' && new RegExp(LABEL_PATTERN).test(s);
export const validLogin = (s: unknown): s is string => typeof s === 'string' && new RegExp(LOGIN_PATTERN).test(s);

export interface ScannedIssue extends ListedIssue { createdAt: string; labels?: string[] }

/** What a failed scan says in the channel, once per code. Anything else gets the generic line. */
const SCAN_FAILURES: Record<string, string> = {
    gh_not_installed: 'the GitHub CLI (gh) is not installed on the host. Install it there.',
    gh_not_signed_in: 'gh is not signed in on the host. Run gh auth login there.',
    repo_not_found: "the host's gh can't find the repository. Check the name and that its login can see it.",
};
/** Failures that are the host's or the network's: shown in the rule's status, not worth a notice each. */
const QUIET = new Set(['host_offline', 'host_timeout', 'binding_changed', 'rule_off', 'rule_changed']);

export function ruleJson(g: any) {
    return {
        import: { mode: g.import_mode as 'off' | 'label' | 'all', label: g.import_label ?? null },
        authors: (g.import_authors ?? []) as string[],
        importSince: g.import_since ?? null,
        autostart: { profileId: g.autostart_profile_id?.trim() ?? null, profile: g.autostart_profile_name ?? null, confirmedOpen: !!g.autostart_open_ack,
            maxPerCheck: (g.autostart_max_per_check ?? null) as number | null },
        // What the linked host's gh says it is signed in as; null until the host has answered
        hostLogin: (g.gh_login ?? null) as string | null, hostLoginError: (g.gh_login_error ?? null) as string | null,
        pollMinutes: g.poll_minutes as number,
        commentOnPickup: !!g.comment_on_pickup,
        status: { lastPolledAt: g.last_poll_at ?? null, lastCheckedAt: g.last_checked_at ?? null, result: g.last_check_status ?? null,
            found: g.last_check_found ?? null, created: g.last_check_created ?? null },
        limits: { defaultPollMinutes: DEFAULT_POLL_MINUTES, minPollMinutes: MIN_POLL_MINUTES, maxPollMinutes: MAX_POLL_MINUTES, scanLimit: SCAN_LIMIT },
    };
}

/**
 * What the owner is told, in plain words, before an agent is started by the rule: how many
 * cards and sessions one check can make, who can cause that, and whose money it is. The same
 * facts are in the UI's Automation section and docs/github-issues.md.
 */
export function volumeNotice(mode: 'off' | 'label' | 'all', anyAuthor: boolean): string {
    return 'One check can make up to ' + SCAN_LIMIT + ' task cards and, with an agent chosen, start up to ' + SCAN_LIMIT + ' agent sessions '
        + "(the host runs only as many at once as its concurrency limit allows; the rest wait, they are not cancelled). "
        + (mode === 'all' && anyAuthor ? 'With "every new open issue" on a public repository, anyone can open issues, so anyone can cause this again and again. ' : '')
        + "The agents run on your API key or subscription, and nothing limits that spend until you set a limit: \"Start at most N agents per check\" in this section, "
        + "or Settings > Agents > the agent > Limits (docs/agent-limits.md).";
}

/**
 * Whether the rule may start this profile on a card. An API-key agent in a box may: whoever is
 * allowed to open an issue is not the account holder, and its cost is the key's. An agent on a
 * personal login (a subscription, or any host-mode agent) or on the owner's own ChatGPT plan is
 * the owner's account, and docs/provider-terms.md says other people's messages must never drive
 * it. So the rule may start it only on the owner's own issues: the author list must be exactly
 * the GitHub login the linked host's gh is signed in as. If that login is not known, it is
 * refused. A plan that is not the owner's is never started by the rule.
 */
export function autostartVerdict(profile: { auth_mode?: string | null; host_mode?: boolean | null; plan_owner_id?: string | null },
    ownerId: string, authors: string[], ghLogin?: string | null): { allowed: boolean; planOwned: boolean; never?: boolean; reason: string | null } {
    const mode = wakeAuthMode(profile);
    if (mode === 'api_key') return { allowed: true, planOwned: false, reason: null };
    if (mode === 'siwc' && profile.plan_owner_id?.trim() !== ownerId.trim())
        return { allowed: false, planOwned: true, never: true, reason: "This agent runs on someone else's ChatGPT plan, and only they can start it." };
    const login = ghLogin?.trim().toLowerCase() || null;
    if (!login)
        return { allowed: false, planOwned: true, reason: "This agent runs on a personal login, so the rule may start it only on your own issues. Agora does not yet know which GitHub account the linked host's gh is signed in as. It asks the host when the repository is linked; the host must run an up-to-date agora-host with gh signed in. Try again in a minute." };
    if (authors.length !== 1 || authors[0].toLowerCase() !== login)
        return { allowed: false, planOwned: true, reason: `This agent runs on a personal login, and other people's issues must never drive it. The rule may start it only on your own issues: set "Only issues opened by these GitHub users" to exactly your login on this machine (${login}).` };
    return { allowed: true, planOwned: true, reason: null };
}

/** Profiles of the channel's server that the rule could start (their bot has access to the channel). */
export async function autostartOptions(db: any, channelId: string, serverId: string, ownerId: string, authors: string[], ghLogin: string | null) {
    const rows = (await db.query(
        `SELECT p.name, p.auth_mode, p.host_mode, p.plan_owner_id FROM agent_profiles p
         JOIN bot_channel_access a ON a.bot_id = p.bot_id AND a.channel_id = $2 WHERE p.server_id = $1 ORDER BY p.name`, [serverId, channelId])).rows;
    return rows.map((p: any) => {
        const v = autostartVerdict(p, ownerId, authors, ghLogin);
        return { name: p.name, planOwned: v.planOwned, allowed: v.allowed, never: !!v.never, reason: v.reason };
    });
}

// ─── Queueing a scan ───

/** Every scan or login check the host has not claimed in SCAN_QUEUE_MINUTES is dropped: the host is offline. */
async function expireQueuedScans(db: any, channelId: string): Promise<void> {
    await db.query(
        `UPDATE github_commands SET status = 'failed', result = '{"error":"host_offline"}', finished_at = NOW()
         WHERE channel_id = $1 AND action IN ('issue_scan', 'link_info') AND status = 'queued' AND created_at < NOW() - make_interval(mins => $2)`,
        [channelId, SCAN_QUEUE_MINUTES]);
}

/**
 * Ask the linked host which GitHub login its gh is signed in as, and for the repository's stable
 * id (docs/github-issues.md "Who may start which agent"). Not twice while one waits.
 */
export async function queueLinkInfo(db: any, channelId: string): Promise<void> {
    const g = (await db.query('SELECT * FROM channel_github_repos WHERE channel_id = $1', [channelId])).rows[0];
    if (!g) return;
    const pending = (await db.query(
        `SELECT 1 FROM github_commands WHERE channel_id = $1 AND action = 'link_info' AND status IN ('queued', 'claimed') AND created_at > NOW() - make_interval(mins => $2)`,
        [channelId, SCAN_QUEUE_MINUTES])).rows.length > 0;
    if (pending) return;
    await db.query(
        `INSERT INTO github_commands (id, server_id, channel_id, host_id, requested_by, action, repo, payload) VALUES ($1, $2, $3, $4, NULL, 'link_info', $5, '{}')`,
        [generateUlid(), g.server_id, channelId, g.host_id, g.repo]);
}

export type QueueResult = { status: 'queued' | 'pending'; id: string } | { status: 'skipped'; reason: string } | { status: 'too_soon' }
    | { status: 'too_many'; scope: 'channel' | 'person' };

/**
 * Queue a scan for the channel unless one is waiting. A host that is revoked, offline or too old
 * to know the command is not asked: the reason is recorded in the rule's status and nothing else
 * happens (no notice). Runs in the caller's transaction. The scan carries the rule's version:
 * an answer for an older version is dropped (see applyScan).
 */
export async function queueScan(db: any, channelId: string, requestedBy: string | null): Promise<QueueResult> {
    const g = (await db.query(
        `SELECT g.*, h.revoked_at, h.last_seen_at > NOW() - make_interval(secs => $2) AS seen, h.github_scan_seen_at > NOW() - make_interval(secs => $2) AS scan_ready,
                g.last_poll_at > NOW() - interval '10 seconds' AS recent,
                (g.gh_login_checked_at IS NULL OR g.gh_login_checked_at < NOW() - make_interval(hours => $3)) AS login_stale
         FROM channel_github_repos g JOIN agent_hosts h ON h.id = g.host_id WHERE g.channel_id = $1 FOR UPDATE OF g`, [channelId, HOST_FRESH_SECONDS, LOGIN_REFRESH_HOURS])).rows[0];
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
    if (requestedBy) {
        if (g.recent) return { status: 'too_soon' };
        const n = (await db.query(
            `SELECT count(*) FILTER (WHERE channel_id = $1)::int AS channel, count(*) FILTER (WHERE requested_by = $2)::int AS person
             FROM github_commands WHERE action = 'issue_scan' AND requested_by IS NOT NULL AND created_at > NOW() - interval '1 hour'
               AND (channel_id = $1 OR requested_by = $2)`, [channelId, requestedBy])).rows[0];
        if (n.channel >= MANUAL_CHECKS_PER_CHANNEL_HOUR) return { status: 'too_many', scope: 'channel' };
        if (n.person >= MANUAL_CHECKS_PER_PERSON_HOUR) return { status: 'too_many', scope: 'person' };
    }
    // Cards whose issue state is re-read: the open ones not read for longest (an issue closed on GitHub)
    const watch = (await db.query(
        `SELECT issue_number FROM task_cards WHERE channel_id = $1 AND lower(issue_repo) = lower($2) AND status <> 'done'
         ORDER BY issue_state_checked_at NULLS FIRST, id LIMIT $3`, [channelId, g.repo, WATCH_LIMIT])).rows.map((r: any) => Number(r.issue_number));
    const id = generateUlid();
    await db.query(
        `INSERT INTO github_commands (id, server_id, channel_id, host_id, requested_by, action, repo, payload)
         VALUES ($1, $2, $3, $4, $5, 'issue_scan', $6, $7)`,
        [id, g.server_id, channelId, g.host_id, requestedBy, g.repo,
         { mode: g.import_mode, ...(g.import_mode === 'label' ? { label: g.import_label } : {}), limit: SCAN_LIMIT, watch, ruleVersion: g.rule_version }]);
    await db.query('UPDATE channel_github_repos SET last_poll_at = NOW() WHERE channel_id = $1', [channelId]);
    if (g.login_stale) await queueLinkInfo(db, channelId);
    return { status: 'queued', id };
}

// ─── The host's gh login and the repository's id ───

const NODE_ID = /^[A-Za-z0-9_=-]{4,100}$/;

/**
 * The host answered `link_info`: store the login its gh is signed in as (it decides which issues
 * may start a personal-login agent) and the repository's stable id. When the id is the one the
 * previous link had, the repository was renamed: its import records and cards follow the new
 * name, so turning the rule back on makes no duplicates. The rule itself stays off after a relink.
 */
export async function applyLinkInfo(db: any, cmd: any, result: { login?: unknown; repoId?: unknown }): Promise<void> {
    const g = (await db.query('SELECT * FROM channel_github_repos WHERE channel_id = $1 FOR UPDATE', [cmd.channel_id])).rows[0];
    if (!g || g.repo.toLowerCase() !== cmd.repo.toLowerCase() || g.host_id.trim() !== cmd.host_id.trim()) return;
    const login = validLogin(result.login) ? result.login : null;
    const repoId = typeof result.repoId === 'string' && NODE_ID.test(result.repoId) ? result.repoId : null;
    await db.query(
        `UPDATE channel_github_repos SET gh_login = $2, gh_login_checked_at = NOW(), gh_login_error = $3, repo_node_id = COALESCE($4, repo_node_id) WHERE channel_id = $1`,
        [g.channel_id, login, login ? null : 'no_login', repoId]);
    if (g.prev_repo) {
        const channelId = g.channel_id.trim();
        if (repoId && g.prev_repo_node_id === repoId && g.prev_repo.toLowerCase() !== g.repo.toLowerCase()) {
            await db.query(
                `UPDATE github_issue_imports i SET issue_repo = lower($3) WHERE i.channel_id = $1 AND i.issue_repo = lower($2)
                   AND NOT EXISTS (SELECT 1 FROM github_issue_imports j WHERE j.channel_id = i.channel_id AND j.issue_repo = lower($3) AND j.issue_number = i.issue_number)`,
                [channelId, g.prev_repo, g.repo]);
            await db.query(`UPDATE task_cards SET issue_repo = $3 WHERE channel_id = $1 AND lower(issue_repo) = lower($2)`, [channelId, g.prev_repo, g.repo]);
        }
        await db.query('UPDATE channel_github_repos SET prev_repo = NULL, prev_repo_node_id = NULL WHERE channel_id = $1', [channelId]);
    }
}

/** The login check failed. A gh that is gone or signed out means the login is no longer known; a busy host leaves it as it was. */
export async function linkInfoFailed(db: any, cmd: any, error: string): Promise<void> {
    const code = error.slice(0, 40);
    const forget = code === 'gh_not_signed_in' || code === 'gh_not_installed';
    await db.query(
        `UPDATE channel_github_repos SET gh_login_error = $2, gh_login = CASE WHEN $3 THEN NULL ELSE gh_login END, gh_login_checked_at = CASE WHEN $3 THEN NULL ELSE gh_login_checked_at END
         WHERE channel_id = $1 AND lower(repo) = lower($4) AND host_id = $5`, [cmd.channel_id, code, forget, cmd.repo, cmd.host_id]);
}

// ─── Applying a scan's answer ───

/** Comments that the rule makes on an issue: fixed text, queued like any other GitHub call. */
async function queuePickupComment(db: any, g: any, number: number): Promise<void> {
    await db.query(
        `INSERT INTO github_commands (id, server_id, channel_id, host_id, requested_by, action, repo, payload)
         VALUES ($1, $2, $3, $4, NULL, 'issue_comment', $5, $6)`,
        [generateUlid(), g.server_id, g.channel_id, g.host_id, g.repo, { number, body: PICKUP_COMMENT, pickup: true }]);
}

/**
 * The scan failed (the host's error code) or was dropped. One notice per code per hour, however
 * often the host flaps between working and failing; the rule's status always shows the latest.
 */
export async function scanFailed(db: any, cmd: any, error: string, notices: Notice[]): Promise<void> {
    const g = (await db.query('SELECT * FROM channel_github_repos WHERE channel_id = $1 FOR UPDATE', [cmd.channel_id])).rows[0];
    if (!g || g.repo.toLowerCase() !== cmd.repo.toLowerCase() || g.host_id.trim() !== cmd.host_id.trim()) return;
    const code = error.slice(0, 40);
    const now = Date.now(), quiet = NOTICE_QUIET_MINUTES * 60_000;
    const log: Record<string, string> = {};
    for (const [k, v] of Object.entries(g.notice_log ?? {})) if (now - Date.parse(String(v)) < quiet) log[k] = String(v);
    const say = !QUIET.has(code) && !log[code];
    if (say) log[code] = new Date(now).toISOString();
    await db.query(
        `UPDATE channel_github_repos SET last_checked_at = NOW(), last_check_status = $2, last_check_found = NULL, last_check_created = NULL, notice_log = $3 WHERE channel_id = $1`,
        [g.channel_id, code, JSON.stringify(log)]);
    if (say) notices.push(await postNotice(db, g.channel_id.trim(),
        `GitHub automation for ${g.repo} can't check for issues: ${SCAN_FAILURES[code] ?? `the host's gh failed (${code}). Check the host log.`} This is said once an hour at most; the rule's status in the task board shows the latest result.`));
}

/**
 * The author filter, the 'all' cut-off and, for a label rule, the label itself: the host's answer
 * must show the label on the issue (the `gh` call asked for it, but an answer is not trusted to
 * match the rule it was asked under).
 */
export function matches(g: any, issue: ScannedIssue): boolean {
    if (g.import_authors.length && !g.import_authors.includes(issue.author.toLowerCase())) return false;
    if (g.import_mode === 'label') {
        const want = String(g.import_label ?? '').toLowerCase();
        if (!want || !Array.isArray(issue.labels) || !issue.labels.some(l => typeof l === 'string' && l.toLowerCase() === want)) return false;
    }
    if (g.import_mode === 'all') {
        const opened = Date.parse(issue.createdAt);
        if (!g.import_since || !Number.isFinite(opened) || opened <= Date.parse(g.import_since)) return false;
    }
    return true;
}

/** Run `fn` in its own savepoint. A failure undoes only its own writes and is returned, not thrown, so one bad step cannot fail the scan. */
async function attempt<T>(db: any, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; err: any }> {
    await db.query('SAVEPOINT gh_rule_step');
    try {
        const value = await fn();
        await db.query('RELEASE SAVEPOINT gh_rule_step');
        return { ok: true, value };
    } catch (err) {
        await db.query('ROLLBACK TO SAVEPOINT gh_rule_step');
        await db.query('RELEASE SAVEPOINT gh_rule_step');
        return { ok: false, err };
    }
}

/**
 * A scan finished: make a card for each matching issue that has never been a card in this
 * channel, start the chosen agent on it if the rule says so, and note issues closed on GitHub.
 * Runs in the host-result request's transaction, with the link row locked, so two answers can't
 * both make a card; the github_issue_imports primary key is the backstop.
 *
 * An answer is applied only if the rule is the one the scan was queued under (same version): a
 * save while the host worked drops it. Each step for an issue (the card, the start, the pickup
 * comment) runs in its own savepoint, so a failure in one undoes only that step and never fails
 * the host's result. Starts that did not happen are said once per scan, with a count.
 */
export async function applyScan(db: any, cmd: any, result: { issues: ScannedIssue[]; watched: Array<{ number: number; closed: boolean }>; truncated: boolean }, notices: Notice[]): Promise<{ found: number; created: number }> {
    const g = (await db.query(
        `SELECT g.*, s.owner_id, u.username AS owner_name FROM channel_github_repos g JOIN servers s ON s.id = g.server_id JOIN users u ON u.id = s.owner_id
         WHERE g.channel_id = $1 FOR UPDATE OF g`, [cmd.channel_id])).rows[0];
    // The link moved or the rule was changed or switched off while the host worked: the answer is dropped
    if (!g || g.repo.toLowerCase() !== cmd.repo.toLowerCase() || g.host_id.trim() !== cmd.host_id.trim()) return { found: 0, created: 0 };
    if (cmd.payload?.ruleVersion !== g.rule_version) return { found: 0, created: 0 };
    const channelId = g.channel_id.trim(), ownerId = g.owner_id.trim();
    let created = 0, found = 0, started = 0, commentFailures = 0, failedCards = 0;
    const skipped = new Map<string, number>();
    const cap: number | null = g.autostart_max_per_check ?? null;
    let profileName = '';

    if (g.import_mode !== 'off') {
        const profile = g.autostart_profile_id
            ? (await db.query('SELECT * FROM agent_profiles WHERE id = $1 FOR SHARE', [g.autostart_profile_id])).rows[0] : null;
        profileName = profile?.name ?? '';
        for (const issue of [...result.issues].sort((a, b) => a.number - b.number)) {
            if (!matches(g, issue)) continue;
            found++;
            const made = await attempt(db, async () => {
                const first = (await db.query(
                    `INSERT INTO github_issue_imports (channel_id, issue_repo, issue_number, source) VALUES ($1, lower($2), $3, 'rule')
                     ON CONFLICT DO NOTHING RETURNING 1`, [channelId, g.repo, issue.number])).rows.length;
                if (!first) return null;
                const cardId = generateUlid();
                const title = cleanTitle(issue.title) || `Issue #${issue.number}`;
                await db.query(
                    `INSERT INTO task_cards (id, server_id, channel_id, title, description, status, profile_id, created_by, issue_repo, issue_number, issue_url, from_rule, issue_state_checked_at)
                     VALUES ($1, $2, $3, $4, $5, 'todo', $6, $7, $8, $9, $10, TRUE, NOW())`,
                    [cardId, g.server_id, channelId, title.slice(0, 200), sanitizeMessageText(issueDescription(issue)), profile?.id ?? null, ownerId,
                     g.repo, issue.number, issueUrlOk(issue.url, issue.number) ? issue.url : null]);
                await db.query('UPDATE github_issue_imports SET card_id = $4 WHERE channel_id = $1 AND issue_repo = lower($2) AND issue_number = $3',
                    [channelId, g.repo, issue.number, cardId]);
                return cardId;
            });
            // Someone imported the same issue by hand at the same moment: theirs stands. Any other failure: nothing was made, the next check tries again
            if (!made.ok) { if (made.err?.code !== '23505') failedCards++; continue; }
            if (made.value === null) continue;
            const cardId: string = made.value;
            created++;
            const ref = `${g.repo}#${issue.number}`;

            const told = await attempt(db, async () => postNotice(db, channelId, `GitHub issue ${ref} became a task card by this channel's automation rule.`));
            if (told.ok) notices.push(told.value);

            let note: string | null = null;
            if (profile) {
                if (cap !== null && started >= cap) note = `Not started: the limit of ${cap} agents per check was reached. Start it from here.`;
                else {
                    const local: Notice[] = [];
                    const r = await attempt(db, () => autoStart(db, g, profile, ownerId, cardId, local));
                    if (!r.ok) note = 'Not started: an error stopped it. Start it from here.';
                    else if (r.value) note = r.value;
                    else { started++; notices.push(...local); }
                }
                if (note) {
                    skipped.set(note, (skipped.get(note) ?? 0) + 1);
                    await attempt(db, () => db.query('UPDATE task_cards SET rule_note = $2 WHERE id = $1', [cardId, note!.slice(0, 600)]));
                }
            }
            if (g.comment_on_pickup && !(await attempt(db, () => queuePickupComment(db, g, issue.number))).ok) commentFailures++;
            const update = await attempt(db, () => cardUpdate(db, cardId));
            if (update.ok && update.value) notices.push(update.value);
        }

        // One notice per scan, whatever the count
        const parts: string[] = [];
        const notStarted = [...skipped.values()].reduce((a, b) => a + b, 0);
        if (notStarted) parts.push(`${profileName} was not started on ${notStarted} of ${created} new card${created === 1 ? '' : 's'}: `
            + `${[...skipped].map(([why, n]) => `${n} (${why.replace(/^Not started: /, '').replace(/ Start it from here( once that is fixed)?\.$/, '').replace(/\.$/, '')})`).join('; ')}. The cards are on the board; start them there.`);
        if (commentFailures) parts.push(`The "${PICKUP_COMMENT}" comment could not be queued on ${commentFailures} issue${commentFailures === 1 ? '' : 's'}.`);
        if (failedCards) parts.push(`${failedCards} issue${failedCards === 1 ? '' : 's'} could not be turned into a card; the next check tries again.`);
        if (parts.length) {
            const summary = await attempt(db, () => postNotice(db, channelId, `GitHub automation for ${g.repo}: ${parts.join(' ')}`));
            if (summary.ok) notices.push(summary.value);
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
        `UPDATE channel_github_repos SET last_checked_at = NOW(), last_check_status = $2, last_check_found = $3, last_check_created = $4 WHERE channel_id = $1`,
        [channelId, result.truncated ? 'truncated' : 'ok', found, created]);
    return { found, created };
}

/**
 * Start the rule's agent on a card the rule just made, through the path a person's Start uses
 * (startCard), with the server owner as the one who started it: the owner set the rule, so for
 * the subscription terms (docs/provider-terms.md) it is the owner's own automation on the owner's
 * own account, which is why a personal-login agent is started only on the owner's own issues (see
 * autostartVerdict, checked again here at every start). Returns null when started, else the reason
 * it was not; the card stays on the board for a person.
 */
async function autoStart(db: any, g: any, profile: any, ownerId: string, cardId: string, notices: Notice[]): Promise<string | null> {
    const verdict = autostartVerdict(profile, ownerId, g.import_authors, g.gh_login);
    if (!verdict.allowed) return `Not started: ${verdict.reason}`;
    await db.query('SAVEPOINT gh_rule_start');
    try {
        await startCard(db, g.channel_id.trim(), cardId, ownerId, `${g.owner_name}'s GitHub rule`, notices);
        await db.query('RELEASE SAVEPOINT gh_rule_start');
        return null;
    } catch (err: any) {
        await db.query('ROLLBACK TO SAVEPOINT gh_rule_start');
        await db.query('RELEASE SAVEPOINT gh_rule_start');
        if (!(err instanceof CommandError)) throw err;
        return `Not started: ${err.body?.message ?? err.body?.error ?? 'refused'}. Start it from here once that is fixed.`;
    }
}
