import { expect, it } from 'vitest';
import { runGithub, type GithubCommand } from '../src/github.js';

const cmd = (action: GithubCommand['action'], payload: GithubCommand['payload'] = {}, repo = 'acme/widgets'): GithubCommand =>
    ({ id: '01J0000000000000000000000A', claimToken: 'test-token-x', action, repo, payload });

it('lists open issues with --repo and keeps only well-formed rows', async () => {
    const calls: string[][] = [];
    const out = await runGithub(cmd('issue_list', { limit: 5 }), async args => {
        calls.push(args);
        return JSON.stringify([
            { number: 7, title: 'Crash on save', url: 'https://github.com/acme/widgets/issues/7', author: { login: 'ann' }, updatedAt: '2026-11-01T00:00:00Z', body: 'x'.repeat(5000) },
            { number: 'eight', title: 'bad', url: 'https://github.com/acme/widgets/issues/8' },
            { number: 9, title: 'no https', url: 'http://github.com/acme/widgets/issues/9' },
        ]);
    });
    expect(calls[0]).toEqual(['issue', 'list', '--repo=acme/widgets', '--state=open', '--limit=5', '--json', 'number,title,url,author,updatedAt,body']);
    expect('issues' in out && out.issues).toHaveLength(1);
    const issue = (out as any).issues[0];
    expect(issue).toMatchObject({ number: 7, title: 'Crash on save', author: 'ann' });
    expect(issue.body.length).toBe(2001);
});

it('comments with a fixed --body= argument and returns the comment link', async () => {
    const calls: string[][] = [];
    const out = await runGithub(cmd('issue_comment', { number: 7, body: '-Agora: merged' }), async args => {
        calls.push(args);
        return 'https://github.com/acme/widgets/issues/7#issuecomment-1\n';
    });
    expect(calls[0]).toEqual(['issue', 'comment', '7', '--repo=acme/widgets', '--body=-Agora: merged']);
    expect(out).toEqual({ url: 'https://github.com/acme/widgets/issues/7#issuecomment-1' });
});

it('refuses a repository that could be read as a flag or a path', async () => {
    const never = async () => { throw new Error('gh must not run'); };
    await expect(runGithub(cmd('issue_list', {}, '--help/x'), never)).rejects.toThrow('invalid_repo');
    await expect(runGithub(cmd('issue_list', {}, 'acme/..'), never)).rejects.toThrow('invalid_repo');
    await expect(runGithub(cmd('issue_comment', { number: 0, body: 'x' }), never)).rejects.toThrow('invalid_comment');
});

it('turns gh failures into short codes', async () => {
    const fail = (stderr: string, code?: string) => async () => { throw Object.assign(new Error('failed'), { stderr, code }); };
    await expect(runGithub(cmd('issue_list'), fail('', 'ENOENT'))).rejects.toThrow('gh_not_installed');
    await expect(runGithub(cmd('issue_list'), fail('To get started with GitHub CLI, please run:  gh auth login'))).rejects.toThrow('gh_not_signed_in');
    await expect(runGithub(cmd('issue_list'), fail('GraphQL: Could not resolve to a Repository'))).rejects.toThrow('repo_not_found');
    await expect(runGithub(cmd('issue_list'), fail('C:\\Users\\someone\\secret path broke'))).rejects.toThrow('gh_failed');
});

// ─── Automatic import (issue_scan) ───

