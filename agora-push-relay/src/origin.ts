/**
 * Normalises an instance origin ("https://Agora.Example.com/" -> "https://agora.example.com").
 * Returns null unless it is an https URL with nothing after the host but an optional "/".
 */
export function normalizeInstance(value: string): string | null {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== '/') return null;
    if (value.includes('?') || value.includes('#')) return null;
    return url.origin;
}
