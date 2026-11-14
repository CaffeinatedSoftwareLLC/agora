import { asService } from './agent-sessions';
import { stampAuthority } from './direct-agents';
import { ownerBotOf, serverSubscriptionWakes } from './provider-terms';

/**
 * Owner bots and directing authority (docs/provider-terms.md, "Counts as you").
 *
 * A bot whose post counts as person X (ownerBotOf: X's own bot, on a token nobody else made, not
 * a model agent, no mixed terminal) has X's authority to direct agents for that post: it may
 * address every agent X could address by typing the same message (X is the server owner or holds
 * DirectAgents here). Whether a plan-owned agent actually runs is still the plan-owner rule's
 * call (termsAllow in agent-sessions.ts, recheckRows in agent-runs.ts).
 *
 * The message keeps its own stamp: messages.author_could_direct stays false, so agents are
 * never shown [OWNER] or [DIRECTOR] for it. The host tags it [OWNER'S BOT] instead (ownerBot on
 * the claim's inbox item).
 *
 * Needs the service role (ownerBotOf and stampAuthority read agent and role tables).
 */
export interface CountingBot {
    /** The person the bot's posts count as. */
    personId: string;
    /** That person could direct agents in the channel when asked. */
    personCanDirect: boolean;
}

export async function countingBot(db: any, input: { botId: string; tokenId: string | null | undefined; channelId: string }): Promise<CountingBot | null> {
    if (!input.tokenId) return null;
    const server = (await db.query('SELECT server_id FROM channels WHERE id = $1', [input.channelId])).rows[0];
    if (!server || await serverSubscriptionWakes(db, server.server_id.trim()) !== 'owner_bots') return null;
    const personId = await ownerBotOf(db, input);
    if (!personId) return null;
    return { personId, personCanDirect: await stampAuthority(db, input.channelId, personId, false) };
}

/**
 * May this caller direct agents here: its own authority (stampAuthority), or, for a bot, that of
 * the person its token counts as. `actor` is who the action is done as: the bot itself, or the
 * person whose bot it is (their authority and, for a session start or resume, their name on
 * the session: a start by a counting bot is the person's own start).
 */
export async function directingActor(db: any, input: { channelId: string; userId: string; isBot: boolean; tokenId: string | null | undefined }):
    Promise<{ actorId: string; asBotOf: string | null } | null> {
    if (await stampAuthority(db, input.channelId, input.userId, input.isBot)) return { actorId: input.userId, asBotOf: null };
    if (!input.isBot) return null;
    const counting = await asService(db, () => countingBot(db, { botId: input.userId, tokenId: input.tokenId, channelId: input.channelId }));
    return counting?.personCanDirect ? { actorId: counting.personId, asBotOf: counting.personId } : null;
}
