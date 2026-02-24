import { FastifyInstance } from 'fastify';
import { WebhookReceiver } from 'livekit-server-sdk';
import { config } from '../config';
import { getCallById, removeCall } from '../call-state';
import { generateUlid } from '../utils/ulid';

export async function voiceWebhookRoutes(app: FastifyInstance) {
    if (!config.livekitApiKey || !config.livekitApiSecret) {
        // LiveKit not configured — skip registering webhook routes
        return;
    }

    const receiver = new WebhookReceiver(config.livekitApiKey, config.livekitApiSecret);

    // Override the JSON content-type parser within this encapsulated context so we
    // can capture the raw body string for webhook signature verification.
    app.addContentTypeParser(
        'application/webhook+json',
        { parseAs: 'string' },
        (_req: any, body: string, done: any) => {
            done(null, body);
        },
    );

    app.addContentTypeParser(
        'application/json',
        { parseAs: 'string' },
        (_req: any, body: string, done: any) => {
            done(null, body);
        },
    );

    // POST /webhooks/livekit → receive LiveKit webhook events
    app.post('/webhooks/livekit', async (request, reply) => {
        const rawBody = request.body as string;
        const authHeader = request.headers['authorization'] as string | undefined;

        let event;
        try {
            event = await receiver.receive(rawBody, authHeader);
        } catch {
            return reply.status(401).send({ error: 'Invalid webhook signature' });
        }

        const io = (request.server as any).io;
        const roomName = event.room?.name ?? '';

        // Guard: only handle channel-* rooms for server voice events
        if (event.event === 'participant_joined' && event.participant && event.room && roomName.startsWith('channel-')) {
            const channelId = roomName.replace(/^channel-/, '');
            if (io) {
                io.to(`channel:${channelId}`).emit('voice:participant_joined', {
                    channelId,
                    userId: event.participant.identity,
                    username: event.participant.name ?? event.participant.identity,
                });
            }
        }

        if (event.event === 'participant_left' && event.participant && event.room && roomName.startsWith('channel-')) {
            const channelId = roomName.replace(/^channel-/, '');
            if (io) {
                io.to(`channel:${channelId}`).emit('voice:participant_left', {
                    channelId,
                    userId: event.participant.identity,
                });
            }
        }

        if (event.event === 'room_finished' && event.room && roomName.startsWith('channel-')) {
            const channelId = roomName.replace(/^channel-/, '');
            if (io) {
                io.to(`channel:${channelId}`).emit('voice:room_finished', {
                    channelId,
                });
            }
        }

        // DM call room_finished safety net: clean up if call state still exists
        if (event.event === 'room_finished' && event.room && roomName.startsWith('dm-call-')) {
            const callId = roomName.replace(/^dm-call-/, '');
            const call = getCallById(callId);
            if (call) {
                const wasConnected = call.status === 'connected';
                const removed = removeCall(callId)!;
                const pool = (app as any).db;

                // Choose message/event based on whether the call was ever connected
                const callLabel = removed.callType === 'video'
                    ? (wasConnected ? 'Video call' : 'video call')
                    : (wasConnected ? 'Voice call' : 'voice call');
                const systemEvent = wasConnected ? 'call_ended' : 'call_missed';
                const duration = removed.connectedAt ? Date.now() - removed.connectedAt : 0;
                const durationStr = removed.connectedAt ? ` \u2014 ${formatDuration(duration)}` : '';
                const content = wasConnected ? `${callLabel}${durationStr}` : `Missed ${callLabel}`;
                const socketEvent = wasConnected ? 'call:ended' : 'call:timeout';

                // Insert system message via pool (outside request lifecycle)
                let sysMsgData: any = null;
                try {
                    const client = await pool.connect();
                    try {
                        const msgId = generateUlid();
                        const result = await client.query(
                            `INSERT INTO messages (id, channel_id, author_id, content, system_event)
                             VALUES ($1, $2, $3, $4, $5)
                             RETURNING created_at`,
                            [msgId, removed.channelId, removed.callerId, content, systemEvent],
                        );
                        sysMsgData = {
                            id: msgId.trim(),
                            content,
                            authorId: removed.callerId,
                            authorUsername: removed.callerUsername,
                            channelId: removed.channelId,
                            createdAt: result.rows[0].created_at,
                            systemEvent,
                        };
                    } finally {
                        client.release();
                    }
                } catch {
                    // Best-effort system message
                }

                // Emit call lifecycle event + Message broadcast to both participants
                if (io) {
                    const eventData = wasConnected
                        ? { callId, duration }
                        : { callId };
                    io.to(`user:${removed.callerId}`).emit(socketEvent, eventData);
                    io.to(`user:${removed.recipientId}`).emit(socketEvent, eventData);
                    if (sysMsgData) {
                        io.to(`channel:${removed.channelId}`).emit('Message', sysMsgData);
                    }
                }
            }
        }

        return reply.status(200).send({ received: true });
    });
}

function formatDuration(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
