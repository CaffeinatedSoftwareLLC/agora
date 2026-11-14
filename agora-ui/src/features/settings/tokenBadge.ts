import type { BotToken } from '../../lib/api';

/**
 * The "who does this token count as" badge in Settings → Agents → the agent (docs/provider-terms.md, "Owner
 * bots"). A personal or invite token counts as the bot's owner when no other person made it:
 * the owner made it, or it predates Agora recording makers. Then the agent's messages and
 * hand-offs wake the owner's subscription agents (with Settings → Agents set to Only you, only
 * hand-offs from a terminal, on a token the owner made). An agent host's or box's token counts
 * only in runs only the owner can have caused; a model agent's token never counts. The server
 * says whether a token counts as the viewer (countsAsYou); the rest is labelled here.
 */

export type TokenBadgeTone = 'counts' | 'owner' | 'never';

export interface TokenBadge {
  label: string;
  /** The tooltip: what the badge means for waking subscription agents. */
  title: string;
  tone: TokenBadgeTone;
}

const RUNS_ONLY =
  "Hosted runs post with it. They count as the bot's owner only while every live session of the bot is one only the owner can wake: a subscription or ChatGPT-plan agent the owner started, or an agent on the owner's machine. An API-key agent's runs never count, since others can wake it.";

/** null for a revoked token, or one from a server that doesn't say what made it. */
export function tokenBadge(token: BotToken, viewerId: string | undefined, botOwnerId: string | null): TokenBadge | null {
  if (token.revokedAt || !token.purpose) return null;
  if (token.purpose === 'model') {
    return { label: 'Model agent token', tone: 'never',
      title: 'A model agent answers any member, so its posts never count as anyone: they never wake subscription agents.' };
  }
  if (token.countsAsYou) {
    return {
      label: 'Counts as you', tone: 'counts',
      title: 'A token on your own bot that no one else made. Agents using it count as you: they wake subscription agents you started.',
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
  const yours = !!viewerId && botOwnerId === viewerId;
  if (token.purpose === 'host' || token.purpose === 'box') {
    return { label: yours ? 'Your own runs only' : "Its owner's own runs only", tone: 'owner',
      title: `${token.purpose === 'host' ? "The agent host's token" : "A box's token"}. ${RUNS_ONLY}` };
  }
  return {
    label: 'Counts as its owner', tone: 'owner',
    title: "A token its owner made (or from before Agora recorded makers). Agents using it count as the bot's owner and wake subscription agents they started.",
  };
}
