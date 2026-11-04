import { describe, it, expect } from 'vitest';
import { openUpstream } from '../../src/boxes/edge/upstream';

/** The edge only ever calls GitHub's two origins (or a test's injected fake), whatever URL it is handed. */
describe('openUpstream', () => {
    it('refuses any origin but the fixed upstreams, and credentials in the URL', () => {
        for (const url of ['https://evil.example/x', 'http://github.com/x', 'https://github.com.evil.example/x', 'https://api.github.com:444/x', 'https://u:p@github.com/x', 'https://127.0.0.1/x']) {
            expect(() => openUpstream(url, 'GET', {}), url).toThrow('upstream origin not allowed');
        }
    });
});
