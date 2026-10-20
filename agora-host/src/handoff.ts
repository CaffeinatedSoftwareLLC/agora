import { displayName, oneLine } from './envelope.js';
import type { Claim } from './types.js';
import { git } from './workspaces.js';

/**
 * Ownership handoffs (#84, docs/agent-sessions.md "Handoffs"): prompt lines for the offers in a
 * claim. The sender's pinned commit is read from the shared repository in this session's own
 * worktree; the host checks it is there and gives the exact commands to inspect and apply it.
 * Nothing here writes: the agent applies the diff to its own working files, and the host commits
 * them on this session's branch at the end of the turn. The sender's worktree is never touched.
 */
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Does `sha` name a commit here, and where does it meet HEAD? `null` when it isn't in this repository. */
async function locate(cwd: string, sha: string, run: typeof git): Promise<{ base: string | null } | null> {
    try { await run(cwd, ['cat-file', '-e', `${sha}^{commit}`]); } catch { return null; }
    try {
        const base = (await run(cwd, ['merge-base', 'HEAD', sha])).trim();
        return { base: SHA.test(base) ? base : null };
    } catch { return { base: null }; }
}

export async function handoffNotes(claim: Claim, cwd: string | undefined, run: typeof git = git): Promise<string[]> {
    const notes: string[] = [];
    for (const h of claim.handoffs ?? []) {
        const from = `"${displayName(h.from)}" (untrusted name)`;
        const head = `Handoff ${h.offerId} in thread ${h.threadId} from ${from}`;
        const lead = h.status === 'pending'
            ? `${head} is offered to you. Nothing is yours until you call handoff_accept with offer_id ${h.offerId}; decline with handoff_decline and a reason if you can't take it.`
            : `You own the task of thread ${h.threadId}: you accepted handoff ${h.offerId} from ${from}.`;
        if (!h.headSha || !SHA.test(h.headSha)) { notes.push(`${lead} It pins no commit: the sender had no finished hosted turn. Work from its summary.`); continue; }
        const sha = h.headSha;
        const pinned = `It pins commit ${sha}${h.branch ? ` (branch ${oneLine(h.branch)})` : ''}, the sender's last committed head${h.senderRunning ? '; edits from the turn the sender had in progress are not in it' : ''}.`;
        const found = cwd ? await locate(cwd, sha, run) : null;
        if (!found) {
            notes.push(`${lead} ${pinned} That commit is not in this host's repository (another host or folder): ask the sender to push its branch, or work from its summary.`);
            continue;
        }
        const base = found.base ?? '$(git merge-base HEAD ' + sha + ')';
        notes.push([lead, pinned,
            `It is in your repository. Inspect it read-only: git log --oneline ${base}..${sha} and git diff HEAD...${sha}.`,
            `To take the code (after accepting), apply it to your own worktree: git diff ${base} ${sha} | git apply. git apply changes only your working files and applies nothing if a hunk conflicts, so your own edits are never lost; on a conflict, apply per file (add -- <path>) or ask in the thread. Agora commits the result on your branch at the end of the turn.`,
            'Never write to the sender\'s worktree, and do not reset, merge, rebase, check out or switch branches.'].join(' '));
    }
    return notes;
}
