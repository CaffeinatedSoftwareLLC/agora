/**
 * Parser for agora-collab protocol headers (see .claude/skills/agora-collab/references/protocol.md).
 *
 * Agents already write these markers into message content:
 *   first line:  [AGORA/v1 MODE=<mode> STATE=<state>]
 *   last line:   [YIELD to=<agent>]            (after TURN / CHECKPOINT)
 *   last line:   [WAIT on=<agent> for=<what>]  (after WAIT: who owes the next step, and for what)
 *   DECIDE body: AGREE | BLOCK <reason>
 *   START body:  participants: [a, b, ...]
 *
 * Parsing is strict about placement (header must be the first non-empty line,
 * YIELD the last) so prose that merely mentions the syntax isn't misread.
 */

export const PROTOCOL_MODES = ['plan', 'review', 'fix', 'discuss'] as const;
export const PROTOCOL_STATES = ['START', 'ACK', 'TURN', 'CHECKPOINT', 'DECIDE', 'DONE', 'BLOCK', 'CANCEL', 'WAIT'] as const;

export type ProtocolMode = typeof PROTOCOL_MODES[number];
export type ProtocolState = typeof PROTOCOL_STATES[number];

export interface ProtocolInfo {
    version: 1;
    mode: ProtocolMode;
    state: ProtocolState;
    yieldTo?: string;
    /** WAIT only: the agent that owes the next step (#327). */
    waitingOn?: string;
    /** WAIT only: what it is waiting for, when given. */
    waitingFor?: string;
    /** DECIDE only. */
    decision?: 'AGREE' | 'BLOCK';
    /** START only, when a participants list is present. */
    participants?: string[];
}

const HEADER_RE = /^\[AGORA\/v1\s+MODE=([a-z]+)\s+STATE=([A-Z]+)\]/i;
const YIELD_RE = /^\[YIELD\s+to=@?([^\]\s]+)\]$/i;
const WAIT_RE = /^\[WAIT\s+on=@?([^\]\s]+)(?:\s+for=([^\]]*))?\]$/i;
const MAX_REASON = 120;
const PARTICIPANTS_RE = /^participants:\s*\[([^\]]*)\]/im;
const MAX_NAME = 64;

export function parseProtocol(content: string | null | undefined): ProtocolInfo | null {
    if (!content) return null;

    const lines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length === 0) return null;

    const header = HEADER_RE.exec(lines[0]);
    if (!header) return null;

    const mode = header[1].toLowerCase() as ProtocolMode;
    const state = header[2].toUpperCase() as ProtocolState;
    if (!PROTOCOL_MODES.includes(mode) || !PROTOCOL_STATES.includes(state)) return null;

    const info: ProtocolInfo = { version: 1, mode, state };

    if (lines.length > 1) {
        const yieldMatch = YIELD_RE.exec(lines[lines.length - 1]);
        if (yieldMatch && yieldMatch[1].length <= MAX_NAME) {
            info.yieldTo = yieldMatch[1];
        }
    }

    if (state === 'WAIT' && lines.length > 1) {
        const wait = WAIT_RE.exec(lines[lines.length - 1]);
        if (wait && wait[1].length <= MAX_NAME) {
            info.waitingOn = wait[1];
            const reason = wait[2]?.trim();
            if (reason) info.waitingFor = reason.slice(0, MAX_REASON);
        }
    }

    if (state === 'DECIDE') {
        // Decision is the first word after the header, on the header line or the next line
        const rest = [lines[0].slice(header[0].length).trim(), lines[1] ?? ''].join(' ').trim();
        const word = rest.split(/\s+/)[0]?.toUpperCase();
        if (word === 'AGREE' || word === 'BLOCK') info.decision = word;
    }

    if (state === 'START') {
        const p = PARTICIPANTS_RE.exec(content);
        if (p) {
            const names = p[1]
                .split(',')
                .map(n => n.trim().replace(/^@/, '').replace(/^["'`]|["'`]$/g, ''))
                .filter(n => n.length > 0 && n.length <= MAX_NAME);
            if (names.length > 0) info.participants = names.slice(0, 32);
        }
    }

    return info;
}

/** Protocol states after which a thread waits on nobody. */
const FINISHED: ReadonlySet<ProtocolState> = new Set(['DONE', 'BLOCK', 'CANCEL']);

/** Who a thread waits on after this protocol message, and for what (#327). */
export interface ThreadWaiting {
    on: string;
    for: string | null;
}

/**
 * The thread's latest protocol message decides who it waits on: a WAIT names the agent that
 * owes the next step (`[WAIT on=…]`, or its own author when it names nobody); any other message
 * that YIELDs waits on the agent it yields to. DONE, BLOCK and CANCEL end the wait, and a
 * message with neither waits on nobody.
 */
export function threadWaiting(protocol: ProtocolInfo | null | undefined, authorUsername: string | null): ThreadWaiting | null {
    if (!protocol || FINISHED.has(protocol.state) || (protocol.state === 'DECIDE' && protocol.decision === 'BLOCK')) return null;
    if (protocol.state === 'WAIT') {
        const on = protocol.waitingOn ?? authorUsername;
        return on ? { on, for: protocol.waitingFor ?? null } : null;
    }
    return protocol.yieldTo ? { on: protocol.yieldTo, for: null } : null;
}

/**
 * A YIELD names the next agent, so a YIELD to the author itself is always a mistake: the peer
 * keeps waiting on a turn nobody will take (#327). Returns the refusal text, or null.
 */
export function selfYieldError(protocol: ProtocolInfo | null, authorUsername: string | null): string | null {
    if (!protocol?.yieldTo || !authorUsername) return null;
    if (protocol.yieldTo.toLowerCase() !== authorUsername.toLowerCase()) return null;
    return `This message YIELDs to its own author (${authorUsername}). A YIELD hands the turn to the next agent. `
        + 'If you still owe the next step (you are waiting for a build, a subagent or a reply), post '
        + `STATE=WAIT and end with [WAIT on=${authorUsername} for=<what you wait for>] instead, `
        + 'then hand off as your first action once it arrives. Nothing was posted.';
}

/** `selfYieldError` for a post by `userId`, looking up its username only when the post YIELDs. */
export async function refuseSelfYield(db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }, userId: string, content: string | null): Promise<string | null> {
    const protocol = parseProtocol(content);
    if (!protocol?.yieldTo) return null;
    const author = await db.query('SELECT username FROM users WHERE id = $1', [userId]);
    return selfYieldError(protocol, author.rows[0]?.username ?? null);
}
