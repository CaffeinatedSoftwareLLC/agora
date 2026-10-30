/**
 * A one-shot status line that survives the picker reload after a server is added or
 * removed (Android re-scopes the bridge on a blank page, then reloads the picker;
 * see README "Security"). Kept in sessionStorage, read once on the next picker load,
 * and ignored when older than MAX_AGE_MS, so a stale line never shows up later
 * (iOS does not reload the picker). Storage failures only lose the line.
 */
export const FLASH_KEY = 'agora.picker.flash';
export const MAX_AGE_MS = 30_000;

export type FlashStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** window.sessionStorage, or null where reading it throws (storage disabled). */
export function sessionStore(win: { sessionStorage: Storage }): FlashStorage | null {
    try {
        return win.sessionStorage;
    } catch {
        return null;
    }
}

export function saveFlash(storage: FlashStorage | null, text: string, now = Date.now()): void {
    try {
        storage?.setItem(FLASH_KEY, JSON.stringify({ text, at: now }));
    } catch {
        // Quota or disabled storage: the line just won't survive the reload.
    }
}

export function clearFlash(storage: FlashStorage | null): void {
    try {
        storage?.removeItem(FLASH_KEY);
    } catch {
        // Nothing to do.
    }
}

/** Read and forget the saved line; null when there is none or it is stale or malformed. */
export function takeFlash(storage: FlashStorage | null, now = Date.now()): string | null {
    if (!storage) return null;
    let raw: string | null;
    try {
        raw = storage.getItem(FLASH_KEY);
        storage.removeItem(FLASH_KEY);
    } catch {
        return null;
    }
    if (!raw) return null;
    try {
        const { text, at } = JSON.parse(raw) as { text?: unknown; at?: unknown };
        if (typeof text !== 'string' || !text || typeof at !== 'number') return null;
        const age = now - at;
        return age >= 0 && age <= MAX_AGE_MS ? text : null;
    } catch {
        return null;
    }
}
