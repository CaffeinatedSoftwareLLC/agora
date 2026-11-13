import { describe, expect, it } from 'vitest';
import { ADAPTER_CONTROLS, compactNumber, CONTROLS, controlsOf, parseControl } from '../../src/lib/session-commands';

describe('parseControl', () => {
    it('reads one mention and one known command, either order, with at most one model-like word', () => {
        expect(parseControl('@claude /compact')).toEqual({ name: 'compact', arg: null, mention: 'claude' });
        expect(parseControl('  /Compact @Claude '.toLowerCase())).toEqual({ name: 'compact', arg: null, mention: 'claude' });
        expect(parseControl('@codex /model gpt-5.2')).toEqual({ name: 'model', arg: 'gpt-5.2', mention: 'codex' });
    });
    it.each([
        '@claude', '/compact', '@claude /nope', '@claude @codex /compact', '@claude /compact /compact', '@claude /compact two words',
        '@claude /compact; rm -rf /', '@claude /compact $(id)', '@everyone /compact', '@claude please /compact',
    ])('%j is not a command', text => {
        expect(parseControl(text)).toBeNull();
    });
});

describe('the command table', () => {
    it('lists only commands every adapter entry knows, and stop for every adapter', () => {
        for (const [adapter, names] of Object.entries(ADAPTER_CONTROLS)) {
            expect(names, adapter).toContain('stop');
            for (const n of names) expect(Object.keys(CONTROLS)).toContain(n);
        }
        expect(controlsOf('claude').map(c => c.name)).toEqual(['compact', 'context', 'clear', 'stop']);
        expect(controlsOf('codex').map(c => c.name)).toEqual(['compact', 'clear', 'stop']);
        expect(controlsOf('unheard-of')).toEqual([]);
        expect(Object.values(ADAPTER_CONTROLS).flat()).not.toContain('model');
    });
    it('formats token counts', () => {
        expect([182000, 41000, 1000000, 61300, 999, 14640].map(compactNumber)).toEqual(['182k', '41k', '1m', '61.3k', '999', '14.6k']);
    });
});
