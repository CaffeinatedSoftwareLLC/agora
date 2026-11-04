import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * GitHub issues bridge (docs/github-issues.md): the server queues `gh` calls for a channel's
 * linked repository, and this host runs them with the owner's own `gh` login. Agora holds no
 * GitHub token. Every call names the repository with `--repo=`, so no local checkout is needed
 * and the working folder doesn't matter.
 */
export interface GithubCommand {
    id: string;
    claimToken: string;
    action: 'issue_list' | 'issue_comment';
    repo: string;
    payload: { limit?: number; number?: number; body?: string };
}
export type GithubResult = { error: string } | { issues: ListedIssue[] } | { url?: string };
export interface ListedIssue { number: number; title: string; url: string; author: string; updatedAt: string; body: string }

export type Gh = (args: string[], signal?: AbortSignal) => Promise<string>;
export const gh: Gh = async (args, signal) => (await exec('gh', args, {
    cwd: homedir(), windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024, signal,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
})).stdout;

export const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const BODY_MAX = 2000;
const clip = (s: unknown, n: number) => (typeof s === 'string' ? s : '').slice(0, n);

/** Run one command. Errors are short codes only: gh output can hold local paths or tokens. */
export async function runGithub(cmd: GithubCommand, runGh: Gh = gh, signal?: AbortSignal): Promise<GithubResult> {
    if (!REPO.test(cmd.repo) || /\/\.{1,2}$/.test(cmd.repo)) throw new Error('invalid_repo');
    if (cmd.action === 'issue_list') {
        const limit = Math.min(Math.max(cmd.payload.limit ?? 30, 1), 30);
        let out: string;
        try {
            out = await runGh(['issue', 'list', `--repo=${cmd.repo}`, '--state=open', `--limit=${limit}`,
                '--json', 'number,title,url,author,updatedAt,body'], signal);
        } catch (err) { throw new Error(ghError(err)); }
        let rows: any[];
        try { rows = JSON.parse(out); } catch { throw new Error('issue_list_failed'); }
        if (!Array.isArray(rows)) throw new Error('issue_list_failed');
        const issues = rows.filter(r => Number.isInteger(r?.number) && r.number > 0 && typeof r.url === 'string' && /^https:\/\/\S+$/.test(r.url))
            .slice(0, limit).map(r => {
                const body = clip(r.body, BODY_MAX + 1);
                return { number: r.number, title: clip(r.title, 256), url: clip(r.url, 2048), author: clip(r.author?.login, 64),
                    updatedAt: clip(r.updatedAt, 40), body };
            });
        return { issues };
    }
    if (cmd.action === 'issue_comment') {
        const number = cmd.payload.number, body = cmd.payload.body;
        if (!Number.isInteger(number) || number! < 1 || typeof body !== 'string' || !body.trim() || body.length > 1000) throw new Error('invalid_comment');
        let out: string;
        try { out = await runGh(['issue', 'comment', String(number), `--repo=${cmd.repo}`, `--body=${body}`], signal); }
        catch (err) { throw new Error(ghError(err)); }
        const url = out.trim().split(/\s+/).find(s => /^https:\/\/\S+$/.test(s));
        return url ? { url: url.slice(0, 2048) } : {};
    }
    throw new Error('unsupported_command');
}

function ghError(err: any): string {
    if (err?.code === 'ENOENT') return 'gh_not_installed';
    const text = String(err?.stderr ?? err?.message ?? '');
    if (/auth login|not logged in|authentication/i.test(text)) return 'gh_not_signed_in';
    if (/could not resolve to a repository|HTTP 404/i.test(text)) return 'repo_not_found';
    return 'gh_failed';
}
