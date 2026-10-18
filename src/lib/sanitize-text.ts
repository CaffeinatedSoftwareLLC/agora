/**
 * Clean message text before it is stored (#88). Agents relay each other's text, often
 * straight from a terminal, so it can carry:
 *
 * - ANSI/VT escape sequences (colours, cursor moves, OSC 8 links, OSC 52 clipboard
 *   writes, window titles) that a terminal reading the message back would execute;
 * - private keys pasted from a tool's output, which every agent in the channel and the
 *   next agent run would then read.
 *
 * Escape sequences are removed; a private-key block becomes a marker. Ordinary text,
 * tabs and line breaks are left alone. Applied on the server so every client (web UI,
 * agora-mcp, the host, sandboxed runs) gets the same treatment.
 */

export const REDACTED_PRIVATE_KEY = '[private key redacted]';

const ESC = '\\u001b';
const BEL = '\\u0007';
const C1_CSI = '\\u009b';
const C1_OSC = '\\u009d';
const C1_ST = '\\u009c';

// OSC / DCS / SOS / PM / APC strings: ESC ] … (BEL | ESC \ | ST). An unterminated string
// runs to the end of the text, as a terminal would swallow it.
const STRING_SEQ = `(?:${ESC}[\\]PX^_]|${C1_OSC}|\\u0090|\\u0098|\\u009e|\\u009f)[\\s\\S]*?(?:${BEL}|${ESC}\\\\|${C1_ST}|$)`;
// CSI: ESC [ (or the C1 byte) parameters, intermediates, one final byte
const CSI_SEQ = `(?:${ESC}\\[|${C1_CSI})[0-?]*[ -/]*[@-~]?`;
// Two- and three-byte escapes: ESC ( B, ESC 7, ESC = …
const SHORT_SEQ = `${ESC}[ -/]*[0-~]?`;

const ESCAPES = new RegExp(`${STRING_SEQ}|${CSI_SEQ}|${SHORT_SEQ}`, 'g');

// PEM and PGP private keys: "-----BEGIN [RSA |EC |OPENSSH |ENCRYPTED |DSA ]PRIVATE KEY-----"
// and "-----BEGIN PGP PRIVATE KEY BLOCK-----". A block cut off before its END line is
// redacted to the end of the text: the half that's there is still secret.
const PRIVATE_KEY = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?)-----[\s\S]*?(?:-----END \1-----|$)/g;

export function stripEscapes(text: string): string {
    return text.replace(ESCAPES, '');
}

export function redactPrivateKeys(text: string): string {
    return text.replace(PRIVATE_KEY, REDACTED_PRIVATE_KEY);
}

/** Escapes first, so colour codes inside a key block can't hide its BEGIN/END lines. */
export function sanitizeMessageText(text: string): string {
    return redactPrivateKeys(stripEscapes(text));
}
