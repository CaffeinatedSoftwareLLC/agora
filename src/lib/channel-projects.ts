import { readFileText, type FileReadDeps } from './file-read';

/**
 * Channel project context and verify before yield (docs/project-context.md).
 *
 * The owner and directors pin instructions and up to MAX_PROJECT_FILES files shared in the
 * channel. Hosted wakes carry them in the claim (agent-runs.ts) and agents read them with
 * agora-mcp's project_context. The server owner may also set a verify command, which the
 * agent host runs in the session worktree after a run that changed files.
 *
 * Both tables have RLS on and no policy: these functions run as the table owner, after the
 * caller's own channel checks (asService on a request connection, or the pool in host routes).
 */

export const MAX_PROJECT_FILES = 10;
export const MAX_INSTRUCTIONS = 8000;
export const MAX_VERIFY_RETRIES = 5;
/** Plain words only: agora-host splits on single spaces and runs it without a shell. */
export const VERIFY_COMMAND_PATTERN = '^[A-Za-z0-9_./:@=+,-]+( [A-Za-z0-9_./:@=+,-]+)*$';
/** Pinned file text carried in a claim: per file, and for all of them together. */
export const DOC_CHARS = 12_000;
export const TOTAL_DOC_CHARS = 30_000;

export interface ProjectFile { id: string; name: string; mime: string; size: number }
export interface Project {
    channelId: string;
    instructions: string;
    version: number;
    files: ProjectFile[];
    verify: { command: string; maxRetries: number } | null;
    updatedAt: string | null;
    updatedBy: string | null;
}

/** The channel's project, or an empty one (version 0) when nothing was ever set. */
export async function readProject(db: any, channelId: string): Promise<Project> {
    const row = (await db.query(
        `SELECT p.instructions, p.version, p.verify_command, p.verify_max_retries, p.updated_at, u.username AS updated_by
         FROM channel_projects p LEFT JOIN users u ON u.id = p.updated_by WHERE p.channel_id = $1`,
        [channelId]
    )).rows[0];
    // Files whose message is gone, or that were deleted or expired, drop out of the list
    const files = await db.query(
        `SELECT f.id, f.filename, COALESCE(f.mime_type, f.content_type, '') AS mime, f.size_bytes
         FROM channel_project_files pf
         JOIN files f ON f.id = pf.file_id
         JOIN messages m ON m.id = f.message_id AND m.deleted_at IS NULL
         WHERE pf.channel_id = $1 AND f.channel_id = $1 AND f.deleted_at IS NULL
           AND (f.expires_at IS NULL OR f.expires_at > NOW())
         ORDER BY pf.position`,
        [channelId]
    );
    return {
        channelId: channelId.trim(),
        instructions: row?.instructions ?? '',
        version: row?.version ?? 0,
        files: files.rows.map((f: any) => ({ id: f.id.trim(), name: f.filename, mime: f.mime.trim(), size: Number(f.size_bytes) })),
        verify: row?.verify_command ? { command: row.verify_command, maxRetries: row.verify_max_retries } : null,
        updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
        updatedBy: row?.updated_by ?? null,
    };
}

/** Which of `fileIds` are live files shared in this channel. */
export async function channelFileIds(db: any, channelId: string, fileIds: string[]): Promise<Set<string>> {
    if (fileIds.length === 0) return new Set();
    const rows = await db.query(
        `SELECT f.id FROM files f JOIN messages m ON m.id = f.message_id AND m.deleted_at IS NULL
         WHERE f.id = ANY($1) AND f.channel_id = $2 AND f.deleted_at IS NULL AND (f.expires_at IS NULL OR f.expires_at > NOW())`,
        [fileIds, channelId]
    );
    return new Set(rows.rows.map((r: any) => r.id.trim()));
}

