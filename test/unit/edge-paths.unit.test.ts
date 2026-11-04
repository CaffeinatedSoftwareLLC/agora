import { brokerPrefix, decodeOnce, matchGitPath, matchGithubPath } from '../../src/boxes/edge/paths';

/** docs/agent-boxes.md §5: exact path forms after one decode; everything else is 404 (null). */

const G = '/git/github.com/acme/widget.git';

describe('matchGitPath', () => {
    it('accepts the three smart-HTTP forms', () => {
        expect(matchGitPath('GET', `${G}/info/refs?service=git-upload-pack`)).toEqual({ kind: 'info-refs', owner: 'acme', repo: 'widget', service: 'git-upload-pack' });
        expect(matchGitPath('GET', `${G}/info/refs?service=git-receive-pack`)).toMatchObject({ kind: 'info-refs', service: 'git-receive-pack' });
        expect(matchGitPath('POST', `${G}/git-upload-pack`)).toEqual({ kind: 'upload-pack', owner: 'acme', repo: 'widget' });
        expect(matchGitPath('POST', `${G}/git-receive-pack`)).toEqual({ kind: 'receive-pack', owner: 'acme', repo: 'widget' });
    });

    it('refuses traversal', () => {
        expect(matchGitPath('POST', '/git/github.com/acme/../evil/x.git/git-upload-pack')).toBeNull();
        expect(matchGitPath('POST', '/git/github.com/acme/widget.git/../git-upload-pack')).toBeNull();
        expect(matchGitPath('POST', '/git/github.com/acme/%2e%2e/x.git/git-upload-pack')).toBeNull();
        expect(matchGitPath('POST', '/git/github.com/./acme/widget.git/git-upload-pack')).toBeNull();
    });

    it('refuses encoded separators', () => {
        expect(matchGitPath('POST', '/git/github.com/acme%2fwidget.git/git-upload-pack')).toBeNull();
        expect(matchGitPath('POST', '/git/github.com/acme%2Fother/widget.git/git-upload-pack')).toBeNull();
        expect(matchGitPath('POST', '/git/github.com/acme%5cwidget.git/git-upload-pack')).toBeNull();
        expect(matchGitPath('POST', '/git/github.com/acme\\widget.git/git-upload-pack')).toBeNull();
    });

    it('refuses double encoding', () => {
        expect(matchGitPath('POST', '/git/github.com/acme%252fx/widget.git/git-upload-pack')).toBeNull();
        expect(matchGitPath('POST', '/git/github.com/acme/w%2569dget.git/git-upload-pack')).toBeNull();
    });

    it('decodes plain escapes once', () => {
        expect(matchGitPath('POST', '/git/github.com/acme/wid%67et.git/git-upload-pack')).toEqual({ kind: 'upload-pack', owner: 'acme', repo: 'widget' });
    });

    it('refuses other hosts, other paths, odd queries and wrong methods', () => {
        expect(matchGitPath('POST', '/git/gitlab.com/acme/widget.git/git-upload-pack')).toBeNull();
        expect(matchGitPath('POST', '/git/evil.com@github.com/acme/widget.git/git-upload-pack')).toBeNull();
        expect(matchGitPath('POST', '/git/GITHUB.COM/acme/widget.git/git-upload-pack')).toBeNull();
        expect(matchGitPath('GET', `${G}/HEAD`)).toBeNull();
        expect(matchGitPath('GET', `${G}/objects/info/packs`)).toBeNull();
        expect(matchGitPath('GET', `${G}/info/refs`)).toBeNull();
        expect(matchGitPath('GET', `${G}/info/refs?service=git-upload-archive`)).toBeNull();
        expect(matchGitPath('GET', `${G}/info/refs?service=git-upload-pack&x=1`)).toBeNull();
        expect(matchGitPath('POST', `${G}/git-upload-pack?x=1`)).toBeNull();
        expect(matchGitPath('GET', `${G}/git-upload-pack`)).toBeNull();
        expect(matchGitPath('POST', `${G}/info/refs?service=git-upload-pack`)).toBeNull();
        expect(matchGitPath('POST', '//git/github.com/acme/widget.git/git-upload-pack')).toBeNull();
        expect(matchGitPath('POST', 'http://github.com/acme/widget.git/git-upload-pack')).toBeNull();
        expect(matchGitPath('POST', `${G}/git-upload-pack#x`)).toBeNull();
    });

    it('refuses owner and repo names GitHub would not have', () => {
        expect(matchGitPath('POST', '/git/github.com/ac_me/widget.git/git-upload-pack')).toBeNull();
        expect(matchGitPath('POST', `/git/github.com/${'a'.repeat(40)}/widget.git/git-upload-pack`)).toBeNull();
        expect(matchGitPath('POST', '/git/github.com/acme/wid get.git/git-upload-pack')).toBeNull();
        expect(matchGitPath('POST', '/git/github.com/acme/%00.git/git-upload-pack')).toBeNull();
    });
});

