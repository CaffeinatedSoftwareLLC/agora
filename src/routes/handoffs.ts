import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { canViewChannel } from '../lib/channel-access';
import { stampAuthority } from '../lib/direct-agents';
import { asService } from '../lib/agent-sessions';
import type { Notice } from '../lib/agent-runs';
import { acceptOffer, cancelOffer, createOffer, declineOffer, HandoffError, HANDOFF_TTL_MAX, threadHandoffs } from '../lib/handoffs';

/**
 * Ownership handoffs (#84, src/lib/handoffs.ts). Agents offer, accept and decline through
 * agora-mcp (handoff_offer, handoff_accept, handoff_decline); the sender, the owner and
 * directors cancel; anyone who can see the channel reads a thread's owner and offers.
 */
const ULID = { type: 'string', minLength: 26, maxLength: 26 };

async function run(request: FastifyRequest, reply: FastifyReply, status: number, fn: (notices: Notice[]) => Promise<unknown>) {
    const notices: Notice[] = [];
    try {
        const body = await asService(request.dbClient!, () => fn(notices));
        request.pendingEvents ??= [];
        for (const n of notices) request.pendingEvents.push({ room: `channel:${n.channelId}`, event: n.eventName ?? 'Message', data: n.event });
        // A refusal whose side effects (an offer marked expired) commit with it
        if (body instanceof HandoffError) return reply.status(body.status).send(body.body);
        return reply.status(status).send(body);
    } catch (e: any) {
        if (e instanceof HandoffError) return reply.status(e.status).send(e.body);
        // Two offers raced for one thread: the partial unique index let one through
        if (e?.code === '23505' && String(e?.constraint ?? '').includes('agent_handoffs_pending')) {
            return reply.status(409).send({ error: 'offer_pending', message: 'This thread already has an open handoff offer; wait for it or cancel it.' });
        }
        throw e;
    }
}

export async function handoffRoutes(app: FastifyInstance) {
    app.get('/channels/:id/threads/:threadId/handoffs', async (request, reply) => {
        const { id: channelId, threadId } = request.params as { id: string; threadId: string };
        if (!(await canViewChannel(request.dbClient!, channelId, request.userId!, !!request.isBot)).allowed) return reply.status(403).send({ error: 'forbidden' });
        return run(request, reply, 200, notices => threadHandoffs(request.dbClient!, channelId, threadId, notices));
    });

    app.post('/channels/:id/handoffs', {
        schema: { body: { type: 'object', additionalProperties: false, required: ['threadId', 'to', 'summary'], properties: {
            threadId: ULID, to: { type: 'string', minLength: 1, maxLength: 64 },
            summary: { type: 'string', minLength: 1, maxLength: 2000, pattern: '\\S' },
            ttlSeconds: { type: 'integer', minimum: 60, maximum: HANDOFF_TTL_MAX },
        } } },
    }, async (request, reply) => {
        const channelId = (request.params as any).id, b = request.body as any;
        if (!request.isBot) return reply.status(403).send({ error: 'live_bot_session_required' });
        if (!(await canViewChannel(request.dbClient!, channelId, request.userId!, true)).allowed) return reply.status(403).send({ error: 'forbidden' });
        return run(request, reply, 201, async notices => ({ offer: await createOffer(request.dbClient!, request.userId!, channelId, b, notices) }));
    });

    app.post('/channels/:id/handoffs/:offerId', {
        schema: { body: { type: 'object', additionalProperties: false, required: ['action'], properties: {
            action: { type: 'string', enum: ['accept', 'decline', 'cancel'] },
            reason: { type: 'string', maxLength: 500 },
        } } },
    }, async (request, reply) => {
        const { id: channelId, offerId } = request.params as { id: string; offerId: string };
        const b = request.body as { action: 'accept' | 'decline' | 'cancel'; reason?: string };
        const db = request.dbClient!, userId = request.userId!, isBot = !!request.isBot;
        if (!(await canViewChannel(db, channelId, userId, isBot)).allowed) return reply.status(403).send({ error: 'forbidden' });
        if (b.action !== 'cancel' && !isBot) return reply.status(403).send({ error: 'not_recipient', message: 'Only the agent the offer names can answer it.' });
        const canDirect = b.action === 'cancel' ? await stampAuthority(db, channelId, userId, isBot) : false;
        return run(request, reply, 200, async notices => {
            if (b.action === 'accept') return acceptOffer(db, userId, channelId, offerId, notices);
            if (b.action === 'decline') return { offer: await declineOffer(db, userId, channelId, offerId, b.reason, notices) };
            return { offer: await cancelOffer(db, userId, isBot, canDirect, channelId, offerId, notices) };
        });
    });
}
