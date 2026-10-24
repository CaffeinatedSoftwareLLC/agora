/**
 * Origin and deep-link validation. Everything that decides what the WebView may
 * load, or which origin gets the native bridge, goes through here.
 */

/** Hosts that are never accepted as an Agora server: they would collide with the app's own origin. */
const RESERVED_HOSTS = new Set(['localhost']);

/**
 * Normalise what a user typed into an https origin ("https://host[:port]"), or
 * return null. A bare host gets https:// in front. Paths, queries, fragments and
 * credentials are refused rather than dropped, so the user sees what they typed
 * is not a server address.
 */
export function normalizeOrigin(input: string): string | null {
    const raw = input.trim();
    if (!raw || raw.length > 2048 || /[\s\\]/.test(raw)) return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
    let url: URL;
    try {
        url = new URL(withScheme);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    if (url.search || url.hash) return null;
    if (url.pathname !== '/' && url.pathname !== '') return null;
    if (!url.hostname || RESERVED_HOSTS.has(url.hostname)) return null;
    return url.origin;
}

/** True when `origin` is exactly one of the saved origins (both already normalised). */
export function isSavedOrigin(origin: string, saved: readonly string[]): boolean {
    return saved.includes(origin);
}

/**
 * A path on the instance from a push payload: it must be relative to the
 * instance root ("/app/<id>?thread=<id>"), never another origin. Returns the
 * absolute URL on `origin`, or null.
 */
export function resolveInstancePath(origin: string, path: unknown): string | null {
    if (typeof path !== 'string') return null;
    if (path.length === 0 || path.length > 2048) return null;
    if (!path.startsWith('/') || path.startsWith('//')) return null;
    // Backslashes are treated as slashes by the URL parser; control characters and
    // whitespace have no place in the paths the instance sends.
    if (/[\\\s\u0000-\u001f\u007f]/.test(path)) return null;
    let url: URL;
    try {
        url = new URL(path, `${origin}/`);
    } catch {
        return null;
    }
    if (url.origin !== origin) return null;
    return url.href;
}

export interface PushData {
    instance?: unknown;
    url?: unknown;
    type?: unknown;
}

/**
 * Where a tapped notification should go: `url` on the instance that sent it.
 * The instance must be a saved server and must have a push handle registered
 * from this device; anything else is ignored.
 */
export function resolveDeepLink(
    data: PushData | null | undefined,
    saved: readonly string[],
    hasHandleFor: (origin: string) => boolean,
): string | null {
    if (!data || typeof data.instance !== 'string') return null;
    const origin = normalizeOrigin(data.instance);
    if (!origin || origin !== data.instance) return null;
    if (!isSavedOrigin(origin, saved)) return null;
    if (!hasHandleFor(origin)) return null;
    return resolveInstancePath(origin, data.url ?? '/');
}
