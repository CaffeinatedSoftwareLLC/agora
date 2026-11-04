/**
 * Git pkt-lines for the push broker (docs/agent-boxes.md §5.2): a strict parser for the
 * command list at the start of a receive-pack request, the report the edge sends when it
 * refuses a push, and readers for GitHub's report and ref advertisement.
 *
 * pkt-line: 4 hex digits of length (including themselves), then the payload; "0000" is a flush.
 */

export const MAX_PKT_LEN = 65520;
export const MAX_COMMANDS = 50;
/** The command section is small: 50 commands with long refs and the capability list fit easily. */
export const MAX_COMMAND_SECTION = 64 * 1024;
export const ZERO_OID = /^0+$/;

export function pkt(payload: string | Buffer): Buffer {
    const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
    if (body.length + 4 > MAX_PKT_LEN) throw new Error('pkt-line too long');
    return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii'), body]);
}
export const FLUSH = Buffer.from('0000', 'ascii');

/** Capabilities a push may ask for. Anything else is something the edge doesn't understand. */
const ALLOWED_CAPS = new Set(['report-status', 'report-status-v2', 'side-band-64k', 'side-band', 'quiet', 'atomic', 'ofs-delta', 'delete-refs']);
const ALLOWED_CAP_PREFIXES = ['agent=', 'object-format=', 'session-id='];

export interface PushCommand { old: string; new: string; ref: string }
export type CommandParse =
    | { state: 'more' }
    | { state: 'done'; commands: PushCommand[]; capabilities: string[]; consumed: number }
    | { state: 'refused'; reason: string };

/** A ref name a push may write: refs/heads/* or refs/tags/*, by git's check-ref-format rules, never HEAD. */
export function validPushRef(ref: string): boolean {
    if (ref.length > 255 || !/^refs\/(heads|tags)\/./.test(ref)) return false;
    // Printable ASCII only. A push's ref arrives as bytes and a PR's branch as JSON text: with
    // anything else the two could name one branch differently and take different locks (§5.3)
    if (!/^[\x21-\x7e]+$/.test(ref)) return false;
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x20\x7f~^:?*[\\]/.test(ref)) return false;
    if (ref.includes('..') || ref.includes('@{') || ref.includes('//') || ref.endsWith('/') || ref.endsWith('.') || ref === '@') return false;
    for (const part of ref.split('/')) {
        if (part.startsWith('.') || part.endsWith('.lock') || part === 'HEAD') return false;
    }
    return true;
}

/** A branch name as the PR API takes it (`head`, `base`): refs/heads/<name> must be valid. */
export const validBranch = (name: unknown): name is string => typeof name === 'string' && name.length <= 200 && validPushRef(`refs/heads/${name}`);

const OID = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Parse the command list from the start of a receive-pack body. Call with the bytes received
 * so far; 'more' asks for more. Every refusal in §5.2 is here: malformed or oversized
 * pkt-lines, more than MAX_COMMANDS, refs outside refs/heads and refs/tags, HEAD, push-options,
 * push-cert, shallow lines, the v2 protocol (delim packets, `command=`), duplicate refs.
 */
