import { describe, it, expect } from 'vitest';
import { formatRun } from '../src/tools.js';

describe('formatRun', () => {
    it('shows output for a finished run', () => {
        const text = formatRun({ id: 'R1', status: 'succeeded', gate: { decision: 'auto_run', reason: 'ok' }, exitCode: 0, capabilityCalls: 2, artifacts: 1, stdout: 'hello' });
        expect(text).toContain('Run R1: succeeded');
        expect(text).toContain('Exit code: 0');
        expect(text).toContain('Capability calls: 2 · files posted: 1');
        expect(text).toContain('stdout:\nhello');
    });

    it('explains denials and pending approval', () => {
        expect(formatRun({ id: 'R2', status: 'denied', gate: { decision: 'deny', reason: 'not allowed' } })).toContain('Denied: not allowed');
        expect(formatRun({ id: 'R3', status: 'awaiting_approval', gate: { decision: 'needs_approval', reason: '' } })).toContain('approve it in the thread');
    });
});
