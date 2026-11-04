/**
 * Request paths the brokers accept (docs/agent-boxes.md §5): a short list of exact forms,
 * matched after exactly one decode. Traversal, encoded separators, double encoding, another
 * host or anything else is null (the caller answers 404 before any credential is added).
 */

export const OWNER = /^[A-Za-z0-9-]{1,39}$/;
export const REPO = /^[A-Za-z0-9._-]{1,100}$/;
export const validRepoName = (owner: string, repo: string) => OWNER.test(owner) && REPO.test(repo) && repo !== '.' && repo !== '..';

/** Decode a raw path once and refuse anything that could mean something else after another decode. */
export function decodeOnce(rawPath: string): string | null {
    if (!rawPath.startsWith('/')) return null;
    if (/%(2f|5c|00|25)/i.test(rawPath)) return null;
    let path: string;
    try { path = decodeURIComponent(rawPath); } catch { return null; }
    if (path.includes('%') || path.includes('\\') || path.includes('//')) return null;
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(path)) return null;
    if (path.split('/').some(seg => seg === '.' || seg === '..')) return null;
    return path;
}

/** Split a request URL into the raw path and query, refusing a fragment or absolute form. */
export function splitUrl(url: string): { path: string; query: string } | null {
    if (!url.startsWith('/') || url.includes('#')) return null;
    const q = url.indexOf('?');
    return q < 0 ? { path: url, query: '' } : { path: url.slice(0, q), query: url.slice(q + 1) };
}

export type GitRoute =
    | { kind: 'info-refs'; owner: string; repo: string; service: 'git-upload-pack' | 'git-receive-pack' }
    | { kind: 'upload-pack' | 'receive-pack'; owner: string; repo: string };

/** `/git/github.com/<owner>/<repo>.git/{info/refs?service=…, git-upload-pack, git-receive-pack}` */
export function matchGitPath(method: string, url: string): GitRoute | null {
    const parts = splitUrl(url);
    if (!parts) return null;
    const path = decodeOnce(parts.path);
    if (!path) return null;
    const m = /^\/git\/github\.com\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
    if (!m) return null;
    const [, owner, repo, action] = m;
    if (!validRepoName(owner, repo)) return null;
    if (action === 'info/refs') {
        if (method !== 'GET') return null;
        if (parts.query !== 'service=git-upload-pack' && parts.query !== 'service=git-receive-pack') return null;
        return { kind: 'info-refs', owner, repo, service: parts.query.slice('service='.length) as 'git-upload-pack' | 'git-receive-pack' };
    }
    if (method !== 'POST' || parts.query !== '') return null;
    return { kind: action === 'git-upload-pack' ? 'upload-pack' : 'receive-pack', owner, repo };
}

const READS: RegExp[] = [
    /^pulls$/, /^pulls\/\d{1,10}$/, /^pulls\/\d{1,10}\/(reviews|comments|files)$/,
    /^commits\/([0-9a-f]{40}|[0-9a-f]{64})\/(check-runs|status)$/,
    /^actions\/runs$/, /^actions\/runs\/\d{1,12}$/,
    /^issues\/\d{1,10}$/, /^issues\/\d{1,10}\/comments$/,
];
const QUERY_KEYS = new Set(['state', 'head', 'base', 'per_page', 'page', 'branch', 'event']);

export type GithubRoute =
    | { kind: 'read'; owner: string; repo: string; rest: string; query: string }
    | { kind: 'create-pr'; owner: string; repo: string };

/** `/github/repos/<owner>/<repo>/<one of the read paths>` (GET) or `…/pulls` (POST, no query). */
export function matchGithubPath(method: string, url: string): GithubRoute | null {
    const parts = splitUrl(url);
    if (!parts) return null;
    const path = decodeOnce(parts.path);
    if (!path) return null;
    const m = /^\/github\/repos\/([^/]+)\/([^/]+)\/(.+)$/.exec(path);
    if (!m) return null;
    const [, owner, repo, rest] = m;
    if (!validRepoName(owner, repo)) return null;
    if (method === 'POST') return rest === 'pulls' && parts.query === '' ? { kind: 'create-pr', owner, repo } : null;
    if (method !== 'GET' || !READS.some(r => r.test(rest))) return null;
    // Rebuild the query from the keys we allow, so nothing else reaches GitHub
    const out = new URLSearchParams();
    if (parts.query) {
        let params: URLSearchParams;
        try { params = new URLSearchParams(parts.query); } catch { return null; }
        for (const [key, value] of params) {
            if (!QUERY_KEYS.has(key) || value.length > 200) return null;
            // eslint-disable-next-line no-control-regex
            if (/[\x00-\x1f\x7f]/.test(value)) return null;
            out.append(key, value);
        }
    }
    return { kind: 'read', owner, repo, rest, query: out.toString() };
}

/** The first path segment after one decode, lowercased: routes /git and /github however they're spelled. */
export function brokerPrefix(url: string): 'git' | 'github' | null {
    const raw = url.split('?')[0];
    let first = raw.split('/')[1] ?? '';
    try { first = decodeURIComponent(first); } catch { /* keep it raw */ }
    first = first.toLowerCase();
    return first === 'git' || first === 'github' ? first : null;
}
