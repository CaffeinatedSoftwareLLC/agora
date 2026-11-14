import { asService } from './agent-sessions';
import { stampAuthority } from './direct-agents';
import { actsAsOwner, ownerBotOf, serverSubscriptionWakes } from './provider-terms';

/**
 * Owner bots and directing authority (docs/provider-terms.md, "Counts as you").
 *
 * Two things hold for a bot whose post counts as its owner (ownerBotOf: the owner's own bot, on a
 * token nobody else made, not a model agent, no mixed terminal):
 * - it may wake the owner's plan-owned agents (the main rule, agent-sessions.ts termsAllow);
 * - NEW, narrower: it acts with the owner's authority (this file). Only for a post on a PERSONAL
 *   token the bot's owner made (not an agent host's, a box's or an invite token: an invite code can
 *   be redeemed by someone else), and only while the bot's own switch is on
 *   (users.bot_acts_as_owner, migration 102, default on). It may then direct every agent its
 *   owner could direct (the owner is the server owner or holds DirectAgents there) without
 *   can_direct, and start, end, resume and wake them as the owner. Budgets and CLI commands stay
 *   with the person.
 *
 * The message keeps its own stamp: messages.author_could_direct stays false, so agents are never
 * shown [OWNER] or [DIRECTOR] for it; the claim marks ownerBotDirect and the host tags it
 * [OWNER'S BOT].
 *
 * Needs the service role (reads agent, token and role tables).
 */
export interface CountingBot {
    /** The person the bot's posts count as. */
    personId: string;
    /** That person could direct agents in the channel when asked. */
    personCanDirect: boolean;
}

/** The person this post acts as, with the new authority; null when it doesn't (or the person can't direct here). */
export async function countingBot(db: any, input: { botId: string; tokenId: string | null | undefined; channelId: string }): Promise<CountingBot | null> {
    if (!input.tokenId) return null;
    const server = (await db.query('SELECT server_id FROM channels WHERE id = $1', [input.channelId])).rows[0];
    if (!server || await serverSubscriptionWakes(db, server.server_id.trim()) !== 'owner_bots') return null;
    const personId = await ownerBotOf(db, input);
    if (!personId || !await actsAsOwner(db, { botId: input.botId, tokenId: input.tokenId, personId })) return null;
    return { personId, personCanDirect: await stampAuthority(db, input.channelId, personId, false) };
}

/**
 * May this caller direct agents here: its own authority (stampAuthority), or, for a bot, that of
 * the person it acts as. `actorId` is who the action is done as.
 */
export async function directingActor(db: any, input: { channelId: string; userId: string; isBot: boolean; tokenId: string | null | undefined }):
    Promise<{ actorId: string; asBotOf: string | null } | null> {
    if (await stampAuthority(db, input.channelId, input.userId, input.isBot)) return { actorId: input.userId, asBotOf: null };
    if (!input.isBot) return null;
    const counting = await asService(db, () => countingBot(db, { botId: input.userId, tokenId: input.tokenId, channelId: input.channelId }));
    return counting?.personCanDirect ? { actorId: counting.personId, asBotOf: counting.personId } : null;
}
