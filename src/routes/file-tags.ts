import { FastifyInstance } from 'fastify';
import { generateUlid } from '../utils/ulid';
import { requireAdmin } from './ai-config';
import { auditAiChange } from '../lib/ai-audit';
import { listTags, seedDefaultTags, tagFromRow, MAX_TAGS_PER_SERVER } from '../lib/file-tags';
import { requeueFileTagging, taggingStats } from '../lib/file-tagging-queue';

/**
 * The server's file tag list (docs/planning/jev-wbs.md, C.1, C.5). Admins add,
 * edit and remove tags and write the criteria for each; a decision model then
 * answers one yes/no question per tag about every uploaded text file.
 */

// Letters, digits and a little punctuation: the name is shown on files and quoted in the question
const NAME_PATTERN = '^[A-Za-z0-9][A-Za-z0-9 _.&+/-]{0,39}$';
const text = (max: number) => ({ type: 'string', minLength: 1, maxLength: max });
const optionalText = (max: number) => ({ type: ['string', 'null'], maxLength: max });

const cleanName = (name: string) => name.replace(/\s+/g, ' ').trim();

function tagDto(row: any) {
    const tag = tagFromRow(row);
    return { ...tag, createdAt: row.created_at, updatedAt: row.updated_at };
}

export async function fileTagRoutes(app: FastifyInstance) {

    // GET /servers/:serverId/file-tags → the tag names any member can filter by
    app.get('/servers/:serverId/file-tags', async (request, reply) => {
        const { serverId } = request.params as any;
        const db = request.dbClient!;
        const member = await db.query('SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2', [serverId, request.userId]);
        if (member.rows.length === 0) return reply.status(403).send({ error: 'forbidden' });
        const tags = await listTags(db, serverId, { enabledOnly: true });
        return reply.send(tags.map(t => ({ id: t.id, name: t.name })));
    });

    // GET /servers/:serverId/ai/tags → the full list with criteria, and the state of the tagging queue
    app.get('/servers/:serverId/ai/tags', { preHandler: [requireAdmin] }, async (request, reply) => {
        const { serverId } = request.params as any;
        const db = request.dbClient!;
        // A server gets the default tags the first time an admin opens the list
        await seedDefaultTags(db, serverId);
        const rows = await db.query('SELECT * FROM file_tag_definitions WHERE server_id = $1 ORDER BY lower(name)', [serverId]);
        return reply.send({ tags: rows.rows.map(tagDto), max: MAX_TAGS_PER_SERVER, queue: await taggingStats(db, serverId) });
    });

    app.post('/servers/:serverId/ai/tags', {
        preHandler: [requireAdmin],
        schema: {
            body: {
                type: 'object',
                required: ['name', 'instructions'],
                additionalProperties: false,
                properties: {
                    name: { type: 'string', pattern: NAME_PATTERN },
                    instructions: text(500),
                    criteriaTrue: optionalText(500),
                    criteriaFalse: optionalText(500),
                    enabled: { type: 'boolean' },
                },
            },
        },
    }, async (request, reply) => {
        const { serverId } = request.params as any;
        const body = request.body as any;
        const db = request.dbClient!;

        const count = await db.query('SELECT COUNT(*)::int AS n FROM file_tag_definitions WHERE server_id = $1', [serverId]);
        if (count.rows[0].n >= MAX_TAGS_PER_SERVER) {
            return reply.status(409).send({ error: `A server can have at most ${MAX_TAGS_PER_SERVER} tags` });
        }

        const id = generateUlid();
        try {
            await db.query('SAVEPOINT create_tag');
            const res = await db.query(
                `INSERT INTO file_tag_definitions (id, server_id, name, instructions, criteria_true, criteria_false, enabled)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
                [id, serverId, cleanName(body.name), body.instructions.trim(), body.criteriaTrue?.trim() || null,
                 body.criteriaFalse?.trim() || null, body.enabled ?? true]
            );
            await db.query('RELEASE SAVEPOINT create_tag');
            await auditAiChange(db, request, {
                serverId, action: 'ai_tag_create', targetType: 'ai_tag', targetId: id,
                changes: { name: res.rows[0].name, enabled: res.rows[0].enabled },
            });
            return reply.status(201).send(tagDto(res.rows[0]));
        } catch (err: any) {
            await db.query('ROLLBACK TO SAVEPOINT create_tag');
            if (err.code === '23505') return reply.status(409).send({ error: 'A tag with this name already exists' });
            throw err;
        }
    });

    app.patch('/servers/:serverId/ai/tags/:tagId', {
        preHandler: [requireAdmin],
        schema: {
            body: {
                type: 'object',
                minProperties: 1,
                additionalProperties: false,
                properties: {
                    name: { type: 'string', pattern: NAME_PATTERN },
                    instructions: text(500),
                    criteriaTrue: optionalText(500),
                    criteriaFalse: optionalText(500),
                    enabled: { type: 'boolean' },
                },
            },
        },
    }, async (request, reply) => {
        const { serverId, tagId } = request.params as any;
        const body = request.body as any;
        const db = request.dbClient!;

        const existing = await db.query('SELECT * FROM file_tag_definitions WHERE id = $1 AND server_id = $2 FOR UPDATE', [tagId, serverId]);
        if (existing.rows.length === 0) return reply.status(404).send({ error: 'Tag not found' });
        const current = existing.rows[0];

        const next = {
            name: body.name !== undefined ? cleanName(body.name) : current.name,
            instructions: body.instructions !== undefined ? body.instructions.trim() : current.instructions,
            criteria_true: body.criteriaTrue !== undefined ? (body.criteriaTrue?.trim() || null) : current.criteria_true,
            criteria_false: body.criteriaFalse !== undefined ? (body.criteriaFalse?.trim() || null) : current.criteria_false,
            enabled: body.enabled !== undefined ? body.enabled : current.enabled,
        };
        const changed = (Object.keys(next) as (keyof typeof next)[]).filter(k => next[k] !== current[k]);
        if (changed.length === 0) return reply.send(tagDto(current));

        // What the model is asked changed (the name is part of the question): existing results are stale
        const meaningChanged = changed.some(k => k !== 'enabled');

        try {
            await db.query('SAVEPOINT update_tag');
            const res = await db.query(
                `UPDATE file_tag_definitions
                 SET name = $1, instructions = $2, criteria_true = $3, criteria_false = $4, enabled = $5,
                     revision = revision + $6, updated_at = NOW()
                 WHERE id = $7 RETURNING *`,
                [next.name, next.instructions, next.criteria_true, next.criteria_false, next.enabled, meaningChanged ? 1 : 0, tagId]
            );
            await db.query('RELEASE SAVEPOINT update_tag');
            await auditAiChange(db, request, {
                serverId, action: 'ai_tag_update', targetType: 'ai_tag', targetId: tagId,
                changes: { name: res.rows[0].name, changed, revision: res.rows[0].revision, enabled: res.rows[0].enabled },
            });
            return reply.send(tagDto(res.rows[0]));
        } catch (err: any) {
            await db.query('ROLLBACK TO SAVEPOINT update_tag');
            if (err.code === '23505') return reply.status(409).send({ error: 'A tag with this name already exists' });
            throw err;
        }
    });

    app.delete('/servers/:serverId/ai/tags/:tagId', { preHandler: [requireAdmin] }, async (request, reply) => {
        const { serverId, tagId } = request.params as any;
        const db = request.dbClient!;
        // The tag's results on every file go with it (FK cascade)
        const res = await db.query('DELETE FROM file_tag_definitions WHERE id = $1 AND server_id = $2 RETURNING name', [tagId, serverId]);
        if (res.rows.length === 0) return reply.status(404).send({ error: 'Tag not found' });
        await auditAiChange(db, request, {
            serverId, action: 'ai_tag_delete', targetType: 'ai_tag', targetId: tagId, changes: { name: res.rows[0].name },
        });
        return reply.send({ deleted: true });
    });

    // POST /servers/:serverId/ai/tags/retag → queue every file that needs (re)tagging now
    app.post('/servers/:serverId/ai/tags/retag', {
        preHandler: [requireAdmin],
        schema: {
            body: {
                type: 'object',
                additionalProperties: false,
                properties: { includeFailed: { type: 'boolean' } },
            },
        },
    }, async (request, reply) => {
        const { serverId } = request.params as any;
        const db = request.dbClient!;
        const { includeFailed } = (request.body as any) ?? {};

        const on = await db.query('SELECT tagging_enabled FROM ai_decision_settings WHERE server_id = $1', [serverId]);
        if (!on.rows[0]?.tagging_enabled) {
            return reply.status(409).send({ error: 'File tagging is switched off. Turn it on under Decision model first.' });
        }
        // The queue belongs to the server, not to the admin's database role
        const result = await requeueFileTagging(app.db, serverId, { includeFailed: !!includeFailed });
        await auditAiChange(db, request, {
            serverId, action: 'ai_tag_retag', targetType: 'ai_tag', targetId: null, changes: { ...result },
        });
        return reply.send({ ...result, queue: await taggingStats(app.db, serverId) });
    });
}
