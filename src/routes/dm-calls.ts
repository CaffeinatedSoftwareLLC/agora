import { FastifyInstance } from 'fastify';
import { AccessToken } from 'livekit-server-sdk';
import { RoomServiceClient } from 'livekit-server-sdk';
import { config } from '../config';
import { generateUlid } from '../utils/ulid';
import { checkChannelMembership } from './shared';
import {
    addCall,
    getCallById,
    getCallByChannel,
    isUserInCall,
    removeCall,
    setCallConnected,
    startCallTimeout,
    clearCallTimeout,
    type ActiveCall,
} from '../call-state';

/** HTTP URL for the RoomServiceClient REST API. */
function livekitHttpUrl(): string {
    if (config.livekitInternalUrl) return config.livekitInternalUrl;
    return config.livekitUrl
        .replace(/^ws:\/\//, 'http://')
        .replace(/^wss:\/\//, 'https://');
}

function formatDuration(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

async function generateCallToken(userId: string, username: string, roomName: string): Promise<string> {
    const token = new AccessToken(config.livekitApiKey, config.livekitApiSecret, {
        identity: userId.trim(),
        name: username,
        ttl: '1h',
    });
    token.addGrant({
        roomJoin: true,
        room: roomName,
        canSubscribe: true,
        canPublish: true,
        canPublishData: true,
    });
    return await token.toJwt();
}

async function deleteRoomBestEffort(roomName: string): Promise<void> {
    try {
        const roomService = new RoomServiceClient(
            livekitHttpUrl(),
            config.livekitApiKey,
            config.livekitApiSecret,
        );
        await roomService.deleteRoom(roomName);
    } catch {
        // Best-effort — room may not exist yet
    }
}

interface SystemMessageRow {
    id: string;
    content: string;
    authorId: string;
    channelId: string;
    systemEvent: string;
    createdAt: string;
}

async function insertSystemMessage(
    db: any,
    channelId: string,
    authorId: string,
    content: string,
    systemEvent: string,
): Promise<SystemMessageRow> {
    const messageId = generateUlid();
    const result = await db.query(
        `INSERT INTO messages (id, channel_id, author_id, content, system_event)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING created_at`,
        [messageId, channelId, authorId, content, systemEvent],
    );
    return {
        id: messageId.trim(),
        content,
        authorId: authorId.trim(),
        channelId: channelId.trim(),
        systemEvent,
        createdAt: result.rows[0].created_at,
    };
}

/** Build a Message socket payload from a system message row + author username. */
function systemMessageEvent(msg: SystemMessageRow, authorUsername: string) {
    return {
        id: msg.id,
        content: msg.content,
        authorId: msg.authorId,
        authorUsername,
        channelId: msg.channelId,
        createdAt: msg.createdAt,
        systemEvent: msg.systemEvent,
    };
}

interface DmCallRouteOptions {
    timeoutMs?: number;
}

export async function dmCallRoutes(app: FastifyInstance, opts?: DmCallRouteOptions) {
    const CALL_TIMEOUT_MS = opts?.timeoutMs ?? 30_000;

    // Guard: all call endpoints require LiveKit to be configured
    app.addHook('preHandler', async (_request, reply) => {
        if (!config.livekitApiKey || !config.livekitApiSecret) {
            return reply.status(503).send({ error: 'Voice chat is not configured on this instance' });
        }
    });

    // ─── POST /calls/initiate ────────────────────────────────────────────

    app.post('/calls/initiate', {
        schema: {
            body: {
                type: 'object',
                required: ['channelId', 'callType'],
                properties: {
                    channelId: { type: 'string', minLength: 1 },
                    callType: { type: 'string', enum: ['voice', 'video'] },
                },
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { channelId, callType } = request.body as any;
        const db = request.dbClient!;

        // Verify channel exists and is DM type (channel_type = 1)
        const channelResult = await db.query(
            'SELECT id, channel_type FROM channels WHERE id = $1',
            [channelId],
        );
        if (channelResult.rows.length === 0) {
            return reply.status(404).send({ error: 'Channel not found' });
        }
        if (channelResult.rows[0].channel_type !== 1) {
            return reply.status(404).send({ error: 'Channel is not a DM channel' });
        }

        // Verify caller is a member
        const isMember = await checkChannelMembership(db, channelId, userId);
        if (!isMember) {
            return reply.status(403).send({ error: 'Not a member of this channel' });
        }

        // Find the other DM member (recipient)
        const membersResult = await db.query(
            'SELECT user_id FROM channel_members WHERE channel_id = $1 AND user_id != $2',
            [channelId, userId],
        );
        if (membersResult.rows.length === 0) {
            return reply.status(404).send({ error: 'Recipient not found' });
        }
        const recipientId = membersResult.rows[0].user_id.trim();

        // Fetch caller username
        const userRow = await db.query(
            'SELECT username FROM users WHERE id = $1',
            [userId],
        );
        const callerUsername = userRow.rows[0]?.username ?? 'Unknown';

        const callId = generateUlid();
        const call: ActiveCall = {
            callId,
            channelId: channelId.trim(),
            callerId: userId.trim(),
            callerUsername,
            recipientId,
            callType,
            status: 'ringing',
            startedAt: Date.now(),
        };

        const err = addCall(call);
        if (err) {
            const errorMap: Record<string, string> = {
                channel_already_active: 'call_already_active',
                caller_in_call: 'already_in_call',
                recipient_in_call: 'recipient_in_call',
            };
            return reply.status(409).send({ error: errorMap[err] });
        }

        // Generate LiveKit token
        const roomName = `dm-call-${callId}`;
        const token = await generateCallToken(userId.trim(), callerUsername, roomName);

        // Start timeout
        const pool = app.db;
        const io = app.io;
        startCallTimeout(call, CALL_TIMEOUT_MS, async (snapshot) => {
            // Only clean up if call still exists (not already handled by accept/decline/cancel)
            const existing = getCallById(snapshot.callId);
            if (!existing) return;

            removeCall(snapshot.callId);

            // Insert system message via pool (outside request lifecycle)
            const callLabel = snapshot.callType === 'video' ? 'video call' : 'voice call';
            const content = `Missed ${callLabel}`;
            let sysMsgData: any = null;
            try {
                const client = await pool.connect();
                try {
                    const msgId = generateUlid();
                    const result = await client.query(
                        `INSERT INTO messages (id, channel_id, author_id, content, system_event)
                         VALUES ($1, $2, $3, $4, $5)
                         RETURNING created_at`,
                        [msgId, snapshot.channelId, snapshot.callerId, content, 'call_missed'],
                    );
                    sysMsgData = {
                        id: msgId.trim(),
                        content,
                        authorId: snapshot.callerId,
                        authorUsername: snapshot.callerUsername,
                        channelId: snapshot.channelId,
                        createdAt: result.rows[0].created_at,
                        systemEvent: 'call_missed',
                    };
                } finally {
                    client.release();
                }
            } catch {
                // Best-effort system message
            }

            // Emit timeout + Message events to both parties
            if (io) {
                io.to(`user:${snapshot.callerId}`).emit('call:timeout', { callId: snapshot.callId });
                io.to(`user:${snapshot.recipientId}`).emit('call:timeout', { callId: snapshot.callId });
                if (sysMsgData) {
                    io.to(`channel:${snapshot.channelId}`).emit('Message', sysMsgData);
                }
            }

            // Destroy LiveKit room (best-effort)
            await deleteRoomBestEffort(`dm-call-${snapshot.callId}`);
        });

        // Queue incoming call event for recipient
        request.pendingEvents = request.pendingEvents || [];
        request.pendingEvents.push({
            room: `user:${recipientId}`,
            event: 'call:incoming',
            data: {
                callId,
                channelId: channelId.trim(),
                callerId: userId.trim(),
                callerUsername,
                callType,
            },
        });

        return reply.status(201).send({
            callId,
            token,
            url: config.livekitUrl,
            callType,
        });
    });

    // ─── POST /calls/accept ──────────────────────────────────────────────

    app.post('/calls/accept', {
        schema: {
            body: {
                type: 'object',
                required: ['callId'],
                properties: {
                    callId: { type: 'string', minLength: 1 },
                },
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { callId } = request.body as any;

        const call = getCallById(callId);
        if (!call || call.status !== 'ringing') {
            return reply.status(404).send({ error: 'Call not found or not ringing' });
        }
        if (call.recipientId !== userId.trim()) {
            return reply.status(403).send({ error: 'Not the call recipient' });
        }

        clearCallTimeout(callId);
        setCallConnected(callId);

        // Fetch recipient username
        const db = request.dbClient!;
        const userRow = await db.query(
            'SELECT username FROM users WHERE id = $1',
            [userId],
        );
        const recipientUsername = userRow.rows[0]?.username ?? 'Unknown';

        const roomName = `dm-call-${callId}`;
        const token = await generateCallToken(userId.trim(), recipientUsername, roomName);

        // Queue accepted event for both parties (multi-tab sync)
        request.pendingEvents = request.pendingEvents || [];
        request.pendingEvents.push({
            room: `user:${call.callerId}`,
            event: 'call:accepted',
            data: { callId },
        });
        request.pendingEvents.push({
            room: `user:${call.recipientId}`,
            event: 'call:accepted',
            data: { callId },
        });

        return reply.status(200).send({
            callId,
            token,
            url: config.livekitUrl,
        });
    });

    // ─── POST /calls/decline ─────────────────────────────────────────────

    app.post('/calls/decline', {
        schema: {
            body: {
                type: 'object',
                required: ['callId'],
                properties: {
                    callId: { type: 'string', minLength: 1 },
                },
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { callId } = request.body as any;

        const call = getCallById(callId);
        if (!call || call.status !== 'ringing') {
            return reply.status(404).send({ error: 'Call not found or not ringing' });
        }
        if (call.recipientId !== userId.trim()) {
            return reply.status(403).send({ error: 'Not the call recipient' });
        }

        clearCallTimeout(callId);
        const removed = removeCall(callId)!;

        // Insert system message
        const db = request.dbClient!;
        const callLabel = removed.callType === 'video' ? 'Video call' : 'Voice call';
        const sysMsg = await insertSystemMessage(db, removed.channelId, removed.callerId, `${callLabel} declined`, 'call_declined');

        // Queue events: declined to both parties + Message broadcast
        request.pendingEvents = request.pendingEvents || [];
        request.pendingEvents.push({
            room: `user:${removed.callerId}`,
            event: 'call:declined',
            data: { callId },
        });
        request.pendingEvents.push({
            room: `user:${removed.recipientId}`,
            event: 'call:declined',
            data: { callId },
        });
        request.pendingEvents.push({
            room: `channel:${removed.channelId}`,
            event: 'Message',
            data: systemMessageEvent(sysMsg, removed.callerUsername),
        });

        // Destroy LiveKit room (best-effort, outside transaction)
        deleteRoomBestEffort(`dm-call-${callId}`);

        return reply.status(200).send({ success: true });
    });

    // ─── POST /calls/cancel ──────────────────────────────────────────────

    app.post('/calls/cancel', {
        schema: {
            body: {
                type: 'object',
                required: ['callId'],
                properties: {
                    callId: { type: 'string', minLength: 1 },
                },
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { callId } = request.body as any;

        const call = getCallById(callId);
        if (!call || call.status !== 'ringing') {
            return reply.status(404).send({ error: 'Call not found or not ringing' });
        }
        if (call.callerId !== userId.trim()) {
            return reply.status(403).send({ error: 'Not the call initiator' });
        }

        clearCallTimeout(callId);
        const removed = removeCall(callId)!;

        // Insert system message
        const db = request.dbClient!;
        const callLabel = removed.callType === 'video' ? 'video call' : 'voice call';
        const sysMsg = await insertSystemMessage(db, removed.channelId, removed.callerId, `Missed ${callLabel}`, 'call_missed');

        // Queue events: cancelled to both parties + Message broadcast
        request.pendingEvents = request.pendingEvents || [];
        request.pendingEvents.push({
            room: `user:${removed.callerId}`,
            event: 'call:cancelled',
            data: { callId },
        });
        request.pendingEvents.push({
            room: `user:${removed.recipientId}`,
            event: 'call:cancelled',
            data: { callId },
        });
        request.pendingEvents.push({
            room: `channel:${removed.channelId}`,
            event: 'Message',
            data: systemMessageEvent(sysMsg, removed.callerUsername),
        });

        // Destroy LiveKit room (best-effort)
        deleteRoomBestEffort(`dm-call-${callId}`);

        return reply.status(200).send({ success: true });
    });

    // ─── POST /calls/end ─────────────────────────────────────────────────

    app.post('/calls/end', {
        schema: {
            body: {
                type: 'object',
                required: ['callId'],
                properties: {
                    callId: { type: 'string', minLength: 1 },
                },
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { callId } = request.body as any;

        const call = getCallById(callId);
        if (!call) {
            return reply.status(404).send({ error: 'Call not found' });
        }
        if (call.callerId !== userId.trim() && call.recipientId !== userId.trim()) {
            return reply.status(403).send({ error: 'Not a participant in this call' });
        }

        const removed = removeCall(callId)!;

        // Calculate duration
        const duration = removed.connectedAt ? Date.now() - removed.connectedAt : 0;

        // Insert system message
        const db = request.dbClient!;
        const callLabel = removed.callType === 'video' ? 'Video call' : 'Voice call';
        const durationStr = removed.connectedAt ? ` \u2014 ${formatDuration(duration)}` : '';
        const sysMsg = await insertSystemMessage(db, removed.channelId, removed.callerId, `${callLabel}${durationStr}`, 'call_ended');

        // Queue events: ended to both parties + Message broadcast
        request.pendingEvents = request.pendingEvents || [];
        request.pendingEvents.push({
            room: `user:${removed.callerId}`,
            event: 'call:ended',
            data: { callId, duration },
        });
        request.pendingEvents.push({
            room: `user:${removed.recipientId}`,
            event: 'call:ended',
            data: { callId, duration },
        });
        request.pendingEvents.push({
            room: `channel:${removed.channelId}`,
            event: 'Message',
            data: systemMessageEvent(sysMsg, removed.callerUsername),
        });

        // Destroy LiveKit room (best-effort)
        deleteRoomBestEffort(`dm-call-${callId}`);

        return reply.status(200).send({ success: true, duration });
    });
}
