import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { runCardText, subscriptionNotice } from '../../src/lib/provider-terms';

/**
 * Provider-terms guardrails (docs/provider-terms.md). Agora must never read, store or relay
 * a CLI's own login files or OAuth tokens, and never offer "Sign in with Claude / ChatGPT /
 * Google". This scan keeps such code out of the server, the MCP server, the host and the UI.
 */

const ROOT = join(__dirname, '../..');
const DIRS = ['src', 'agora-mcp/src', 'agora-host/src', 'agora-ui/src'];
const FORBIDDEN = /auth\.json|\.credentials\.json|oauth_creds|credentials\.db|accounts\.json|google_accounts|sign in with (claude|chatgpt|google)/i;

function files(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) out.push(...files(path));
        else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
    }
    return out;
}

describe('provider terms', () => {
    it('no source file touches CLI login files or offers provider sign-in', () => {
        const hits = DIRS.flatMap(d => files(join(ROOT, d))).filter(f => FORBIDDEN.test(readFileSync(f, 'utf8')));
        expect(hits).toEqual([]);
    });

    it('explains a refusal and a run card in plain words', () => {
        expect(subscriptionNotice('claude')).toBe("claude runs on the owner's personal subscription; ask the owner, or configure an API key profile.");
        expect(runCardText('gem', 'pending', undefined, 'eryk: hi')).toBe('gem wants to run for: "eryk: hi". It needs the owner\'s approval for every run. Approve to start it.');
        expect(runCardText('gem', 'approved', 'eryk')).toBe('eryk approved this run of gem.');
    });
});
