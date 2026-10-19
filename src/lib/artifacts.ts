/**
 * Canvas artifacts (docs/canvas-and-preview.md). A message may carry an artifact: an
 * HTML, Markdown, Mermaid or SVG document the UI renders in a sandboxed side pane. A post
 * that names an existing artifact adds a version to it. The tables are written and read
 * as the table owner (asService) after the routes' own channel checks.
 */
import { asService } from './agent-sessions';
import { sanitizeMessageText } from './sanitize-text';
import { generateUlid } from '../utils/ulid';

export const ARTIFACT_KINDS = ['html', 'markdown', 'mermaid', 'svg'] as const;
export type ArtifactKind = typeof ARTIFACT_KINDS[number];
/** Characters per version. Fastify's 1 MiB body limit still applies to the whole post. */
export const MAX_ARTIFACT_CHARS = 200_000;

/** The `artifact` property of a message post. `id` adds a version to an existing artifact. */
export const artifactBodySchema = {
    type: 'object',
    additionalProperties: false,
    required: ['content'],
    properties: {
        id: { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
        title: { type: 'string', minLength: 1, maxLength: 200 },
        kind: { type: 'string', enum: [...ARTIFACT_KINDS] },
        content: { type: 'string', minLength: 1, maxLength: MAX_ARTIFACT_CHARS },
    },
} as const;

export interface ArtifactInput { id?: string; title?: string; kind?: ArtifactKind; content: string }
/** What a message payload carries: enough to draw the card and open the pane. */
export interface ArtifactRef { id: string; version: number; title: string; kind: ArtifactKind; latestVersion: number }

/** Title on one line: a newline would let a title fake extra lines in agent transcripts. */
const cleanTitle = (title: string) => sanitizeMessageText(title).replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 200);

/**
 * Check an artifact post before the message is inserted, so a bad one never posts.
 * Returns an error body, or null when the post may go ahead.
 */
export async function checkArtifact(db: any, channelId: string, input: ArtifactInput): Promise<{ status: number; error: string } | null> {
    if (!sanitizeMessageText(input.content).trim()) return { status: 400, error: 'empty_artifact' };
    if (input.title !== undefined && !cleanTitle(input.title)) return { status: 400, error: 'empty_artifact_title' };
    if (!input.id) return input.title && input.kind ? null : { status: 400, error: 'artifact_title_and_kind_required' };
    const found: any = await asService(db, () => db.query('SELECT 1 FROM artifacts WHERE id = $1 AND channel_id = $2', [input.id, channelId]));
    return found.rows.length ? null : { status: 404, error: 'artifact_not_found' };
}

/** Store the artifact (or its next version) for a message inserted in this transaction. */
export async function attachArtifact(db: any, p: { channelId: string; messageId: string; authorId: string; input: ArtifactInput }): Promise<ArtifactRef> {
    const content = sanitizeMessageText(p.input.content);
    const title = p.input.title !== undefined ? cleanTitle(p.input.title) : undefined;
    return asService(db, async () => {
        let id: string, version: number, kind: ArtifactKind, finalTitle: string;
        if (p.input.id) {
            // Row lock: two concurrent posts get consecutive version numbers
            const a = (await db.query('SELECT id, title, kind, last_version FROM artifacts WHERE id = $1 AND channel_id = $2 FOR UPDATE',
                [p.input.id, p.channelId])).rows[0];
            if (!a) throw Object.assign(new Error('artifact_not_found'), { statusCode: 404 });
            id = a.id.trim(); version = a.last_version + 1; kind = p.input.kind ?? a.kind; finalTitle = title ?? a.title;
            await db.query('UPDATE artifacts SET last_version = $2, title = $3, kind = $4, updated_at = NOW() WHERE id = $1', [id, version, finalTitle, kind]);
        } else {
            id = generateUlid(); version = 1; kind = p.input.kind!; finalTitle = title!;
            await db.query(`INSERT INTO artifacts (id, server_id, channel_id, created_by, title, kind)
                SELECT $1, server_id, id, $3, $4, $5 FROM channels WHERE id = $2`, [id, p.channelId, p.authorId, finalTitle, kind]);
        }
        await db.query(`INSERT INTO artifact_versions (artifact_id, version, message_id, author_id, title, kind, content)
            VALUES ($1, $2, $3, $4, $5, $6, $7)`, [id, version, p.messageId, p.authorId, finalTitle, kind, content]);
        return { id, version, title: finalTitle, kind, latestVersion: version };
    });
}

/** The artifact each of these messages carries, for message lists. */
export async function artifactsForMessages(db: any, messageIds: string[]): Promise<Map<string, ArtifactRef>> {
    const map = new Map<string, ArtifactRef>();
    if (!messageIds.length) return map;
    const rows: any = await asService(db, () => db.query(`SELECT btrim(v.message_id) AS message_id, btrim(v.artifact_id) AS id, v.version, v.title, v.kind,
            (SELECT max(l.version) FROM artifact_versions l WHERE l.artifact_id = v.artifact_id) AS latest_version
            FROM artifact_versions v WHERE v.message_id = ANY($1)`, [messageIds]));
    for (const r of rows.rows) map.set(r.message_id, { id: r.id, version: r.version, title: r.title, kind: r.kind, latestVersion: r.latest_version });
    return map;
}

/** A deleted post takes its version with it; an artifact with no versions left is removed. */
export async function removeArtifactVersion(db: any, messageId: string): Promise<void> {
    await asService(db, async () => {
        const gone = (await db.query('DELETE FROM artifact_versions WHERE message_id = $1 RETURNING artifact_id', [messageId])).rows[0];
        if (!gone) return;
        const last = (await db.query(`SELECT version, title, kind FROM artifact_versions WHERE artifact_id = $1 ORDER BY version DESC LIMIT 1`,
            [gone.artifact_id])).rows[0];
        if (!last) await db.query('DELETE FROM artifacts WHERE id = $1', [gone.artifact_id]);
        else await db.query('UPDATE artifacts SET title = $2, kind = $3, updated_at = NOW() WHERE id = $1', [gone.artifact_id, last.title, last.kind]);
    });
}
