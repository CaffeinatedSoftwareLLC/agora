/**
 * Cost accounting for the agent E2E (beta-test-plan §3.1 "Spend", §0 observed_usage):
 * artifacts/<run-id>/agent-usage.json holds one row per scenario with the tokens its sessions
 * used, read from the session API (`/sessions`: tokensUsed, wakesUsed, the latest runs).
 *
 * Hard stop: once the run's cumulative tokens reach E2E_AGENT_TOKEN_CAP (default 1,500,000),
 * every remaining scenario is skipped as `skipped_budget` (recorded here and in summary.json).
 * The provider-side spend cap on each test key stays the last line of defence.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Api } from './api';
import { artifactsDir, runId } from './env';
import { sessions } from './agents';

export const DEFAULT_TOKEN_CAP = 1_500_000;

export interface UsageRow {
    scenario: string; mode: string; result: string; tokens: number; wakes: number;
    sessions: Array<{ id: string; profile: string; state: string; tokensUsed: number; wakesUsed: number; runs: number }>;
    note?: string; at: string;
}
export interface UsageLedger { run_id: string; token_cap: number; total_tokens: number; scenarios: UsageRow[] }

export function tokenCap(): number {
    const raw = process.env.E2E_AGENT_TOKEN_CAP;
    const n = raw === undefined ? DEFAULT_TOKEN_CAP : Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error('E2E_AGENT_TOKEN_CAP must be a non-negative number');
    return n;
}

export function usageFile() { return path.join(artifactsDir(), 'agent-usage.json'); }

export function readLedger(): UsageLedger {
    try { return JSON.parse(fs.readFileSync(usageFile(), 'utf8')); } catch { return { run_id: runId(), token_cap: tokenCap(), total_tokens: 0, scenarios: [] }; }
}

function write(l: UsageLedger) {
    l.total_tokens = l.scenarios.reduce((n, r) => n + (r.tokens || 0), 0);
    fs.mkdirSync(artifactsDir(), { recursive: true });
    fs.writeFileSync(usageFile(), JSON.stringify(l, null, 2));
}

export function record(row: Omit<UsageRow, 'at'>) {
    const l = readLedger();
    l.token_cap = tokenCap();
    l.scenarios = l.scenarios.filter(r => r.scenario !== row.scenario);
    l.scenarios.push({ ...row, at: new Date().toISOString() });
    write(l);
}

/** `{ over: true, reason }` once the cumulative tokens reach the cap. */
export function budgetLeft(): { over: false; total: number; cap: number } | { over: true; total: number; cap: number; reason: string } {
    const l = readLedger(), cap = tokenCap();
    return l.total_tokens >= cap
        ? { over: true, total: l.total_tokens, cap, reason: `skipped_budget: ${l.total_tokens.toLocaleString('en-US')} tokens used, cap E2E_AGENT_TOKEN_CAP=${cap.toLocaleString('en-US')}` }
        : { over: false, total: l.total_tokens, cap };
}

/** Tokens of every hosted session in these channels (each scenario works in its own channels). */
export async function channelUsage(owner: Api, channelIds: string[]): Promise<Pick<UsageRow, 'tokens' | 'wakes' | 'sessions'>> {
    const seen = new Map<string, UsageRow['sessions'][number]>();
    for (const id of channelIds) {
        let list: any[] = [];
        try { list = await sessions(owner, id); } catch { continue; }
        for (const s of list) {
            if (s.kind === 'terminal' || seen.has(s.id)) continue;
            seen.set(s.id, { id: s.id, profile: s.profile, state: s.state, tokensUsed: Number(s.tokensUsed) || 0, wakesUsed: Number(s.wakesUsed) || 0, runs: (s.recentRuns ?? []).length });
        }
    }
    const rows = [...seen.values()];
    return { tokens: rows.reduce((n, r) => n + r.tokensUsed, 0), wakes: rows.reduce((n, r) => n + r.wakesUsed, 0), sessions: rows };
}
