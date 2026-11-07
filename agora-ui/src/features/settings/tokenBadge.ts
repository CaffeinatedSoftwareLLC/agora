import type { BotToken } from '../../lib/api';

/**
 * The "who does this token count as" badge in Settings → Bots (docs/provider-terms.md, "Which
 * tokens count as you"). A terminal agent's hand-offs wake the owner's subscription agents only
 * when its token is a live personal or invite token the bot's owner made. The server says
 * whether that is the viewer (countsAsYou); the rest is labelled from purpose and maker.
 */

export type TokenBadgeTone = 'counts' | 'maker' | 'never' | 'unknown';

export interface TokenBadge {
  label: string;
  /** The tooltip: what the badge means for hand-offs. */
  title: string;
  tone: TokenBadgeTone;
  /** The viewer owns the bot and may claim this legacy personal token. */
  claimable: boolean;
}

export const UNKNOWN_MAKER = 'Unknown maker (made before Agora recorded token makers)';
export const MAKER_DELETED = "Maker's account was deleted";

export const CLAIM_WARNING =
  'Only claim a token you created yourself and that only your own terminal uses: not one pasted into an agora-host config (botTokens), a CI job, or given to anyone else. Whoever holds it can wake your subscription agents.';

/** The claim dialog's description of the token: name, when it was made, the client that last used it. */
export function claimTokenSummary(token: BotToken): string {
  const parts = [`Made ${new Date(token.createdAt).toLocaleDateString()}`];
  parts.push(token.lastUsedClient ? `last used by ${token.lastUsedClient}` : token.lastUsedAt ? 'last used by an unnamed client' : 'never used');
  return `"${token.name || 'Unnamed'}": ${parts.join(', ')}.`;
}

const NEVER: Record<'host' | 'box' | 'model', TokenBadge> = {
  host: {
    label: 'Agora host token', tone: 'never', claimable: false,
    title: "Made with an agent for its host's config, which every hosted run gets. It never counts as anyone, so its hand-offs never wake subscription agents.",
  },
  box: {
    label: 'Box token', tone: 'never', claimable: false,
    title: "An agent box's token. It never counts as anyone, so its hand-offs never wake subscription agents.",
  },
  model: {
    label: 'Model agent token', tone: 'never', claimable: false,
    title: "A model agent's server-side token. It never counts as anyone, so its hand-offs never wake subscription agents.",
  },
};

/** null for a revoked token, or one from a server that doesn't say what made it. */
export function tokenBadge(token: BotToken, viewerId: string | undefined, botOwnerId: string | null): TokenBadge | null {
  if (token.revokedAt || !token.purpose) return null;
  if (token.purpose === 'host' || token.purpose === 'box' || token.purpose === 'model') return NEVER[token.purpose];
  const yourBot = !!viewerId && botOwnerId === viewerId;
  if (token.countsAsYou) {
    return {
      label: 'Counts as you', tone: 'counts', claimable: false,
      title: 'You made this token for your own bot. A terminal agent using it counts as you: its hand-offs wake subscription agents you started.',
    };
  }
  if (!token.createdBy && !token.madeBeforeMakers) {
    return {
      label: MAKER_DELETED, tone: 'never', claimable: false,
      title: 'The person who made it deleted their account, so it counts as no one and nobody can claim it. Revoke it and make a new token.',
    };
  }
  if (!token.createdBy) {
    const claimable = token.purpose === 'personal' && yourBot;
    return {
      label: UNKNOWN_MAKER, tone: 'unknown', claimable,
      title: token.purpose === 'invite'
        ? 'Made from an agent invite before Agora recorded token makers. It counts as no one; make a new token if a terminal agent should count as you.'
        : claimable
          ? 'Made before Agora recorded token makers, so it counts as no one. If you made it yourself, claim it.'
          : "Made before Agora recorded token makers, so it counts as no one. Only the bot's owner can claim it.",
    };
  }
  if (token.createdBy === viewerId) {
    return {
      label: 'Made by you', tone: 'maker', claimable: false,
      title: "You made it, but this bot isn't yours, so it doesn't count as you.",
    };
  }
  return {
    label: `Made by ${token.createdByName ?? 'someone else'}`, tone: 'maker', claimable: false,
    title: token.createdBy === botOwnerId
      ? 'Its maker owns this bot: a terminal agent using it counts as them, and its hand-offs can wake subscription agents they started.'
      : "Made by someone other than the bot's owner, so it counts as no one: its hand-offs don't wake subscription agents.",
  };
}