/** Replace instructions and/or pinned files. Bumps the version. */
export async function saveProject(db: any, channelId: string, serverId: string, userId: string,
                                  change: { instructions?: string; fileIds?: string[] }): Promise<void> {
    await db.query(
        `INSERT INTO channel_projects (channel_id, server_id, instructions, instructions_by, version, updated_by, updated_at)
         VALUES ($1, $2, COALESCE($3, ''), CASE WHEN $3::text IS NULL THEN NULL ELSE $4 END, 1, $4, NOW())
         ON CONFLICT (channel_id) DO UPDATE SET instructions = COALESCE($3, channel_projects.instructions),
             instructions_by = CASE WHEN $3::text IS NULL THEN channel_projects.instructions_by ELSE $4 END,
             version = channel_projects.version + 1, updated_by = $4, updated_at = NOW()`,
        [channelId, serverId, change.instructions ?? null, userId]
    );
    if (change.fileIds) {
        await db.query(`DELETE FROM channel_project_files WHERE channel_id = $1`, [channelId]);
        for (const [position, fileId] of change.fileIds.entries()) {
            await db.query(
                `INSERT INTO channel_project_files (channel_id, file_id, position, pinned_by) VALUES ($1, $2, $3, $4)`,
                [channelId, fileId, position, userId]
            );
        }
    }
}

/** Set or clear the verify command. Doesn't change the version: agents don't see it. */
export async function saveVerify(db: any, channelId: string, serverId: string, userId: string,
                                 command: string | null, maxRetries: number | undefined): Promise<void> {
    await db.query(
        `INSERT INTO channel_projects (channel_id, server_id, verify_command, verify_max_retries, updated_by, updated_at)
         VALUES ($1, $2, $3, COALESCE($4, 2), $5, NOW())
         ON CONFLICT (channel_id) DO UPDATE SET verify_command = $3,
             verify_max_retries = COALESCE($4, channel_projects.verify_max_retries), updated_by = $5, updated_at = NOW()`,
        [channelId, serverId, command, maxRetries ?? null, userId]
    );
}

/**
 * For a subscription profile (docs/provider-terms.md): only what the server owner wrote or
 * pinned. A director may not direct an agent that runs on the owner's personal plan, and
 * instructions in every wake would do exactly that.
 */
export async function ownerAuthoredProject(db: any, channelId: string, project: Project): Promise<Project> {
    const row = (await db.query(
        `SELECT p.instructions_by = s.owner_id AS by_owner, s.owner_id FROM channel_projects p JOIN servers s ON s.id = p.server_id
         WHERE p.channel_id = $1`, [channelId])).rows[0];
    if (!row) return project;
    const pinned = await db.query(`SELECT file_id FROM channel_project_files WHERE channel_id = $1 AND pinned_by = $2`, [channelId, row.owner_id]);
    const ownerFiles = new Set(pinned.rows.map((r: any) => r.file_id.trim()));
    return { ...project, instructions: row.by_owner ? project.instructions : '', files: project.files.filter(f => ownerFiles.has(f.id)) };
}

/** The part of a claim that carries the project (agora-host src/types.ts). */
export interface ClaimProject {
    version: number;
    instructions: string;
    /** The agent has not been given this version yet: a fresh conversation, or it changed. */
    changed: boolean;
    files: ProjectFile[];
    /** Text of the pinned files, only when `changed`; filled in by attachProjectDocs. */
    docs: ClaimDoc[];
}
export interface ClaimDoc { id: string; name: string; text: string; truncated: boolean; error: string | null }

/** null when the channel has no instructions and no pinned files. */
export function claimProject(project: Project, seenVersion: number | null, freshConversation: boolean): ClaimProject | null {
    if (!project.instructions.trim() && project.files.length === 0) return null;
    return {
        version: project.version, instructions: project.instructions, files: project.files, docs: [],
        changed: freshConversation || seenVersion !== project.version,
    };
}

/**
 * Read the pinned files' text for a claim whose project changed, as the agent's own bot would
 * read them (file_read): its channel access is checked first. Runs after the claim's
 * transaction has committed, so a slow store never holds the session lock. A file that can't
 * be read is listed with the reason; it never fails the claim.
 */