export function parseCommands(buf: Buffer): CommandParse {
    const commands: PushCommand[] = [];
    let capabilities: string[] = [];
    const refs = new Set<string>();
    let pos = 0;
    while (true) {
        if (pos > MAX_COMMAND_SECTION) return { state: 'refused', reason: 'command list too long' };
        if (buf.length < pos + 4) return buf.length > MAX_COMMAND_SECTION ? { state: 'refused', reason: 'command list too long' } : { state: 'more' };
        const head = buf.subarray(pos, pos + 4).toString('latin1');
        if (!/^[0-9a-f]{4}$/.test(head)) return { state: 'refused', reason: 'malformed pkt-line' };
        const len = parseInt(head, 16);
        if (len === 0) {
            if (commands.length === 0) return { state: 'refused', reason: 'empty command list' };
            return { state: 'done', commands, capabilities, consumed: pos + 4 };
        }
        if (len === 1 || len === 2) return { state: 'refused', reason: 'protocol v2 is not supported for pushes' };
        if (len < 5 || len > MAX_PKT_LEN) return { state: 'refused', reason: 'malformed pkt-line' };
        if (pos + len > MAX_COMMAND_SECTION) return { state: 'refused', reason: 'command list too long' };
        if (buf.length < pos + len) return { state: 'more' };
        let line = buf.subarray(pos + 4, pos + len).toString('latin1');
        pos += len;
        if (line.endsWith('\n')) line = line.slice(0, -1);

        if (commands.length === 0) {
            const nul = line.indexOf('\0');
            if (nul >= 0) {
                capabilities = line.slice(nul + 1).split(' ').filter(Boolean);
                line = line.slice(0, nul);
            }
            if (line.startsWith('push-cert')) return { state: 'refused', reason: 'signed pushes (push-cert) are not supported' };
            if (line.startsWith('shallow ')) return { state: 'refused', reason: 'pushing from a shallow clone is not supported' };
            if (line.startsWith('version ') || line.startsWith('command=')) return { state: 'refused', reason: 'protocol v2 is not supported for pushes' };
            for (const cap of capabilities) {
                if (cap === 'push-options') return { state: 'refused', reason: 'push options are not supported' };
                if (cap.startsWith('push-cert')) return { state: 'refused', reason: 'signed pushes (push-cert) are not supported' };
                if (!ALLOWED_CAPS.has(cap) && !ALLOWED_CAP_PREFIXES.some(p => cap.startsWith(p))) return { state: 'refused', reason: `unsupported capability ${cap.slice(0, 40)}` };
            }
        } else if (line.includes('\0')) {
            return { state: 'refused', reason: 'malformed command' };
        }

        const parts = line.split(' ');
        if (parts.length !== 3) return { state: 'refused', reason: 'malformed command' };
        const [oldOid, newOid, ref] = parts;
        if (!OID.test(oldOid) || !OID.test(newOid) || oldOid.length !== newOid.length) return { state: 'refused', reason: 'malformed command' };
        if (ZERO_OID.test(oldOid) && ZERO_OID.test(newOid)) return { state: 'refused', reason: 'malformed command' };
        if (ref === 'HEAD' || !validPushRef(ref)) return { state: 'refused', reason: `ref ${ref.slice(0, 80)} can't be pushed through the edge` };
        if (refs.has(ref)) return { state: 'refused', reason: `duplicate ref ${ref.slice(0, 80)}` };
        refs.add(ref);
        commands.push({ old: oldOid, new: newOid, ref });
        if (commands.length > MAX_COMMANDS) return { state: 'refused', reason: `more than ${MAX_COMMANDS} refs in one push` };
    }
}

export const sortCommands = (commands: PushCommand[]) => [...commands].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));

export function sidebandOf(capabilities: string[]): 'side-band-64k' | 'side-band' | null {
    if (capabilities.includes('side-band-64k')) return 'side-band-64k';
    if (capabilities.includes('side-band')) return 'side-band';
    return null;
}

/**
 * A receive-pack report refusing every ref: `unpack ok`, then `ng <ref> <reason>`, in a
 * side-band (band 1) envelope when the client asked for one. `message` goes to band 2, which
 * git prints as `remote: …`.
 */
export function refusalReport(refs: string[], reason: string, sideband: 'side-band-64k' | 'side-band' | null, message?: string): Buffer {
    const clean = reason.replace(/[\r\n\0]/g, ' ');
    const report = Buffer.concat([pkt('unpack ok\n'), ...refs.map(r => pkt(`ng ${r} ${clean}\n`)), FLUSH]);
    if (!sideband) return report;
    const max = (sideband === 'side-band-64k' ? MAX_PKT_LEN : 1000) - 5;
    const out: Buffer[] = [];
    if (message) out.push(pkt(Buffer.concat([Buffer.from([2]), Buffer.from(`${message.replace(/[\r\n\0]/g, ' ')}\n`, 'utf8')])));
    for (let i = 0; i < report.length; i += max) out.push(pkt(Buffer.concat([Buffer.from([1]), report.subarray(i, i + max)])));
    out.push(FLUSH);
    return Buffer.concat(out);
}

