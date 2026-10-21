import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';

/**
 * SEC-01.user-search (S0238): GET /users/search (src/routes/users.ts:7).
 *
 * The wanted behaviour: a caller only finds people they share a server with, and `q` is a
 * literal prefix (`%` and `_` match themselves). Fixed by #173 (issue #141):
 * the original three findings are required passing regressions on merged main.
 */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;

beforeAll(async () => { ctx = await setupTestApp(); });
afterAll(async () => { await ctx.close(); });
beforeEach(async () => { await cleanDatabase(ctx.db); });

const search = async (auth: Record<string, string>, q: string) => {
    const res = await ctx.request.get(`/users/search?q=${encodeURIComponent(q)}`).set(auth);
    expect(res.status, q).toBe(200);
    return (res.body as { id: string; username: string }[]).map(u => u.username).sort();
};

/** An outsider (own server only) and two users who share a server with each other. */
async function outsiderSetup() {
    const outsider = await authedUser(ctx.request, 'outsider');
    const alice = await authedUser(ctx.request, 'teamalice');
    const bob = await authedUser(ctx.request, 'teambob');
    await createServer(ctx.request, outsider.auth, 'Outsider only');
    const team = await createServer(ctx.request, alice.auth, 'Team');
    await joinViaInvite(ctx.request, alice.auth, bob.auth, team.serverId);
    const shared = await ctx.db.query(
        `SELECT count(*)::int AS n FROM server_members x JOIN server_members y ON x.server_id = y.server_id
         WHERE x.user_id = $1 AND y.user_id = ANY($2)`,
        [outsider.userId, [alice.userId, bob.userId]]);
    expect(shared.rows[0].n).toBe(0);
    return { outsider, alice, bob };
}

describe('GET /users/search: scope', () => {
    it('[SEC-01.user-search] members of a shared server find each other', async () => {
        const { alice, bob } = await outsiderSetup();
        expect(await search(alice.auth, 'teamb')).toEqual(['teambob']);
        expect(await search(bob.auth, 'teama')).toEqual(['teamalice']);
    });

    // Regression fixed by #173: search is restricted to shared servers.
    it('[SEC-01.user-search] an outsider sharing no server gets no results for other users\' names', async () => {
        const { outsider } = await outsiderSetup();
        expect(await search(outsider.auth, 'team')).toEqual([]);
        expect(await search(outsider.auth, 'teamalice')).toEqual([]);
    });

    it('[SEC-01.user-search] an outsider cannot enumerate people with empty or wildcard queries', async () => {
        const { outsider } = await outsiderSetup();
        for (const q of ['', '%', '_']) expect(await search(outsider.auth, q)).toEqual([]);
    });
});

describe('GET /users/search: q is a literal prefix', () => {
    /** Usernames have no character pattern, so `%` and `_` can appear in real names. */
    async function wildcardSetup() {
        const searcher = await authedUser(ctx.request, 'wildsearcher');
        const server = await createServer(ctx.request, searcher.auth, 'Wildcards');
        const names = ['pct%name', 'pctxname', 'und_name', 'undxname', 'zed'];
        for (const n of names) {
            const u = await authedUser(ctx.request, n);
            await joinViaInvite(ctx.request, searcher.auth, u.auth, server.serverId);
        }
        return searcher;
    }

    // Regression fixed by #173: percent signs are literal prefix characters.
    it('[SEC-01.user-search] `%` matches only a literal percent sign', async () => {
        const searcher = await wildcardSetup();
        expect(await search(searcher.auth, 'pct%')).toEqual(['pct%name']);
        expect(await search(searcher.auth, '%')).toEqual([]);
    });

    // Regression fixed by #173: underscores are literal prefix characters.
    it('[SEC-01.user-search] `_` matches only a literal underscore', async () => {
        const searcher = await wildcardSetup();
        expect(await search(searcher.auth, 'und_')).toEqual(['und_name']);
        expect(await search(searcher.auth, '_')).toEqual([]);
    });

    it('[SEC-01.user-search] q=% never lists unshared users and matching remains literal within a shared server', async () => {
        const searcher = await authedUser(ctx.request, 'pctlister');
        for (let i = 0; i < 25; i++) await authedUser(ctx.request, `lone${String(i).padStart(2, '0')}`);
        const memberships = await ctx.db.query('SELECT count(*)::int AS n FROM server_members');
        expect(memberships.rows[0].n).toBe(0);

        const all = await search(searcher.auth, '%');
        expect(all).toEqual([]);
        expect(await search(searcher.auth, 'pct%')).toEqual([]); // 'pctlister' is the caller, excluded
        const wildcards = await wildcardSetup();
        expect(await search(wildcards.auth, 'pct%')).toEqual(['pct%name']);
        expect(await search(wildcards.auth, 'und_')).toEqual(['und_name']);
    });
});

describe('GET /users/search: callers', () => {
    it('[SEC-01.user-search] no UI component imports UserSearch.tsx', () => {
        const root = path.resolve(__dirname, '../../agora-ui/src');
        const importers: string[] = [];
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) walk(p);
                else if (/\.(tsx?|jsx?)$/.test(e.name) && e.name !== 'UserSearch.tsx'
                    && /from\s+['"][^'"]*\/UserSearch['"]|import\(\s*['"][^'"]*\/UserSearch['"]/.test(fs.readFileSync(p, 'utf8'))) {
                    importers.push(path.relative(root, p));
                }
            }
        };
        expect(fs.existsSync(path.join(root, 'features/servers/UserSearch.tsx'))).toBe(true);
        walk(root);
        expect(importers).toEqual([]);
    });
});
