import { parseProtocol, selfYieldError, threadWaiting } from '../../src/lib/protocol';

describe('parseProtocol', () => {
    test('returns null for ordinary messages', () => {
        expect(parseProtocol('hello there')).toBeNull();
        expect(parseProtocol('')).toBeNull();
        expect(parseProtocol(null)).toBeNull();
    });

    test('parses a TURN with YIELD', () => {
        const info = parseProtocol('[AGORA/v1 MODE=plan STATE=TURN]\nHere is my proposal.\n\n[YIELD to=codex]');
        expect(info).toEqual({ version: 1, mode: 'plan', state: 'TURN', yieldTo: 'codex' });
    });

    test('tolerates surrounding whitespace, CRLF, and case', () => {
        const info = parseProtocol('  \r\n[agora/v1 mode=Review state=checkpoint]  \r\nSummary\r\n[yield to=@claude]  ');
        expect(info).toEqual({ version: 1, mode: 'review', state: 'CHECKPOINT', yieldTo: 'claude' });
    });

    test('header must be the first non-empty line', () => {
        expect(parseProtocol('Quoting the syntax: [AGORA/v1 MODE=plan STATE=TURN]')).toBeNull();
        expect(parseProtocol('intro\n[AGORA/v1 MODE=plan STATE=TURN]')).toBeNull();
    });

    test('YIELD only counts as the last line', () => {
        const info = parseProtocol('[AGORA/v1 MODE=fix STATE=TURN]\n[YIELD to=codex]\nmore text');
        expect(info?.yieldTo).toBeUndefined();
    });

    test('rejects unknown modes and states', () => {
        expect(parseProtocol('[AGORA/v1 MODE=party STATE=TURN]')).toBeNull();
        expect(parseProtocol('[AGORA/v1 MODE=plan STATE=DANCE]')).toBeNull();
    });

    test('DECIDE captures AGREE or BLOCK', () => {
        expect(parseProtocol('[AGORA/v1 MODE=plan STATE=DECIDE]\nAGREE')?.decision).toBe('AGREE');
        expect(parseProtocol('[AGORA/v1 MODE=plan STATE=DECIDE] BLOCK missing tests')?.decision).toBe('BLOCK');
        expect(parseProtocol('[AGORA/v1 MODE=plan STATE=DECIDE]\nnot sure')?.decision).toBeUndefined();
    });

    test('START captures the participants list', () => {
        const info = parseProtocol([
            '[AGORA/v1 MODE=plan STATE=START]',
            'Task: design the cache',
            'participants: [claude, @codex, "gemini"]',
        ].join('\n'));
        expect(info?.state).toBe('START');
        expect(info?.participants).toEqual(['claude', 'codex', 'gemini']);
    });

    test('header-only message has no yield', () => {
        expect(parseProtocol('[AGORA/v1 MODE=discuss STATE=ACK]')).toEqual({ version: 1, mode: 'discuss', state: 'ACK' });
    });
});

describe('WAIT, waiting and self-yields (#327)', () => {
    test('parses STATE=WAIT with who owes the next step and for what', () => {
        expect(parseProtocol('[AGORA/v1 MODE=fix STATE=WAIT]\nThe builder is still running.\n[WAIT on=Claude for=builder commit]'))
            .toEqual({ version: 1, mode: 'fix', state: 'WAIT', waitingOn: 'Claude', waitingFor: 'builder commit' });
        expect(parseProtocol('[AGORA/v1 MODE=fix STATE=WAIT]\nwait\n[WAIT on=@Codex]'))
            .toEqual({ version: 1, mode: 'fix', state: 'WAIT', waitingOn: 'Codex' });
        // The WAIT line counts only last, and only under STATE=WAIT
        expect(parseProtocol('[AGORA/v1 MODE=fix STATE=WAIT]\n[WAIT on=Claude for=x]\nmore text')?.waitingOn).toBeUndefined();
        expect(parseProtocol('[AGORA/v1 MODE=fix STATE=TURN]\nx\n[WAIT on=Claude for=x]')?.waitingOn).toBeUndefined();
        expect(parseProtocol(`[AGORA/v1 MODE=fix STATE=WAIT]\nx\n[WAIT on=Claude for=${'r'.repeat(300)}]`)?.waitingFor).toHaveLength(120);
    });

    test('threadWaiting: a WAIT names the agent that owes the step, a YIELD the next agent, an outcome nobody', () => {
        const p = (text: string) => parseProtocol(text);
        expect(threadWaiting(p('[AGORA/v1 MODE=fix STATE=WAIT]\nx\n[WAIT on=Claude for=builder commit]'), 'Codex'))
            .toEqual({ on: 'Claude', for: 'builder commit' });
        expect(threadWaiting(p('[AGORA/v1 MODE=fix STATE=WAIT]\nstill building'), 'Claude')).toEqual({ on: 'Claude', for: null });
        expect(threadWaiting(p('[AGORA/v1 MODE=fix STATE=TURN]\nx\n[YIELD to=Codex]'), 'Claude')).toEqual({ on: 'Codex', for: null });
        expect(threadWaiting(p('[AGORA/v1 MODE=fix STATE=CHECKPOINT]\nsummary'), 'Claude')).toBeNull();
        for (const outcome of ['DONE]\nall good\n[YIELD to=Codex]', 'BLOCK]\nno', 'CANCEL]\nstop', 'DECIDE]\nBLOCK too risky\n[YIELD to=Codex]']) {
            expect(threadWaiting(p(`[AGORA/v1 MODE=fix STATE=${outcome}`), 'Claude')).toBeNull();
        }
        expect(threadWaiting(null, 'Claude')).toBeNull();
    });

    test('selfYieldError refuses a YIELD to the author, in any case, and allows others', () => {
        const turn = (to: string) => parseProtocol(`[AGORA/v1 MODE=fix STATE=TURN]\nx\n[YIELD to=${to}]`);
        expect(selfYieldError(turn('claude'), 'Claude')).toMatch(/YIELDs to its own author \(Claude\).*\[WAIT on=Claude for=/s);
        expect(selfYieldError(turn('Codex'), 'Claude')).toBeNull();
        expect(selfYieldError(parseProtocol('[AGORA/v1 MODE=fix STATE=WAIT]\nx\n[WAIT on=Claude]'), 'Claude')).toBeNull();
        expect(selfYieldError(turn('Claude'), null)).toBeNull();
    });
});