const row = (n: number, extra: object = {}) => ({ number: n, title: `T${n}`, url: `https://github.com/acme/widgets/issues/${n}`, author: { login: 'ann' },
    createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z', body: 'b', ...extra });

it('scans by label with separate arguments and reads the state of watched issues', async () => {
    const calls: string[][] = [];
    const out: any = await runGithub(cmd('issue_scan', { mode: 'label', label: 'agora', limit: 200, watch: [3, 4] }), async args => {
        calls.push(args);
        if (args[1] === 'list') return JSON.stringify([row(7), row(8, { url: 'http://insecure/8' })]);
        return JSON.stringify({ number: Number(args[2]), state: args[2] === '3' ? 'CLOSED' : 'OPEN' });
    });
    expect(calls[0]).toEqual(['issue', 'list', '--repo=acme/widgets', '--state=open', '--limit=200', '--label=agora', '--json', 'number,title,url,author,createdAt,updatedAt,body']);
    expect(calls.slice(1)).toEqual([['issue', 'view', '3', '--repo=acme/widgets', '--json', 'number,state'], ['issue', 'view', '4', '--repo=acme/widgets', '--json', 'number,state']]);
    expect(out.issues).toHaveLength(1);
    expect(out.issues[0]).toMatchObject({ number: 7, author: 'ann', createdAt: '2026-11-01T00:00:00Z' });
    expect(out.watched).toEqual([{ number: 3, closed: true }, { number: 4, closed: false }]);
    expect(out.truncated).toBe(false);
});

it('every-issue mode passes no label, and says when the page was full', async () => {
    const calls: string[][] = [];
    const out: any = await runGithub(cmd('issue_scan', { mode: 'all', limit: 2 }), async args => { calls.push(args); return JSON.stringify([row(1), row(2)]); });
    expect(calls[0].some(a => a.startsWith('--label'))).toBe(false);
    expect(out.truncated).toBe(true);
});

it('never lets a hostile label, count or number reach gh', async () => {
    const never = async () => { throw new Error('gh must not run'); };
    for (const label of ['--repo=evil/x', '-x', '; rm -rf /', 'a'.repeat(51), '', 'bad$(id)', 'x\nmore'])
        await expect(runGithub(cmd('issue_scan', { mode: 'label', label }), never)).rejects.toThrow('invalid_scan');
    await expect(runGithub(cmd('issue_scan', { mode: 'label' }), never)).rejects.toThrow('invalid_scan');
    await expect(runGithub(cmd('issue_scan', { mode: 'sudo' as any }), never)).rejects.toThrow('invalid_scan');
    await expect(runGithub(cmd('issue_scan', { mode: 'all', watch: [0] }), never)).rejects.toThrow('invalid_scan');
    await expect(runGithub(cmd('issue_scan', { mode: 'all', watch: ['1; id' as any] }), never)).rejects.toThrow('invalid_scan');
    await expect(runGithub(cmd('issue_scan', { mode: 'all', watch: Array.from({ length: 21 }, (_, i) => i + 1) }), never)).rejects.toThrow('invalid_scan');
    await expect(runGithub(cmd('issue_scan', { mode: 'all' }, '--web/x'), never)).rejects.toThrow('invalid_repo');
    await expect(runGithub(cmd('issue_scan', { mode: 'all' }, 'acme/widgets;id'), never)).rejects.toThrow('invalid_repo');
});

it('a label with spaces is one argument, not several', async () => {
    const calls: string[][] = [];
    await runGithub(cmd('issue_scan', { mode: 'label', label: 'good first issue' }), async args => { calls.push(args); return '[]'; });
    expect(calls[0]).toContain('--label=good first issue');
});

it('a scan keeps going past one unreadable issue, but stops when gh is not signed in', async () => {
    const out: any = await runGithub(cmd('issue_scan', { mode: 'all', watch: [1, 2] }), async args => {
        if (args[1] === 'list') return '[]';
        if (args[2] === '1') throw Object.assign(new Error('x'), { stderr: 'HTTP 404' });
        return JSON.stringify({ number: 2, state: 'OPEN' });
    });
    expect(out.watched).toEqual([{ number: 2, closed: false }]);
    const signedOut = async () => { throw Object.assign(new Error('x'), { stderr: 'gh auth login' }); };
    await expect(runGithub(cmd('issue_scan', { mode: 'all' }), signedOut)).rejects.toThrow('gh_not_signed_in');
    await expect(runGithub(cmd('issue_scan', { mode: 'all' }), async () => 'not json')).rejects.toThrow('issue_list_failed');
});
