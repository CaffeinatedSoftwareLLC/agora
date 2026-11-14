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
    action: 'issue_list' | 'issue_comment' | 'issue_scan' | 'link_info';
    repo: string;
    payload: { limit?: number; number?: number; body?: string; mode?: 'label' | 'all'; label?: string; watch?: number[] };
}
export type GithubResult = { error: string } | { issues: ListedIssue[] } | { url?: string } | { login: string; repoId?: string }
    | { issues: ListedIssue[]; watched: Array<{ number: number; closed: boolean }>; truncated: boolean };
export interface ListedIssue { number: number; title: string; url: string; author: string; updatedAt: string; body: string; createdAt?: string; labels?: string[] }

export type Gh = (args: string[], signal?: AbortSignal) => Promise<string>;
export const gh: Gh = async (args, signal) => (await exec('gh', args, {
    cwd: homedir(), windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024, signal,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
})).stdout;

export const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const BODY_MAX = 2000;
/** What an automation scan may look at in one call, and the labels it may pass to gh. */
export const SCAN_MAX = 200;
export const WATCH_MAX = 20;
export const LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,49}$/;
export const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NODE_ID = /^[A-Za-z0-9_=-]{4,100}$/;
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
    if (cmd.action === 'issue_scan') return scan(cmd, runGh, signal);
    if (cmd.action === 'link_info') return linkInfo(cmd, runGh, signal);
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

/**
 * Automatic import (docs/github-issues.md): the open issues that match the rule, newest first, plus
 * the state of a few cards' issues. The label, the repository and the numbers are checked here
 * and passed to gh as separate arguments (never a shell): nothing from an issue reaches a command.
 */
async function scan(cmd: GithubCommand, runGh: Gh, signal?: AbortSignal): Promise<GithubResult> {
    const p = cmd.payload;
    if (p.mode !== 'label' && p.mode !== 'all') throw new Error('invalid_scan');
    if (p.mode === 'label' && (typeof p.label !== 'string' || !LABEL.test(p.label))) throw new Error('invalid_scan');
    const limit = Math.min(Math.max(Number.isInteger(p.limit) ? p.limit! : SCAN_MAX, 1), SCAN_MAX);
    const watch = Array.isArray(p.watch) ? p.watch : [];
    if (watch.length > WATCH_MAX || !watch.every(n => Number.isInteger(n) && n >= 1 && n <= 2147483647)) throw new Error('invalid_scan');

    const args = ['issue', 'list', `--repo=${cmd.repo}`, '--state=open', `--limit=${limit}`,
        ...(p.mode === 'label' ? [`--label=${p.label}`] : []), '--json', 'number,title,url,author,createdAt,updatedAt,body,labels'];
    let rows: any[];
    try { rows = JSON.parse(await runGh(args, signal)); } catch (err) {
        if (err instanceof SyntaxError) throw new Error('issue_list_failed');
        throw new Error(ghError(err));
    }
    if (!Array.isArray(rows)) throw new Error('issue_list_failed');
    const labelsOf = (r: any): string[] => (Array.isArray(r?.labels) ? r.labels : []).map((l: any) => clip(l?.name, 50)).filter(Boolean).slice(0, 100);
    // For a label rule, an issue that does not carry the label in gh's own answer is not passed on (the server checks again)
    const issues = rows.filter(r => Number.isInteger(r?.number) && r.number > 0 && typeof r.url === 'string' && /^https:\/\/\S+$/.test(r.url)
            && (p.mode !== 'label' || labelsOf(r).some(l => l.toLowerCase() === p.label!.toLowerCase())))
        .slice(0, limit).map(r => ({ number: r.number, title: clip(r.title, 256), url: clip(r.url, 2048), author: clip(r.author?.login, 64),
            createdAt: clip(r.createdAt, 40), updatedAt: clip(r.updatedAt, 40), body: clip(r.body, BODY_MAX + 1), labels: labelsOf(r) }));

    // One issue gone or unreadable is skipped; gh not installed or signed in ends the scan
    const watched = (await Promise.all(watch.map(async number => {
        try {
            const one = JSON.parse(await runGh(['issue', 'view', String(number), `--repo=${cmd.repo}`, '--json', 'number,state'], signal));
            return one?.number === number && (one.state === 'OPEN' || one.state === 'CLOSED') ? { number, closed: one.state === 'CLOSED' } : null;
        } catch (err) {
            const code = err instanceof SyntaxError ? 'gh_failed' : ghError(err);
            if (code === 'gh_not_installed' || code === 'gh_not_signed_in') throw new Error(code);
            return null;
        }
    }))).filter((w): w is { number: number; closed: boolean } => w !== null);
    return { issues, watched, truncated: rows.length >= limit };
}

/**
 * Which GitHub account this machine's gh is signed in as, and the repository's stable id
 * (docs/github-issues.md "Who may start which agent"). `gh api user` is a read of the signed-in
 * account and needs no scope. Anything gh prints is checked against the shape of a login or an id
 * before it is sent; nothing else leaves the host. A repository that cannot be read still reports the login.
 */
async function linkInfo(cmd: GithubCommand, runGh: Gh, signal?: AbortSignal): Promise<GithubResult> {
    let login: string;
    try { login = (await runGh(['api', 'user', '--jq', '.login'], signal)).trim(); } catch (err) { throw new Error(ghError(err)); }
    if (!LOGIN.test(login)) throw new Error('no_login');
    let repoId: string | undefined;
    try {
        const id = (await runGh(['repo', 'view', cmd.repo, '--json', 'id', '--jq', '.id'], signal)).trim();
        if (NODE_ID.test(id)) repoId = id;
    } catch (err) {
        const code = ghError(err);
        if (code === 'gh_not_installed' || code === 'gh_not_signed_in') throw new Error(code);
    }
    return { login, ...(repoId ? { repoId } : {}) };
}

function ghError(err: any): string {
    if (err?.code === 'ENOENT') return 'gh_not_installed';
    const text = String(err?.stderr ?? err?.message ?? '');
    if (/auth login|not logged in|authentication/i.test(text)) return 'gh_not_signed_in';
    if (/could not resolve to a repository|HTTP 404/i.test(text)) return 'repo_not_found';
    return 'gh_failed';
}
