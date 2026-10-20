import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/** Where the agent writes the patch: the system temp folder, outside every worktree, one file per offer. */
export function patchFile(offerId: string, dir = tmpdir()): string {
    return join(dir, `agora-handoff-${offerId}.patch`);
}

export async function handoffNotes(claim: Claim, cwd: string | undefined, run: typeof git = git, tmp = tmpdir()): Promise<string[]> {
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
        // No merge base found: the agent asks git itself (no shell substitution: PowerShell has none)
        const base = found.base ?? '<base>';
        const findBase = found.base ? '' : ` First run git merge-base HEAD ${sha} and use its output as <base>.`;
        const patch = patchFile(h.offerId, tmp);
        notes.push([lead, pinned,
            `It is in your repository. Inspect it read-only: git diff HEAD...${sha} and git log --oneline -n 20 ${sha}.${findBase}`,
            // A patch file, never a pipe: Windows PowerShell 5.1 re-encodes piped native output and
            // breaks non-ASCII patches. --binary carries binary files.
            `To take the code (after accepting), apply it to your own worktree with two commands, then delete the patch file: git diff --binary ${base} ${sha} --output "${patch}" and then git apply "${patch}". Do not pipe the diff into git apply (Windows PowerShell corrupts piped patches). git apply changes only your working files and applies nothing if any hunk conflicts, so your own edits are never lost; on a conflict, apply per file (add -- <path> to the diff) or ask in the thread. Agora commits the result on your branch at the end of the turn.`,
            'Never write to the sender\'s worktree, and do not reset, merge, rebase, check out or switch branches.'].join(' '));
    }
    return notes;
}