/** Read consecutive pkt-lines; returns the payloads (null for a flush) and whether the buffer ended cleanly. */
export function readPkts(buf: Buffer): { pkts: (Buffer | null)[]; rest: number; error: boolean } {
    const pkts: (Buffer | null)[] = [];
    let pos = 0;
    while (buf.length >= pos + 4) {
        const head = buf.subarray(pos, pos + 4).toString('latin1');
        if (!/^[0-9a-f]{4}$/.test(head)) return { pkts, rest: pos, error: true };
        const len = parseInt(head, 16);
        if (len === 0) { pkts.push(null); pos += 4; continue; }
        if (len < 4 || len > MAX_PKT_LEN) {
            // 0001/0002 (delim, response-end) carry nothing for us
            if (len === 1 || len === 2) { pos += 4; continue; }
            return { pkts, rest: pos, error: true };
        }
        if (buf.length < pos + len) break;
        pkts.push(buf.subarray(pos + 4, pos + len));
        pos += len;
    }
    return { pkts, rest: pos, error: false };
}

export interface PushReport { unpackOk: boolean; ok: Set<string>; ng: Map<string, string> }

/**
 * Parse GitHub's receive-pack response: plain report-status, or band 1 of a side-band stream.
 * Returns null if it isn't a complete, well-formed report.
 */
export function parseReport(body: Buffer, sideband: boolean): PushReport | null {
    let report = body;
    if (sideband) {
        const { pkts, error } = readPkts(body);
        if (error) return null;
        const band1: Buffer[] = [];
        for (const p of pkts) {
            if (p === null) continue;
            if (p[0] === 1) band1.push(p.subarray(1));
            else if (p[0] === 3) return null; // fatal error from the remote
        }
        report = Buffer.concat(band1);
    }
    const { pkts, error } = readPkts(report);
    if (error || pkts.length === 0 || pkts[pkts.length - 1] !== null) return null;
    const lines = pkts.filter((p): p is Buffer => p !== null).map(p => p.toString('utf8').replace(/\n$/, ''));
    if (lines.length === 0 || !lines[0].startsWith('unpack ')) return null;
    const out: PushReport = { unpackOk: lines[0] === 'unpack ok', ok: new Set(), ng: new Map() };
    for (const line of lines.slice(1)) {
        if (line.startsWith('ok ')) out.ok.add(line.slice(3));
        else if (line.startsWith('ng ')) {
            const rest = line.slice(3); const sp = rest.indexOf(' ');
            out.ng.set(sp < 0 ? rest : rest.slice(0, sp), sp < 0 ? '' : rest.slice(sp + 1));
        } else if (line.startsWith('option ')) continue; // report-status-v2 detail
        else return null;
    }
    return out;
}

/** Refs from a smart-HTTP v0 advertisement (`info/refs?service=…`); peeled `^{}` entries skipped. */
export function parseAdvertisement(body: Buffer): Map<string, string> | null {
    const { pkts, error } = readPkts(body);
    if (error) return null;
    const refs = new Map<string, string>();
    let sawService = false;
    for (const p of pkts) {
        if (p === null) continue;
        let line = p.toString('utf8').replace(/\n$/, '');
        if (!sawService && line.startsWith('# service=')) { sawService = true; continue; }
        const nul = line.indexOf('\0');
        if (nul >= 0) line = line.slice(0, nul);
        const m = /^([0-9a-f]{40}|[0-9a-f]{64}) (\S+)$/.exec(line);
        if (!m) return null;
        if (m[2].endsWith('^{}') || m[2] === 'capabilities^{}') continue;
        refs.set(m[2], m[1]);
    }
    return refs;
}
