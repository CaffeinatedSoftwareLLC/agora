import type { FastifyInstance } from 'fastify';
import { asService } from '../lib/agent-sessions';
import { canViewChannel } from '../lib/channel-access';

const ID = { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' } as const;
const params = (extra: object = {}) => ({ type: 'object', properties: { id: ID, artifactId: ID, ...extra } });

/** Canvas artifacts in a channel (src/lib/artifacts.ts). Posting one goes through the message routes. */
export async function artifactRoutes(app: FastifyInstance) {
    // GET /channels/:id/artifacts?limit → most recently updated first, without content
    app.get('/channels/:id/artifacts', { schema: { params: params(), querystring: {
        type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } },
    } } }, async (request, reply) => {
        const { id } = request.params as any, q = request.query as any, db = request.dbClient!;
        if (!(await canViewChannel(db, id, request.userId, !!request.isBot)).allowed) return reply.status(403).send({ error: 'forbidden' });
        const rows = await asService(db, () => db.query(`SELECT btrim(a.id) AS id, a.title, a.kind, a.updated_at AS "updatedAt", a.created_at AS "createdAt",
                btrim(a.created_by) AS "createdBy", u.username AS "createdByUsername",
                (SELECT max(v.version) FROM artifact_versions v WHERE v.artifact_id = a.id) AS "latestVersion"
            FROM artifacts a LEFT JOIN users u ON u.id = a.created_by
            WHERE a.channel_id = $1 ORDER BY a.updated_at DESC, a.id DESC LIMIT $2`, [id, q.limit ?? 25]));
        return { artifacts: rows.rows };
    });

    // GET /channels/:id/artifacts/:artifactId → the artifact and its versions, without content
    app.get('/channels/:id/artifacts/:artifactId', { schema: { params: params() } }, async (request, reply) => {
        const { id, artifactId } = request.params as any, db = request.dbClient!;
        if (!(await canViewChannel(db, id, request.userId, !!request.isBot)).allowed) return reply.status(403).send({ error: 'forbidden' });
        const found = await asService(db, async () => {
            const a = (await db.query(`SELECT btrim(id) AS id, title, kind, created_at AS "createdAt", updated_at AS "updatedAt", btrim(created_by) AS "createdBy"
                FROM artifacts WHERE id = $1 AND channel_id = $2`, [artifactId, id])).rows[0];
            if (!a) return null;
            const versions = (await db.query(`SELECT v.version, btrim(v.message_id) AS "messageId", btrim(m.thread_id) AS "threadId",
                    btrim(v.author_id) AS "authorId", u.username AS "authorUsername", u.bot AS "authorBot",
                    v.title, v.kind, char_length(v.content) AS size, v.created_at AS "createdAt"
                FROM artifact_versions v JOIN messages m ON m.id = v.message_id LEFT JOIN users u ON u.id = v.author_id
                WHERE v.artifact_id = $1 ORDER BY v.version DESC`, [artifactId])).rows;
            return { ...a, latestVersion: versions[0]?.version ?? null, versions };
        });
        return found ?? reply.status(404).send({ error: 'artifact_not_found' });
    });

    // GET /channels/:id/artifacts/:artifactId/versions/:version → one version with its content
    app.get('/channels/:id/artifacts/:artifactId/versions/:version', {
        schema: { params: params({ version: { type: 'integer', minimum: 1, maximum: 2147483647 } }) },
    }, async (request, reply) => {
        const { id, artifactId, version } = request.params as any, db = request.dbClient!;
        if (!(await canViewChannel(db, id, request.userId, !!request.isBot)).allowed) return reply.status(403).send({ error: 'forbidden' });
        const row = (await asService(db, () => db.query(`SELECT btrim(v.artifact_id) AS "artifactId", v.version, btrim(v.message_id) AS "messageId",
                btrim(v.author_id) AS "authorId", u.username AS "authorUsername", v.title, v.kind, v.content, v.created_at AS "createdAt"
            FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id LEFT JOIN users u ON u.id = v.author_id
            WHERE v.artifact_id = $1 AND a.channel_id = $2 AND v.version = $3`, [artifactId, id, version]))).rows[0];
        return row ?? reply.status(404).send({ error: 'version_not_found' });
    });
}
