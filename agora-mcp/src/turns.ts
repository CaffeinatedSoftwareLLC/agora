import type { Message } from './api.js';

/**
 * Which threads this agent owes a reply in, from the messages its tools have shown it, so the
 * tools can steer it there instead of trusting the model to follow the skill. Seen on
 * 2026-11-04: Codex read a design-review thread that YIELDed to it, answered at the channel's
 * top level, and stopped; the peer waiting in the thread never saw the answer.
 *
 * A thread is owed when a message the agent was shown, not its own, addresses it there:
 * - an agora-collab protocol post that YIELDs to it, says `[WAIT on=<it>]`, or is a START
 *   listing it as a participant (a top-level protocol post is the root of its own thread);
 * - an @mention of it inside a thread.
 * The agent's own post in the thread, a later protocol post there that YIELDs to someone else,
 * or a DONE / BLOCK / CANCEL settles it. Only what this process has seen counts: the server
 * stays the authority on attention; this is a local guard for the next call.
 */

const HEADER_RE = /^\[AGORA\/v1\s+MODE=([a-z]+)\s+STATE=([A-Z]+)\]/i;
const YIELD_RE = /^\[YIELD\s+to=@?([^\]\s]+)\]$/i;
const WAIT_RE = /^\[WAIT\s+on=@?([^\]\s]+)(?:\s+for=[^\]]*)?\]$/i;
const PARTICIPANTS_RE = /^participants:\s*\[([^\]]*)\]/im;
const FINISHED = new Set(['DONE', 'BLOCK', 'CANCEL']);
// The server's limits (src/lib/protocol.ts): anything else is not a protocol post
const MODES = new Set(['plan', 'review', 'fix', 'discuss']);
const STATES = new Set(['START', 'ACK', 'TURN', 'CHECKPOINT', 'DECIDE', 'DONE', 'BLOCK', 'CANCEL', 'WAIT']);
const MAX_NAME = 64;

export interface ProtocolLine {
    state: string;
    yieldTo?: string;
    waitingOn?: string;
    participants: string[];
}

/** The agora-collab header, last-line YIELD / WAIT and START participants, as the server parses them. */
export function protocolOf(content: string | null | undefined): ProtocolLine | null {
    const lines = (content ?? '').split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    const header = lines.length > 0 ? HEADER_RE.exec(lines[0]) : null;
    if (!header) return null;
    const state = header[2].toUpperCase();
    if (!MODES.has(header[1].toLowerCase()) || !STATES.has(state)) return null;
    const last = lines.length > 1 ? lines[lines.length - 1] : '';
    const name = (n: string | undefined) => (n && n.length <= MAX_NAME ? n : undefined);
    const participants = state !== 'START' ? [] : (PARTICIPANTS_RE.exec(content ?? '')?.[1]
        .split(',').map(n => n.trim().replace(/^@/, '').replace(/^["'`]|["'`]$/g, '')).filter(n => n.length > 0 && n.length <= MAX_NAME)
        .slice(0, 32) ?? []);
    return {
        state,
        yieldTo: name(YIELD_RE.exec(last)?.[1]),
        waitingOn: state === 'WAIT' ? name(WAIT_RE.exec(last)?.[1]) : undefined,
        participants,
    };
}

/** True when `content` @mentions `name` as a word. */
export function mentions(content: string | null | undefined, name: string): boolean {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\w@])@${escaped}(?![\\w-])`, 'i').test(content ?? '');
}

export interface OwedTurn {
    threadId: string;
    /** The message that addressed the agent. */
    messageId: string;
    why: 'yield' | 'wait' | 'start' | 'mention';
}

export class TurnTracker {
    /** channelId → threadId → what is owed there. */
    private owed = new Map<string, Map<string, OwedTurn>>();
    /** Threads where an agora-collab protocol post was seen or sent. */
    private protocolThreads = new Set<string>();
    /** threadId → the newest observed post that owed or settled the turn there. */
    private lastSeen = new Map<string, string>();

    /** Messages a tool showed the agent (or that it posted). `self` is the bot's id and username. */
    observe(channelId: string, messages: readonly Message[], self: { id: string; username: string }): void {
        const me = self.username.toLowerCase();
        for (const m of [...messages].sort((a, b) => a.id.localeCompare(b.id))) {
            if (m.deletedAt) continue;
            const protocol = protocolOf(m.content);
            const threadId = m.threadId ?? (protocol ? m.id : null);
            if (!threadId) continue;
            if (protocol) this.protocolThreads.add(threadId);
            const named = (n?: string) => !!n && n.replace(/^@/, '').toLowerCase() === me;
            // What this post does to the turn: owe it (why), settle it, or nothing
            let why: OwedTurn['why'] | null = null;
            let settles = false;
            if (m.authorId === self.id) settles = true;
            else if (protocol && FINISHED.has(protocol.state)) settles = true;
            else if (protocol && named(protocol.yieldTo)) why = 'yield';
            else if (protocol && named(protocol.waitingOn)) why = 'wait';
            // A START listing the agent asks every participant for an ACK, whoever goes first
            else if (protocol?.state === 'START' && protocol.participants.some(named)) why = 'start';
            // An explicit handoff to someone else outranks a mention in the same post
            else if (protocol && (protocol.yieldTo || protocol.waitingOn)) settles = true;
            else if (m.threadId && mentions(m.content, self.username)) why = 'mention';
            if (!why && !settles) continue;

            // Only the newest post that moved the turn counts: an older page read later (or a
            // parent fetched late) never rolls the state back
            const seen = this.lastSeen.get(threadId);
            if (seen && m.id <= seen) continue;
            this.lastSeen.set(threadId, m.id);
            if (settles) this.settle(channelId, threadId);
            else this.channel(channelId).set(threadId, { threadId, messageId: m.id, why: why! });
        }
    }

    /** The agent posted in `threadId` (or closed it): nothing owed there any more. */
    settle(channelId: string, threadId: string): void {
        this.owed.get(channelId)?.delete(threadId);
    }

    /** The most recent thread in this channel the agent owes a reply in. */
    pending(channelId: string): OwedTurn | undefined {
        const owed = [...(this.owed.get(channelId)?.values() ?? [])];
        return owed.sort((a, b) => b.messageId.localeCompare(a.messageId))[0];
    }

    /** A protocol post was seen or sent in this thread. */
    isProtocolThread(threadId: string): boolean {
        return this.protocolThreads.has(threadId);
    }

    markProtocol(threadId: string): void {
        this.protocolThreads.add(threadId);
    }

    private channel(channelId: string): Map<string, OwedTurn> {
        let map = this.owed.get(channelId);
        if (!map) { map = new Map(); this.owed.set(channelId, map); }
        return map;
    }
}

/** Why a turn is owed, for the refusal text. */
export function owedReason(o: OwedTurn): string {
    switch (o.why) {
        case 'yield': return 'a YIELD to you';
        case 'wait': return 'a WAIT naming you';
        case 'start': return 'a START listing you as a participant';
        case 'mention': return 'an @mention of you';
    }
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** The ULID right after `id`, for a `before=` read that returns `id` itself. */
export function ulidSuccessor(id: string): string {
    const chars = id.trim().toUpperCase().split('');
    for (let i = chars.length - 1; i >= 0; i--) {
        const at = CROCKFORD.indexOf(chars[i]);
        if (at < CROCKFORD.length - 1) { chars[i] = CROCKFORD[at + 1]; return chars.join(''); }
        chars[i] = '0';
    }
    return chars.join('');
}
