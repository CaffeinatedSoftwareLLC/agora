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
