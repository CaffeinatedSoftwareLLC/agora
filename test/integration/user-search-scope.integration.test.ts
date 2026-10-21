import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';

/**
 * SEC-01.user-search (S0238): GET /users/search (src/routes/users.ts:7).
 *
 * The wanted behaviour: a caller only finds people they share a server with, and `q` is a
 * literal prefix (`%` and `_` match themselves). On this candidate the query is instance-wide
 * and `q` goes into ILIKE unescaped, so the wanted-behaviour tests are `it.fails` findings.
 * The fix is on branch fix/141-scope-user-search (not merged here).
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

    // FINDING: /users/search is instance-wide: a user sharing no server finds every username (src/routes/users.ts:22-26)
    it.fails('[SEC-01.user-search] an outsider sharing no server gets no results for other users\' names', async () => {
        const { outsider } = await outsiderSetup();
        expect(await search(outsider.auth, 'team')).toEqual([]);
        expect(await search(outsider.auth, 'teamalice')).toEqual([]);
    });

    it('[SEC-01.user-search] current behaviour: the outsider finds both team members by prefix', async () => {
        const { outsider } = await outsiderSetup();
        expect(await search(outsider.auth, 'team')).toEqual(['teamalice', 'teambob']);
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

    // FINDING: q goes into ILIKE unescaped, so `%` matches any run of characters (src/routes/users.ts:26 `q + '%'`)
    it.fails('[SEC-01.user-search] `%` matches only a literal percent sign', async () => {
        const searcher = await wildcardSetup();
        expect(await search(searcher.auth, 'pct%')).toEqual(['pct%name']);
        expect(await search(searcher.auth, '%')).toEqual([]);
    });

    // FINDING: q goes into ILIKE unescaped, so `_` matches any single character (src/routes/users.ts:26)
    it.fails('[SEC-01.user-search] `_` matches only a literal underscore', async () => {
        const searcher = await wildcardSetup();
        expect(await search(searcher.auth, 'und_')).toEqual(['und_name']);
        expect(await search(searcher.auth, '_')).toEqual([]);
    });

    it('[SEC-01.user-search] current behaviour: q=% lists exactly 20 of 25 users, none of them shares a server', async () => {
        const searcher = await authedUser(ctx.request, 'pctlister');
        for (let i = 0; i < 25; i++) await authedUser(ctx.request, `lone${String(i).padStart(2, '0')}`);
        const memberships = await ctx.db.query('SELECT count(*)::int AS n FROM server_members');
        expect(memberships.rows[0].n).toBe(0);

        const all = await search(searcher.auth, '%');
        expect(all).toHaveLength(20);
        expect(all.every(n => /^lone\d\d$/.test(n))).toBe(true);
        expect(await search(searcher.auth, 'pct%')).toEqual([]); // 'pctlister' is the caller, excluded
        const wildcards = await wildcardSetup();
        expect(await search(wildcards.auth, 'pct%')).toEqual(['pct%name', 'pctlister', 'pctxname']);
        expect(await search(wildcards.auth, 'und_')).toEqual(['und_name', 'undxname']);
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
