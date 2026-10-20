import type { FastifyInstance, FastifyRequest } from 'fastify';
import { canViewChannel } from '../lib/channel-access';
import { cannotDirect, isServerOwner, stampAuthority } from '../lib/direct-agents';
import { asService } from '../lib/agent-sessions';
import {
    channelFileIds, MAX_INSTRUCTIONS, MAX_PROJECT_FILES, MAX_VERIFY_RETRIES, readProject, saveProject, saveVerify,
    VERIFY_COMMAND_PATTERN, type Project,
} from '../lib/channel-projects';

/**
 * Channel project context and verify before yield (docs/project-context.md).
 *
 * - GET: anyone who can see the channel, bots included (agora-mcp's project_context).
 * - PUT /project: people who may direct agents here (the owner and directors). Bots can't:
 *   an agent rewriting the instructions every agent wakes with is a prompt-injection path.
 * - PUT /project/verify: the server owner alone, because the host runs the command on
 *   their machine.
 */

const FILE_ID = { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' } as const;

async function channelServer(db: any, channelId: string): Promise<string | null> {
    const row = await db.query('SELECT server_id FROM channels WHERE id = $1', [channelId]);
    return row.rows[0]?.server_id?.trim() ?? null;
}

async function viewerFlags(request: FastifyRequest, channelId: string, serverId: string) {
    const db = request.dbClient!;
    if (request.isBot) return { canEdit: false, canEditVerify: false };
    const owner = await isServerOwner(db, serverId, request.userId!);
    return { canEdit: owner || await stampAuthority(db, channelId, request.userId!, false), canEditVerify: owner };
}

function projectEvent(request: FastifyRequest, project: Project) {
    request.pendingEvents ??= [];
    request.pendingEvents.push({ room: `channel:${project.channelId}`, event: 'ChannelProjectUpdate', data: project });
}

export async function channelProjectRoutes(app: FastifyInstance) {
    // GET /channels/:id/project → 200 { channelId, instructions, version, files, verify, updatedAt, updatedBy, canEdit, canEditVerify }
    app.get('/channels/:id/project', async (request, reply) => {
        const { id: channelId } = request.params as { id: string };
        const db = request.dbClient!;
        const access = await canViewChannel(db, channelId, request.userId!, !!request.isBot);
        if (!access.allowed) return reply.status(access.status ?? 403).send({ error: access.error ?? 'forbidden' });
        const serverId = await channelServer(db, channelId);
        if (!serverId) return reply.status(404).send({ error: 'Channel not found' });
        const project = await asService(db, () => readProject(db, channelId));
        return reply.send({ ...project, ...await viewerFlags(request, channelId, serverId) });
    });

    // PUT /channels/:id/project → 200 project. Either field may be left out; fileIds replaces the list, in order.
    app.put('/channels/:id/project', {
        schema: {
            body: {
                type: 'object', additionalProperties: false, minProperties: 1,
                properties: {
                    instructions: { type: 'string', maxLength: MAX_INSTRUCTIONS },
                    fileIds: { type: 'array', maxItems: MAX_PROJECT_FILES, uniqueItems: true, items: FILE_ID },
                },
            },
        },
    }, async (request, reply) => {
        const { id: channelId } = request.params as { id: string };
        const body = request.body as { instructions?: string; fileIds?: string[] };
        const db = request.dbClient!;
        if (request.isBot) return reply.status(403).send({ error: 'Only people can change a channel\'s project context' });
        const access = await canViewChannel(db, channelId, request.userId!, false);
        if (!access.allowed) return reply.status(access.status ?? 403).send({ error: access.error ?? 'forbidden' });
        const serverId = await channelServer(db, channelId);
        if (!serverId) return reply.status(404).send({ error: 'Channel not found' });
        if (!(await viewerFlags(request, channelId, serverId)).canEdit) return reply.status(403).send(await cannotDirect(db, channelId, request.userId!));

        const project = await asService(db, async () => {
            if (body.fileIds) {
                const found = await channelFileIds(db, channelId, body.fileIds);
                const missing = body.fileIds.filter(id => !found.has(id));
                if (missing.length) return { error: `Not a file shared in this channel: ${missing.join(', ')}` };
            }
            await saveProject(db, channelId, serverId, request.userId!, body);
            return readProject(db, channelId);
        });
        if ('error' in project) return reply.status(400).send(project);
        projectEvent(request, project);
        return reply.send({ ...project, canEdit: true, canEditVerify: await isServerOwner(db, serverId, request.userId!) });
    });

    // PUT /channels/:id/project/verify → 200 project. command null turns it off.
    app.put('/channels/:id/project/verify', {
        schema: {
            body: {
                type: 'object', additionalProperties: false, required: ['command'],
                properties: {
                    command: { anyOf: [{ type: 'string', maxLength: 300, pattern: VERIFY_COMMAND_PATTERN }, { type: 'null' }] },
                    maxRetries: { type: 'integer', minimum: 0, maximum: MAX_VERIFY_RETRIES },
                },
            },
        },
    }, async (request, reply) => {
        const { id: channelId } = request.params as { id: string };
        const body = request.body as { command: string | null; maxRetries?: number };
        const db = request.dbClient!;
        if (request.isBot) return reply.status(403).send({ error: 'Only the server owner can set the verify command' });
        const access = await canViewChannel(db, channelId, request.userId!, false);
        if (!access.allowed) return reply.status(access.status ?? 403).send({ error: access.error ?? 'forbidden' });
        const serverId = await channelServer(db, channelId);
        if (!serverId) return reply.status(404).send({ error: 'Channel not found' });
        if (!await isServerOwner(db, serverId, request.userId!)) return reply.status(403).send({ error: 'Only the server owner can set the verify command' });

        const project = await asService(db, async () => {
            await saveVerify(db, channelId, serverId, request.userId!, body.command, body.maxRetries);
            return readProject(db, channelId);
        });
        projectEvent(request, project);
        return reply.send({ ...project, canEdit: true, canEditVerify: true });
    });
}