describe('matchGithubPath', () => {
    const R = '/github/repos/acme/widget';
    it('accepts the enumerated reads', () => {
        for (const rest of ['pulls', 'pulls/12', 'pulls/12/reviews', 'pulls/12/comments', 'pulls/12/files', `commits/${'a'.repeat(40)}/check-runs`,
            `commits/${'b'.repeat(64)}/status`, 'actions/runs', 'actions/runs/99', 'issues/3', 'issues/3/comments']) {
            expect(matchGithubPath('GET', `${R}/${rest}`)).toMatchObject({ kind: 'read', rest });
        }
    });

    it('rebuilds the query from allowed keys only', () => {
        expect(matchGithubPath('GET', `${R}/pulls?state=open&head=acme:x&per_page=5`)).toMatchObject({ query: 'state=open&head=acme%3Ax&per_page=5' });
        expect(matchGithubPath('GET', `${R}/pulls?access_token=x`)).toBeNull();
        expect(matchGithubPath('GET', `${R}/pulls?state=open&url=http://x`)).toBeNull();
    });

    it('refuses everything else', () => {
        expect(matchGithubPath('GET', `${R}/pulls/12/merge`)).toBeNull();
        expect(matchGithubPath('PUT', `${R}/pulls/12/merge`)).toBeNull();
        expect(matchGithubPath('GET', `${R}/contents/README.md`)).toBeNull();
        expect(matchGithubPath('GET', `${R}/commits/abc/status`)).toBeNull();
        expect(matchGithubPath('GET', `${R}/pulls/1x`)).toBeNull();
        expect(matchGithubPath('GET', '/github/user')).toBeNull();
        expect(matchGithubPath('GET', '/github/repos/acme/widget/../other/pulls')).toBeNull();
        expect(matchGithubPath('GET', '/github/repos/acme%2fwidget/pulls')).toBeNull();
        expect(matchGithubPath('GET', '/github/repos/acme/widget%252fpulls')).toBeNull();
        expect(matchGithubPath('DELETE', `${R}/pulls`)).toBeNull();
        expect(matchGithubPath('POST', `${R}/pulls/1`)).toBeNull();
        expect(matchGithubPath('POST', `${R}/issues`)).toBeNull();
        expect(matchGithubPath('POST', `${R}/pulls?x=1`)).toBeNull();
    });

    it('routes PR creation', () => {
        expect(matchGithubPath('POST', `${R}/pulls`)).toEqual({ kind: 'create-pr', owner: 'acme', repo: 'widget' });
    });
});

describe('decodeOnce and brokerPrefix', () => {
    it('decodes once and refuses what would decode again', () => {
        expect(decodeOnce('/a%20b')).toBe('/a b');
        expect(decodeOnce('/a%2520b')).toBeNull();
        expect(decodeOnce('/a%zz')).toBeNull();
        expect(decodeOnce('/a/%2e%2e/b')).toBeNull();
    });

    it('routes /git and /github however they are spelled', () => {
        expect(brokerPrefix('/git/github.com/x')).toBe('git');
        expect(brokerPrefix('/GitHub/repos')).toBe('github');
        expect(brokerPrefix('/gi%74/x')).toBe('git');
        expect(brokerPrefix('/api/messages')).toBeNull();
        expect(brokerPrefix('/gitx')).toBeNull();
    });
});
