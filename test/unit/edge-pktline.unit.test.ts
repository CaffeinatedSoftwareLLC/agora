import {
    FLUSH, MAX_COMMANDS, parseAdvertisement, parseCommands, parseReport, pkt, readPkts, refusalReport, sidebandOf, validPushRef,
} from '../../src/boxes/edge/pktline';

/** docs/agent-boxes.md §5.2: the push broker's strict command-list parser and its report. */

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const Z = '0'.repeat(40);

function body(lines: string[], caps = 'report-status side-band-64k agent=git/2.43.0', tail: Buffer = Buffer.from('PACK....')): Buffer {
    return Buffer.concat([
        ...lines.map((l, i) => pkt(i === 0 ? `${l}\0${caps}\n` : `${l}\n`)),
        FLUSH, tail,
    ]);
}

function refused(buf: Buffer): string {
    const r = parseCommands(buf);
    if (r.state !== 'refused') throw new Error(`expected refusal, got ${r.state}`);
    return r.reason;
}

describe('parseCommands', () => {
    it('parses a well-formed command list and reports how much it consumed', () => {
        const buf = body([`${A} ${B} refs/heads/feature`, `${Z} ${B} refs/tags/v1`]);
        const r = parseCommands(buf);
        expect(r.state).toBe('done');
        if (r.state !== 'done') return;
        expect(r.commands).toEqual([{ old: A, new: B, ref: 'refs/heads/feature' }, { old: Z, new: B, ref: 'refs/tags/v1' }]);
        expect(r.capabilities).toContain('side-band-64k');
        expect(buf.subarray(r.consumed).toString()).toBe('PACK....');
    });

    it('asks for more until the flush arrives', () => {
        const buf = body([`${A} ${B} refs/heads/x`]);
        expect(parseCommands(buf.subarray(0, 10)).state).toBe('more');
        expect(parseCommands(buf.subarray(0, buf.length - 12)).state).toBe('more');
    });

    it('accepts sha256 object ids', () => {
        const r = parseCommands(body([`${'c'.repeat(64)} ${'d'.repeat(64)} refs/heads/x`], 'report-status object-format=sha256'));
        expect(r.state).toBe('done');
    });

    it('refuses malformed pkt-lines', () => {
        expect(refused(Buffer.from('zzzz'))).toMatch(/malformed/);
        expect(refused(Buffer.from('0003'))).toMatch(/malformed/);
        expect(refused(Buffer.from('0004'))).toMatch(/malformed/);
    });

    it('refuses an oversized pkt-line', () => {
        expect(refused(Buffer.from('fff5'))).toMatch(/malformed/);
    });

    it('refuses an oversized command section', () => {
        const big = Buffer.concat(Array.from({ length: 10 }, () => pkt(`${A} ${B} refs/heads/${'x'.repeat(200)}\n`)));
        // Not over the limit yet: keep feeding long lines with no flush
        const many = Buffer.concat(Array.from({ length: 30 }, () => big));
        expect(refused(many)).toMatch(/too long|more than|duplicate/);
    });

    it(`refuses more than ${MAX_COMMANDS} commands`, () => {
        const lines = Array.from({ length: MAX_COMMANDS + 1 }, (_, i) => `${A} ${B} refs/heads/b${i}`);
        expect(refused(body(lines))).toMatch(/more than 50/);
        expect(parseCommands(body(lines.slice(0, MAX_COMMANDS))).state).toBe('done');
    });

    it('refuses refs outside refs/heads and refs/tags', () => {
        expect(refused(body([`${A} ${B} refs/notes/x`]))).toMatch(/can't be pushed/);
        expect(refused(body([`${A} ${B} refs/pull/1/head`]))).toMatch(/can't be pushed/);
        expect(refused(body([`${A} ${B} refs/heads/../config`]))).toMatch(/can't be pushed/);
    });

    it('refuses HEAD and symbolic-looking refs', () => {
        expect(refused(body([`${A} ${B} HEAD`]))).toMatch(/can't be pushed/);
        expect(refused(body([`${A} ${B} refs/heads/HEAD`]))).toMatch(/can't be pushed/);
    });

    it('refuses push-options', () => {
        expect(refused(body([`${A} ${B} refs/heads/x`], 'report-status push-options'))).toMatch(/push options/);
    });

    it('refuses push-cert', () => {
        expect(refused(Buffer.concat([pkt('push-cert\0report-status\n'), pkt('certificate version 0.1\n')]))).toMatch(/push-cert/);
        expect(refused(body([`${A} ${B} refs/heads/x`], 'report-status push-cert=123'))).toMatch(/push-cert/);
    });

    it('refuses the v2 protocol', () => {
        expect(refused(Buffer.concat([pkt('command=ls-refs\n'), Buffer.from('0001')]))).toMatch(/v2/);
        expect(refused(Buffer.concat([pkt('version 2\n')]))).toMatch(/v2/);
        expect(refused(Buffer.from('0001'))).toMatch(/v2/);
    });

    it('refuses a duplicate ref', () => {
        expect(refused(body([`${A} ${B} refs/heads/x`, `${B} ${A} refs/heads/x`]))).toMatch(/duplicate/);
    });

    it('refuses unknown capabilities, shallow lines, bad ids and an empty list', () => {
        expect(refused(body([`${A} ${B} refs/heads/x`], 'report-status something-new'))).toMatch(/unsupported capability/);
        expect(refused(Buffer.concat([pkt(`shallow ${A}\n`), FLUSH]))).toMatch(/shallow/);
        expect(refused(body([`${A} ${'b'.repeat(64)} refs/heads/x`]))).toMatch(/malformed command/);
        expect(refused(body([`${Z} ${Z} refs/heads/x`]))).toMatch(/malformed command/);
        expect(refused(body([`${A.toUpperCase()} ${B} refs/heads/x`]))).toMatch(/malformed command/);
        expect(refused(body([`${A} ${B}  refs/heads/x`]))).toMatch(/malformed command/);
        expect(refused(FLUSH)).toMatch(/empty/);
    });

    it('validPushRef follows check-ref-format', () => {
        for (const ok of ['refs/heads/main', 'refs/heads/feat/x-1', 'refs/tags/v1.0']) expect(validPushRef(ok)).toBe(true);
        for (const bad of ['refs/heads/a..b', 'refs/heads/a b', 'refs/heads/.x', 'refs/heads/x.lock', 'refs/heads/x/', 'refs/heads/a@{1}', 'refs/heads/a~1', 'refs/heads/a:b', 'refs/heads/']) {
            expect(validPushRef(bad)).toBe(false);
        }
    });
});

describe('refusalReport', () => {
    it('encodes a plain report-status', () => {
        const out = refusalReport(['refs/heads/a', 'refs/heads/b'], 'needs approval', null);
        expect(out.toString()).toBe('000eunpack ok\n' + '0023ng refs/heads/a needs approval\n' + '0023ng refs/heads/b needs approval\n' + '0000');
        const parsed = parseReport(out, false)!;
        expect(parsed.unpackOk).toBe(true);
        expect([...parsed.ng.keys()]).toEqual(['refs/heads/a', 'refs/heads/b']);
    });

    it('wraps the report in side-band-64k band 1, with the message on band 2', () => {
        const out = refusalReport(['refs/heads/a'], 'needs approval', 'side-band-64k', 'Agora: waiting');
        const { pkts, error } = readPkts(out);
        expect(error).toBe(false);
        expect(pkts[pkts.length - 1]).toBeNull();
        const bands = pkts.filter((p): p is Buffer => p !== null).map(p => p[0]);
        expect(bands).toEqual([2, 1]);
        expect(pkts[0]!.subarray(1).toString()).toBe('Agora: waiting\n');
        const parsed = parseReport(out, true)!;
        expect(parsed.ng.get('refs/heads/a')).toBe('needs approval');
    });

    it('splits band 1 into packets that fit side-band (1000 bytes)', () => {
        const refs = Array.from({ length: 40 }, (_, i) => `refs/heads/branch-${i}`);
        const out = refusalReport(refs, 'x'.repeat(60), 'side-band');
        const { pkts } = readPkts(out);
        for (const p of pkts) if (p) expect(p.length + 4).toBeLessThanOrEqual(1000);
        expect(parseReport(out, true)!.ng.size).toBe(40);
    });

    it('never lets a reason break the pkt framing', () => {
        const out = refusalReport(['refs/heads/a'], 'line\nbreak', null);
        expect(parseReport(out, false)!.ng.get('refs/heads/a')).toBe('line break');
    });

    it('sidebandOf picks 64k over plain side-band', () => {
        expect(sidebandOf(['side-band', 'side-band-64k'])).toBe('side-band-64k');
        expect(sidebandOf(['side-band'])).toBe('side-band');
        expect(sidebandOf(['report-status'])).toBeNull();
    });
});

describe('parseReport and parseAdvertisement', () => {
    it('reads ok / ng lines and rejects incomplete reports', () => {
        const report = Buffer.concat([pkt('unpack ok\n'), pkt('ok refs/heads/a\n'), pkt('ng refs/heads/b stale info\n'), FLUSH]);
        const r = parseReport(report, false)!;
        expect([...r.ok]).toEqual(['refs/heads/a']);
        expect(r.ng.get('refs/heads/b')).toBe('stale info');
        expect(parseReport(report.subarray(0, report.length - 4), false)).toBeNull();
        expect(parseReport(Buffer.from('garbage'), false)).toBeNull();
    });

    it('treats a band-3 error as no report', () => {
        const out = Buffer.concat([pkt(Buffer.concat([Buffer.from([3]), Buffer.from('fatal')])), FLUSH]);
        expect(parseReport(out, true)).toBeNull();
    });

    it('reads a v0 advertisement', () => {
        const adv = Buffer.concat([
            pkt('# service=git-upload-pack\n'), FLUSH,
            pkt(`${A} HEAD\0multi_ack side-band-64k\n`), pkt(`${A} refs/heads/main\n`), pkt(`${B} refs/tags/v1\n`), pkt(`${A} refs/tags/v1^{}\n`), FLUSH,
        ]);
        const refs = parseAdvertisement(adv)!;
        expect(refs.get('refs/heads/main')).toBe(A);
        expect(refs.get('refs/tags/v1')).toBe(B);
        expect(refs.has('refs/tags/v1^{}')).toBe(false);
    });

    it('reads an empty repo advertisement', () => {
        const adv = Buffer.concat([pkt('# service=git-upload-pack\n'), FLUSH, pkt(`${Z} capabilities^{}\0report-status\n`), FLUSH]);
        expect(parseAdvertisement(adv)!.size).toBe(0);
    });
});
