import { lurkBatchReady, LURK_WINDOW_MS } from '../../src/lib/agent-lurk';
import { extractImagePaths } from '../../src/lib/image-references';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('lurk collection window', () => {
    const now = Date.now();
    it('holds a passive burst for two seconds, then takes the batch', () => {
        const first = { reason: 'lurk', created_at: new Date(now) };
        const second = { reason: 'lurk', created_at: new Date(now + 1000) };
        expect(lurkBatchReady([first, second], now + 1500)).toBe(false);
        expect(lurkBatchReady([first, second], now + LURK_WINDOW_MS)).toBe(true);
    });
    it('does not delay direct work or allow chatter to postpone the oldest pending wake', () => {
        expect(lurkBatchReady([], now)).toBe(false);
        expect(lurkBatchReady([{ reason: 'direct', created_at: new Date(now) }], now)).toBe(true);
        expect(lurkBatchReady([{ reason: 'lurk', created_at: new Date(now - 3000) },
            { reason: 'lurk', created_at: new Date(now) }], now)).toBe(true);
    });
});

it('keeps API and host reference extraction identical', () => {
    expect(readFileSync(resolve('src/lib/image-references.ts'), 'utf8'))
        .toBe(readFileSync(resolve('agora-host/src/image-references.ts'), 'utf8'));
    expect(extractImagePaths('![image](https://example.com/a.png) `out/a.png`')).toEqual(['out/a.png']);
});
