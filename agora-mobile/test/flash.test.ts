// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { clearFlash, FLASH_KEY, MAX_AGE_MS, saveFlash, sessionStore, takeFlash } from '../src/lib/flash';

describe('flash status across the picker reload', () => {
    beforeEach(() => window.sessionStorage.clear());

    it('shows the saved line once after the reload', () => {
        const storage = sessionStore(window);
        saveFlash(storage, 'Removed Team Agora.', 1_000);
        expect(takeFlash(storage, 2_000)).toBe('Removed Team Agora.');
        expect(takeFlash(storage, 2_000)).toBeNull();
        expect(window.sessionStorage.getItem(FLASH_KEY)).toBeNull();
    });

    it('drops a stale, future-dated or malformed line', () => {
        const storage = sessionStore(window);
        saveFlash(storage, 'Added A.', 0);
        expect(takeFlash(storage, MAX_AGE_MS + 1)).toBeNull();
        saveFlash(storage, 'Added A.', 5_000);
        expect(takeFlash(storage, 1_000)).toBeNull();
        for (const raw of ['{', '"x"', '{"text":"","at":1}', '{"text":"A","at":"1"}', 'null']) {
            window.sessionStorage.setItem(FLASH_KEY, raw);
            expect(takeFlash(storage, 1)).toBeNull();
        }
    });

    it('clearFlash forgets the line', () => {
        const storage = sessionStore(window);
        saveFlash(storage, 'Added A.');
        clearFlash(storage);
        expect(takeFlash(storage)).toBeNull();
    });

    it('survives storage that throws or is missing', () => {
        const broken = {
            getItem: (): string | null => { throw new Error('denied'); },
            setItem: (): void => { throw new Error('quota'); },
            removeItem: (): void => { throw new Error('denied'); },
        };
        expect(() => saveFlash(broken, 'x')).not.toThrow();
        expect(() => clearFlash(broken)).not.toThrow();
        expect(takeFlash(broken)).toBeNull();
        expect(takeFlash(null)).toBeNull();
        const win = { get sessionStorage(): Storage { throw new Error('SecurityError'); } };
        expect(sessionStore(win)).toBeNull();
    });
});
