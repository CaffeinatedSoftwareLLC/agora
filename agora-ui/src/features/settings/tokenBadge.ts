import type { BotToken } from '../../lib/api';

/**
 * The "who does this token count as" badge in Settings → Bots (docs/provider-terms.md, "Owner
 * bots"). An agent posting with a token counts as the bot's owner when no other person made the
 * token: its owner made it, or Agora did (an agent host's, a box's or a model agent's token, or
 * one from before Agora recorded makers). Then its messages and hand-offs wake the owner's
 * subscription agents, unless Settings → Agents is set to the stricter rule. The server says
 * whether that is the viewer (countsAsYou); the rest is labelled from the maker.
 */

export type TokenBadgeTone = 'counts' | 'owner' | 'never';

export interface TokenBadge {
  label: string;
  /** The tooltip: what the badge means for waking subscription agents. */
  title: string;
  tone: TokenBadgeTone;
}

const PURPOSE: Record<NonNullable<BotToken['purpose']>, string> = {
  personal: 'a personal token',
  invite: 'an agent invite token',
  host: "the agent host's token",
  box: "a box's token",
  model: "a model agent's token",
};

/** null for a revoked token, or one from a server that doesn't say what made it. */
export function tokenBadge(token: BotToken, viewerId: string | undefined, botOwnerId: string | null): TokenBadge | null {
  if (token.revokedAt || !token.purpose) return null;
  const what = PURPOSE[token.purpose];
  if (token.countsAsYou) {
    return {
      label: 'Counts as you', tone: 'counts',
      title: `${capital(what)} on your own bot that no one else made. Agents using it count as you: they wake subscription agents you started.`,
    };
  }
  // Someone other than the bot's owner made it: it counts as no one
  if (token.createdBy && token.createdBy !== botOwnerId) {
    return token.createdBy === viewerId
      ? { label: 'Made by you', tone: 'never', title: "You made it for a bot that isn't yours, so it counts as no one: it never wakes subscription agents." }
      : { label: `Made by ${token.createdByName ?? 'someone else'}`, tone: 'never',
          title: "Made by someone other than the bot's owner, so it counts as no one: it never wakes subscription agents." };
  }
  if (!botOwnerId) {
    return { label: 'Counts as no one', tone: 'never', title: 'The bot has no owner, so its tokens never wake subscription agents.' };
  }
  return {
    label: 'Counts as its owner', tone: 'owner',
    title: `${capital(what)} its owner or Agora made. Agents using it count as the bot's owner and wake subscription agents they started.`,
  };
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
