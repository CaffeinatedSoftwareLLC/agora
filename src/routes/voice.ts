import { FastifyInstance } from 'fastify';
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import { config } from '../config';
import { computePermissions, Permissions } from '../permissions';

/** Convert ws:// LiveKit URL to http:// for the RoomServiceClient REST API. */
function livekitHttpUrl(): string {
    return config.livekitUrl
        .replace(/^ws:\/\//, 'http://')
        .replace(/^wss:\/\//, 'https://');
}

/**
 * Load everything computePermissions needs from the DB and return the computed bitmask.
 */
async function loadPermissions(
    db: any,
    userId: string,
    serverId: string,
    channelId: string,
): Promise<bigint> {
    // 1. Server owner + everyone role id
    const serverRow = await db.query(
        'SELECT owner_id, everyone_role_id FROM servers WHERE id = $1',
        [serverId],
    );
    if (serverRow.rows.length === 0) return 0n;
    const ownerId = serverRow.rows[0].owner_id.trim();
    const everyoneRoleId = serverRow.rows[0].everyone_role_id.trim();

    // 2. User's assigned roles in this server
    const memberRolesResult = await db.query(
        `SELECT role_id FROM member_roles
         WHERE server_id = $1 AND user_id = $2`,
        [serverId, userId],
    );
    const roleIds = memberRolesResult.rows.map((r: any) => r.role_id.trim());

    // 3. All roles in server (everyone + assigned)
    const allRoleIds = [everyoneRoleId, ...roleIds];
    const rolesResult = await db.query(
        `SELECT id, permissions FROM roles WHERE id = ANY($1)`,
        [allRoleIds],
    );
    const roles = new Map<string, { permissions: bigint }>();
    for (const r of rolesResult.rows) {
        roles.set(r.id.trim(), { permissions: BigInt(r.permissions) });
    }

    // 4. Channel role overrides
    const channelRoleOverridesResult = await db.query(
        `SELECT role_id, allow, deny
         FROM channel_role_overrides
         WHERE channel_id = $1`,
        [channelId],
    );
    const channelRoleOverrides = new Map<string, { allow: bigint; deny: bigint }>();
    for (const r of channelRoleOverridesResult.rows) {
        channelRoleOverrides.set(r.role_id.trim(), {
            allow: BigInt(r.allow),
            deny: BigInt(r.deny),
        });
    }

    // 5. Channel member override
    const channelMemberOverrideResult = await db.query(
        `SELECT allow, deny
         FROM channel_member_overrides
         WHERE channel_id = $1 AND user_id = $2`,
        [channelId, userId],
    );
    const channelMemberOverride =
        channelMemberOverrideResult.rows.length > 0
            ? {
                  allow: BigInt(channelMemberOverrideResult.rows[0].allow),
                  deny: BigInt(channelMemberOverrideResult.rows[0].deny),
              }
            : undefined;

    return computePermissions({
        userId,
        roleIds,
        server: { ownerId, everyoneRoleId },
        roles,
        channelRoleOverrides,
        channelMemberOverride,
    });
}

export async function voiceRoutes(app: FastifyInstance) {
    // Guard: all voice endpoints require LiveKit to be configured
    app.addHook('preHandler', async (_request, reply) => {
        if (!config.livekitApiKey || !config.livekitApiSecret) {
            return reply.status(503).send({ error: 'Voice chat is not configured on this instance' });
        }
    });

    // POST /voice/token → generate LiveKit access token
    app.post('/voice/token', {
        schema: {
            body: {
                type: 'object',
                required: ['channelId'],
                properties: {
                    channelId: { type: 'string', minLength: 1 },
                },
            },
        },
    }, async (request, reply) => {
        const userId = (request as any).userId;
        const { channelId } = request.body as any;
        const db = (request as any).dbClient;

        // Verify channel exists and is voice type (channel_type = 4)
        const channelResult = await db.query(
            'SELECT id, server_id FROM channels WHERE id = $1 AND channel_type = 4',
            [channelId],
        );
        if (channelResult.rows.length === 0) {
            return reply.status(404).send({ error: 'Voice channel not found' });
        }

        const serverId = channelResult.rows[0].server_id.trim();

        // Check server membership
        const member = await db.query(
            'SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2',
            [serverId, userId],
        );
        if (member.rows.length === 0) {
            return reply.status(403).send({ error: 'Not a member of this server' });
        }

        // Compute permissions
        const perms = await loadPermissions(db, userId, serverId, channelId);

        if (!(perms & Permissions.VoiceConnect)) {
            return reply.status(403).send({ error: 'Missing VoiceConnect permission' });
        }

        const canSpeak = !!(perms & Permissions.VoiceSpeak);
        const canVideo = !!(perms & Permissions.VoiceVideo);

        // Fetch username for participant display name
        const userRow = await db.query(
            'SELECT username FROM users WHERE id = $1',
            [userId],
        );
        const username = userRow.rows[0]?.username ?? 'Unknown';

        // Build LiveKit access token
        const roomName = `channel-${channelId.trim()}`;

        const token = new AccessToken(config.livekitApiKey, config.livekitApiSecret, {
            identity: userId.trim(),
            name: username,
            ttl: '1h',
        });

        // Build canPublishSources based on permissions
        const publishSources: TrackSource[] = [];
        if (canSpeak) {
            publishSources.push(TrackSource.MICROPHONE);
        }
        if (canVideo) {
            publishSources.push(TrackSource.CAMERA);
            publishSources.push(TrackSource.SCREEN_SHARE);
            publishSources.push(TrackSource.SCREEN_SHARE_AUDIO);
        }

        token.addGrant({
            roomJoin: true,
            room: roomName,
            canSubscribe: true,
            canPublish: canSpeak || canVideo,
            canPublishSources: publishSources.length > 0 ? publishSources : undefined,
            canPublishData: true,
        });

        const jwt = await token.toJwt();

        return reply.status(200).send({
            token: jwt,
            url: config.livekitUrl,
        });
    });

    // GET /voice/participants/:channelId → list voice participants
    app.get('/voice/participants/:channelId', {
        schema: {
            params: {
                type: 'object',
                required: ['channelId'],
                properties: {
                    channelId: { type: 'string', minLength: 1 },
                },
            },
        },
    }, async (request, reply) => {
        const userId = (request as any).userId;
        const { channelId } = request.params as any;
        const db = (request as any).dbClient;

        // Verify channel exists and is voice type
        const channelResult = await db.query(
            'SELECT id, server_id FROM channels WHERE id = $1 AND channel_type = 4',
            [channelId],
        );
        if (channelResult.rows.length === 0) {
            return reply.status(404).send({ error: 'Voice channel not found' });
        }

        const serverId = channelResult.rows[0].server_id.trim();

        // Check server membership
        const member = await db.query(
            'SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2',
            [serverId, userId],
        );
        if (member.rows.length === 0) {
            return reply.status(403).send({ error: 'Not a member of this server' });
        }

        const roomName = `channel-${channelId.trim()}`;
        const roomService = new RoomServiceClient(
            livekitHttpUrl(),
            config.livekitApiKey,
            config.livekitApiSecret,
        );

        try {
            const participants = await roomService.listParticipants(roomName);
            return reply.status(200).send(
                participants.map((p) => ({
                    identity: p.identity,
                    name: p.name,
                    joinedAt: p.joinedAt ? Number(p.joinedAt) : undefined,
                    tracks: p.tracks.map((t) => ({
                        sid: t.sid,
                        source: t.source,
                        muted: t.muted,
                    })),
                })),
            );
        } catch {
            // Room may not exist yet in LiveKit — return empty array
            return reply.status(200).send([]);
        }
    });

    // POST /voice/kick → remove participant from voice channel
    app.post('/voice/kick', {
        schema: {
            body: {
                type: 'object',
                required: ['channelId', 'userId'],
                properties: {
                    channelId: { type: 'string', minLength: 1 },
                    userId: { type: 'string', minLength: 1 },
                },
            },
        },
    }, async (request, reply) => {
        const actorId = (request as any).userId;
        const { channelId, userId: targetUserId } = request.body as any;
        const db = (request as any).dbClient;

        // Verify channel exists and is voice type
        const channelResult = await db.query(
            'SELECT id, server_id FROM channels WHERE id = $1 AND channel_type = 4',
            [channelId],
        );
        if (channelResult.rows.length === 0) {
            return reply.status(404).send({ error: 'Voice channel not found' });
        }

        const serverId = channelResult.rows[0].server_id.trim();

        // Check actor's server membership
        const member = await db.query(
            'SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2',
            [serverId, actorId],
        );
        if (member.rows.length === 0) {
            return reply.status(403).send({ error: 'Not a member of this server' });
        }

        // Check VoiceMoveMembers permission
        const perms = await loadPermissions(db, actorId, serverId, channelId);
        if (!(perms & Permissions.VoiceMoveMembers)) {
            return reply.status(403).send({ error: 'Missing VoiceMoveMembers permission' });
        }

        const roomName = `channel-${channelId.trim()}`;
        const roomService = new RoomServiceClient(
            livekitHttpUrl(),
            config.livekitApiKey,
            config.livekitApiSecret,
        );

        try {
            await roomService.removeParticipant(roomName, targetUserId.trim());
        } catch {
            // Participant may already have left — treat as success
        }

        return reply.status(200).send({ success: true });
    });

    // POST /voice/mute → server-mute a participant
    app.post('/voice/mute', {
        schema: {
            body: {
                type: 'object',
                required: ['channelId', 'userId'],
                properties: {
                    channelId: { type: 'string', minLength: 1 },
                    userId: { type: 'string', minLength: 1 },
                },
            },
        },
    }, async (request, reply) => {
        const actorId = (request as any).userId;
        const { channelId, userId: targetUserId } = request.body as any;
        const db = (request as any).dbClient;

        // Verify channel exists and is voice type
        const channelResult = await db.query(
            'SELECT id, server_id FROM channels WHERE id = $1 AND channel_type = 4',
            [channelId],
        );
        if (channelResult.rows.length === 0) {
            return reply.status(404).send({ error: 'Voice channel not found' });
        }

        const serverId = channelResult.rows[0].server_id.trim();

        // Check actor's server membership
        const member = await db.query(
            'SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2',
            [serverId, actorId],
        );
        if (member.rows.length === 0) {
            return reply.status(403).send({ error: 'Not a member of this server' });
        }

        // Check VoiceMuteMembers permission
        const perms = await loadPermissions(db, actorId, serverId, channelId);
        if (!(perms & Permissions.VoiceMuteMembers)) {
            return reply.status(403).send({ error: 'Missing VoiceMuteMembers permission' });
        }

        const roomName = `channel-${channelId.trim()}`;
        const roomService = new RoomServiceClient(
            livekitHttpUrl(),
            config.livekitApiKey,
            config.livekitApiSecret,
        );

        try {
            await roomService.updateParticipant(roomName, targetUserId.trim(), {
                permission: {
                    canPublish: false,
                },
            });
        } catch {
            // Participant may not be in room
            return reply.status(404).send({ error: 'Participant not found in voice channel' });
        }

        return reply.status(200).send({ success: true });
    });
}