export async function attachProjectDocs(deps: FileReadDeps, claim: { project: ClaimProject | null; profile: { botId: string }; session: { channelId: string } }): Promise<void> {
    const project = claim.project;
    if (!project?.changed || project.files.length === 0) return;
    let budget = TOTAL_DOC_CHARS;
    for (const file of project.files) {
        if (budget <= 0) {
            project.docs.push({ id: file.id, name: file.name, text: '', truncated: true, error: 'over the project text limit; read it with file_read' });
            continue;
        }
        const limit = Math.min(DOC_CHARS, budget);
        try {
            const r = await readFileText(deps, { fileId: file.id, userId: claim.profile.botId, isBot: true, channelId: claim.session.channelId, limit });
            if (!r.ok) { project.docs.push({ id: file.id, name: file.name, text: '', truncated: false, error: r.error.slice(0, 200) }); continue; }
            budget -= r.body.text.length;
            project.docs.push({ id: file.id, name: file.name, text: r.body.text, truncated: r.body.hasMore || r.body.truncated, error: null });
        } catch {
            project.docs.push({ id: file.id, name: file.name, text: '', truncated: false, error: 'could not be read' });
        }
    }
}

/** What agora-host's verify step found (agora-host src/verify.ts). */
export interface VerificationReport {
    command: string;
    status: 'passed' | 'failed' | 'skipped';
    /** Follow-up turns the agent was given to fix a failure. */
    attempts: number;
    exitCode?: number | null;
    /** Why it was skipped or ended early: not_allowed, timeout, no_session, fix_turn_failed, spawn_failed, stopped. */
    reason?: string;
    /** The end of the command's output, for a failure. */
    output?: string;
}

export const verificationSchema = {
    type: 'object', additionalProperties: false, required: ['command', 'status', 'attempts'],
    properties: {
        command: { type: 'string', minLength: 1, maxLength: 300, pattern: VERIFY_COMMAND_PATTERN },
        status: { type: 'string', enum: ['passed', 'failed', 'skipped'] },
        attempts: { type: 'integer', minimum: 0, maximum: MAX_VERIFY_RETRIES },
        exitCode: { type: ['integer', 'null'] },
        reason: { type: 'string', pattern: '^[a-z_]{1,40}$' },
        output: { type: 'string', maxLength: 4000 },
    },
} as const;

const REASONS: Record<string, string> = {
    not_allowed: 'it is not in this host\'s verify.commands list (agora-host config)',
    timeout: 'it timed out',
    no_session: 'the CLI gave no session to resume for a fix',
    fix_turn_failed: 'a fix turn did not complete',
    spawn_failed: 'it could not be started',
    stopped: 'the run was stopped first',
};

/** The channel notice for a verify result. */
export function verificationNotice(profileName: string, v: VerificationReport): string {
    const fixes = v.attempts === 1 ? '1 fix turn' : `${v.attempts} fix turns`;
    if (v.status === 'skipped') return `${profileName}: verify \`${v.command}\` did not run: ${REASONS[v.reason ?? ''] ?? v.reason ?? 'skipped'}.`;
    if (v.status === 'passed') return `${profileName}: verify \`${v.command}\` passed${v.attempts ? ` after ${fixes}` : ''}.`;
    const why = v.reason && v.reason !== 'timeout' ? ` (${REASONS[v.reason] ?? v.reason})` : '';
    const exit = v.reason === 'timeout' ? 'timed out' : `exit ${v.exitCode ?? '?'}`;
    // Fence that can't be closed by the output itself
    const output = v.output ? `\n\`\`\`\`\n${v.output.replace(/`{4,}/g, '```')}\n\`\`\`\`` : '';
    return `${profileName}: verify \`${v.command}\` failed (${exit}) after ${fixes}${why}. Last output:${output || ' none'}`;
}
