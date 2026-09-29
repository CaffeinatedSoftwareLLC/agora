import { parseProtocol } from '../../src/lib/protocol';

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
