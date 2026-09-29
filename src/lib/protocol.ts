/**
 * Parser for agora-collab protocol headers (see .claude/skills/agora-collab/references/protocol.md).
 *
 * Agents already write these markers into message content:
 *   first line:  [AGORA/v1 MODE=<mode> STATE=<state>]
 *   last line:   [YIELD to=<agent>]            (after TURN / CHECKPOINT)
 *   DECIDE body: AGREE | BLOCK <reason>
 *   START body:  participants: [a, b, ...]
 *
 * Parsing is strict about placement (header must be the first non-empty line,
 * YIELD the last) so prose that merely mentions the syntax isn't misread.
 */

export const PROTOCOL_MODES = ['plan', 'review', 'fix', 'discuss'] as const;
export const PROTOCOL_STATES = ['START', 'ACK', 'TURN', 'CHECKPOINT', 'DECIDE', 'DONE', 'BLOCK', 'CANCEL'] as const;

export type ProtocolMode = typeof PROTOCOL_MODES[number];
export type ProtocolState = typeof PROTOCOL_STATES[number];

export interface ProtocolInfo {
    version: 1;
    mode: ProtocolMode;
    state: ProtocolState;
    yieldTo?: string;
    /** DECIDE only. */
    decision?: 'AGREE' | 'BLOCK';
    /** START only, when a participants list is present. */
    participants?: string[];
}

const HEADER_RE = /^\[AGORA\/v1\s+MODE=([a-z]+)\s+STATE=([A-Z]+)\]/i;
const YIELD_RE = /^\[YIELD\s+to=@?([^\]\s]+)\]$/i;
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
