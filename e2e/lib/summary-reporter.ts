import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { finalize } from './finalize';
import { runId } from './env';

/**
 * Collects per-test outcomes into artifacts/<run-id>/summary.json, then runs finalize()
 * (leak scan + delete secrets/). Runs in onExit so it is the very last step of a run.
 */
function skipState(test: TestCase): string {
    const reason = test.annotations.find(a => a.type === 'skip')?.description ?? '';
    return /^blocked:/.test(reason) ? 'blocked' : /^skipped_budget:/.test(reason) ? 'skipped_budget' : 'not_applicable';
}

export default class SummaryReporter implements Reporter {
    private rows: any[] = [];
    private status = 'unknown';

    onTestEnd(test: TestCase, result: TestResult) {
        const id = /\[([A-Z]+-\d+[^\]]*)\]/.exec(test.title)?.[1] ?? null;
        this.rows.push({
            scenario_id: id,
            title: test.titlePath().slice(2).join(' > '),
            project: test.parent.project()?.name,
            // test.fail() for a known, filed bug: kept visible, never counted as a pass. If it
            // starts passing, Playwright reports it failed, and so does this.
            result: test.expectedStatus === 'failed' && result.status === 'failed' ? 'expected_failure'
                : result.status === 'passed' && test.expectedStatus !== 'failed' ? 'passed'
                // §0 result states: a skip whose reason starts with blocked: / skipped_budget: keeps that state
                : result.status === 'skipped' ? skipState(test) : 'failed',
            raw_status: result.status,
            skip_reason: test.annotations.find(a => a.type === 'skip' || a.type === 'blocked')?.description,
            elapsed_seconds: +(result.duration / 1000).toFixed(1),
        });
    }

    onEnd(result: FullResult) { this.status = result.status; }

    async onExit() {
        const counts = this.rows.reduce((m: Record<string, number>, r) => ((m[r.result] = (m[r.result] ?? 0) + 1), m), {});
        await finalize({ run_id: runId(), status: this.status, counts, tests: this.rows });
        console.log(`\nE2E run ${runId()}: ${JSON.stringify(counts)} -> e2e/artifacts/${runId()}/`);
    }
}
