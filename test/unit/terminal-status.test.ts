import { describe, expect, it } from 'vitest';
import { cleanToolName, limitNotice } from '../../src/lib/terminal-sessions';
import { utcTime } from '../../src/workers/handoff-nudge';

/** #230: the pure parts of terminal listening/idle state and agent_status. */

describe('cleanToolName', () => {
    it('keeps a short identifier and nothing else', () => {
        expect(cleanToolName('chat_send')).toBe('chat_send');
        expect(cleanToolName('mcp__agora:file.read-2')).toBe('mcp__agora:file.read-2');
        expect(cleanToolName('<img src=x onerror=alert(1)>')).toBe('imgsrcxonerroralert1');
        expect(cleanToolName('x'.repeat(100))).toBe('x'.repeat(64));
        for (const bad of ['', '   ', '<>', 42, null, undefined, { name: 'a' }]) expect(cleanToolName(bad)).toBeNull();
    });
});

describe('limitNotice', () => {
    it('names the limits at or over 80%, with the usage window', () => {
        expect(limitNotice('Codex', 85, null, null)).toBe('Codex reports context at 85%. It should hand off before it runs out: post where the work stands, then continue in a fresh session.');
        expect(limitNotice('Codex', 50, 82, '5h window')).toMatch(/^Codex reports usage at 82% \(5h window\)\. /);
        expect(limitNotice('Codex', 90, 80, null)).toMatch(/^Codex reports context at 90% and usage at 80%\. /);
    });
});

describe('utcTime', () => {
    const now = Date.parse('2026-11-05T18:00:00Z');
    it('is the UTC clock time, with the date when it is another day', () => {
        expect(utcTime(new Date('2026-11-05T15:31:40Z'), now)).toBe('15:31 UTC');
        expect(utcTime(new Date('2026-11-04T23:05:00Z'), now)).toBe('2026-11-04 23:05 UTC');
    });
});
