import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { finalize } from './finalize';
import { runId } from './env';

/**
 * Collects per-test outcomes into artifacts/<run-id>/summary.json, then runs finalize()
 * (leak scan + delete secrets/). Runs in onExit so it is the very last step of a run.
 */
export default class SummaryReporter implements Reporter {
    private rows: any[] = [];
    private status = 'unknown';

    onTestEnd(test: TestCase, result: TestResult) {
        const id = /\[([A-Z]+-\d+[^\]]*)\]/.exec(test.title)?.[1] ?? null;
        this.rows.push({
            scenario_id: id,
            title: test.titlePath().slice(2).join(' > '),
            project: test.parent.project()?.name,
            result: result.status === 'passed' ? 'passed' : result.status === 'skipped' ? 'not_applicable' : 'failed',
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
