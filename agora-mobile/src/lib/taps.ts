import { isSavedOrigin, normalizeOrigin, resolveDeepLink, resolveInstancePath, type PushData } from './origin';

/** What a tapped notification hands to the app (Capacitor's ActionPerformed). */
export interface TapAction {
    actionId?: string;
    notification?: { data?: unknown };
}

export function pushData(action: TapAction | null | undefined): PushData | null {
    const data = action?.notification?.data;
    return data && typeof data === 'object' ? (data as PushData) : null;
}

const OPEN_PREFIX = '#open=';

export interface HandOver {
    data: PushData;
    /** The instance page the tap arrived on, to go back to if the picker refuses the link. */
    from: string | null;
}

/** The picker URL that carries a deep link from an instance page that may not open it itself. */
export function pickerOpenUrl(localUrl: string, data: PushData, from?: string): string {
    const payload = JSON.stringify({ instance: data.instance, url: data.url, from });
    return `${localUrl.replace(/\/+$/, '')}/${OPEN_PREFIX}${encodeURIComponent(payload)}`;
}

/** Read a deep link handed over in the picker's fragment. The result is untrusted until resolveDeepLink accepts it. */
export function readPickerOpen(hash: string): HandOver | null {
    if (!hash.startsWith(OPEN_PREFIX)) return null;
    try {
        const value = JSON.parse(decodeURIComponent(hash.slice(OPEN_PREFIX.length)));
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const { instance, url, from } = value as Record<string, unknown>;
        return { data: { instance, url }, from: typeof from === 'string' ? from : null };
    } catch {
        return null;
    }
}

/** Where to send the user back to after a refused hand-over: the page it came from, if that is on a saved server. */
export function returnUrl(from: string | null, saved: readonly string[]): string | null {
    if (!from) return null;
    let url: URL;
    try {
        url = new URL(from);
    } catch {
        return null;
    }
    const origin = normalizeOrigin(url.origin);
    if (!origin || !isSavedOrigin(origin, saved)) return null;
    return resolveInstancePath(origin, `${url.pathname}${url.search}${url.hash}`);
}

/**
 * Tap on an instance page. An instance page may only read its own push handle,
 * so it opens links for itself and hands anything else to the picker, which
 * checks it against the full saved list.
 */
export function routeTapOnInstance(
    data: PushData | null,
    own: { origin: string; hasHandle: boolean; href?: string },
    localUrl: string,
): string | null {
    if (!data) return null;
    if (data.instance === own.origin) {
        return resolveDeepLink(data, [own.origin], () => own.hasHandle);
    }
    if (typeof data.instance !== 'string') return null;
    return pickerOpenUrl(localUrl, data, own.href);
}
