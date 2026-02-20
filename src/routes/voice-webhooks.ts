import { FastifyInstance } from 'fastify';
import { WebhookReceiver } from 'livekit-server-sdk';
import { config } from '../config';

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

        if (event.event === 'participant_joined' && event.participant && event.room) {
            const channelId = event.room.name.replace(/^channel-/, '');
            if (io) {
                io.to(`channel:${channelId}`).emit('voice:participant_joined', {
                    channelId,
                    userId: event.participant.identity,
                    username: event.participant.name ?? event.participant.identity,
                });
            }
        }

        if (event.event === 'participant_left' && event.participant && event.room) {
            const channelId = event.room.name.replace(/^channel-/, '');
            if (io) {
                io.to(`channel:${channelId}`).emit('voice:participant_left', {
                    channelId,
                    userId: event.participant.identity,
                });
            }
        }

        if (event.event === 'room_finished' && event.room) {
            const channelId = event.room.name.replace(/^channel-/, '');
            if (io) {
                io.to(`channel:${channelId}`).emit('voice:room_finished', {
                    channelId,
                });
            }
        }

        return reply.status(200).send({ received: true });
    });
}
