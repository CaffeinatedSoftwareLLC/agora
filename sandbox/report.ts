/**
 * Test-result reports for agora:std (WBS 4.1). Pure functions with no Deno APIs so
 * they are unit-tested on Node (test/unit/report.unit.test.ts).
 *
 * Accepts three input shapes and normalizes them:
 *   - Agora's own shape: { totals, suites?, failures? }
 *   - Vitest / Jest JSON reporter output (`--reporter=json` / `--json`)
 *   - JUnit XML (pytest, Go, Gradle, Maven, jest-junit, vitest junit, ...)
 */

export interface Counts {
    passed: number;
    failed: number;
    skipped: number;
    durationMs?: number;
}

export interface SuiteResult extends Counts {
    name: string;
}

export interface Failure {
    name: string;
    suite?: string;
    message: string;
}

export interface TestResults {
    totals: Counts;
    suites: SuiteResult[];
    failures: Failure[];
}

/** Caps matching the gateway's /v1/reports schema. */
export const REPORT_LIMITS = { suites: 50, failures: 20, failureMessage: 2000, name: 300, failureName: 500 };

const int = (v: unknown): number => {
    const n = typeof v === 'string' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};
const ms = (v: unknown): number | undefined => {
    const n = typeof v === 'string' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
};
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
// deno-lint-ignore no-control-regex
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

function sum(suites: Counts[]): Counts {
    const totals: Counts = { passed: 0, failed: 0, skipped: 0 };
    let duration = 0;
    let anyDuration = false;
    for (const s of suites) {
        totals.passed += s.passed;
        totals.failed += s.failed;
        totals.skipped += s.skipped;
        if (s.durationMs !== undefined) { duration += s.durationMs; anyDuration = true; }
    }
    if (anyDuration) totals.durationMs = duration;
    return totals;
}

function fromAgora(input: any): TestResults {
    const counts = (c: any): Counts => ({ passed: int(c?.passed), failed: int(c?.failed), skipped: int(c?.skipped), ...(ms(c?.durationMs) !== undefined ? { durationMs: ms(c?.durationMs) } : {}) });
    const suites = Array.isArray(input.suites)
        ? input.suites.map((s: any) => ({ name: String(s?.name ?? 'suite'), ...counts(s) }))
        : [];
    const failures = Array.isArray(input.failures)
        ? input.failures.map((f: any) => ({ name: String(f?.name ?? 'test'), ...(f?.suite ? { suite: String(f.suite) } : {}), message: String(f?.message ?? '') }))
        : [];
    return { totals: input.totals ? counts(input.totals) : sum(suites), suites, failures };
}

/** Vitest and Jest share this JSON shape: testResults[].assertionResults[]. */
function fromJestJson(input: any): TestResults {
    const suites: SuiteResult[] = [];
    const failures: Failure[] = [];
    for (const file of input.testResults as any[]) {
        const name = String(file?.name ?? 'suite').replace(/^.*?[\\/](?=(?:src|test|tests|__tests__|packages|apps)[\\/])/, '');
        const counts: Counts = { passed: 0, failed: 0, skipped: 0 };
        let duration = 0;
        for (const a of (file?.assertionResults ?? []) as any[]) {
            if (a?.status === 'passed') counts.passed++;
            else if (a?.status === 'failed') {
                counts.failed++;
                failures.push({ name: String(a.fullName ?? a.title ?? 'test'), suite: name, message: stripAnsi((a.failureMessages ?? []).join('\n')) });
            } else counts.skipped++; // pending, skipped, todo, disabled
            duration += ms(a?.duration) ?? 0;
        }
        const fileDuration = ms(file?.endTime) !== undefined && ms(file?.startTime) !== undefined ? file.endTime - file.startTime : duration;
        // A file that failed to load has no assertions but a message
        if (file?.status === 'failed' && counts.failed === 0 && file?.message) {
            counts.failed = 1;
            failures.push({ name: `${name} (failed to run)`, suite: name, message: stripAnsi(String(file.message)) });
        }
        suites.push({ name, ...counts, durationMs: Math.max(0, Math.round(fileDuration)) });
    }
    const totals = sum(suites);
    // Prefer the reporter's own totals when present; files that failed to load count as failures
    if (typeof input.numTotalTests === 'number') {
        totals.passed = int(input.numPassedTests);
        totals.failed = int(input.numFailedTests);
        totals.skipped = int(input.numPendingTests) + int(input.numTodoTests);
    }
    totals.failed = Math.max(totals.failed, failures.length);
    return { totals, suites, failures };
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXml(s: string): string {
    return s
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
            e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : XML_ENTITIES[e.toLowerCase()]);
}

function attrs(tag: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1]] = decodeXml(m[3] ?? m[4] ?? '');
    return out;
}

/**
 * Tolerant JUnit XML reader (no XML library in the sandbox). Groups test cases by
 * their enclosing <testsuite>, or by `classname` when there is none.
 */
function fromJunit(xml: string): TestResults {
    const suites = new Map<string, SuiteResult>();
    const failures: Failure[] = [];
    const clean = xml.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '');

    // Record each <testsuite ...> start position so cases can find their suite
    const suiteStarts: { index: number; name: string }[] = [];
    for (const m of clean.matchAll(/<testsuite\b([^>]*)>/g)) suiteStarts.push({ index: m.index ?? 0, name: attrs(m[1]).name ?? '' });
    const suiteAt = (index: number) => {
        let name = '';
        for (const s of suiteStarts) { if (s.index < index) name = s.name; else break; }
        return name;
    };

    for (const m of clean.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
        const a = attrs(m[1]);
        const body = m[3] ?? '';
        const suiteName = suiteAt(m.index ?? 0) || a.classname || 'tests';
        const suite = suites.get(suiteName) ?? { name: suiteName, passed: 0, failed: 0, skipped: 0, durationMs: 0 };
        suites.set(suiteName, suite);
        suite.durationMs = (suite.durationMs ?? 0) + Math.round(Number(a.time || 0) * 1000);

        const problem = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
        if (problem) {
            suite.failed++;
            const pa = attrs(problem[2]);
            const detail = decodeXml(problem[3] ?? '').trim();
            const message = [pa.message, detail].filter(Boolean).join('\n');
            failures.push({ name: a.name || 'test', suite: suiteName, message: message || problem[1] });
        } else if (/<skipped\b/.test(body)) suite.skipped++;
        else suite.passed++;
    }
    const list = [...suites.values()];
    return { totals: sum(list), suites: list, failures };
}

/** Normalize any supported input. Throws with a readable message otherwise. */
export function parseTestResults(input: unknown): TestResults {
    let value = input;
    if (typeof value === 'string') {
        const text = value.trim();
        if (text.startsWith('<')) return finish(fromJunit(text));
        try { value = JSON.parse(text); } catch { throw new Error('Test results must be JUnit XML, Vitest/Jest JSON, or { totals, suites, failures }'); }
    }
    if (value && typeof value === 'object') {
        const v = value as any;
        if (Array.isArray(v.testResults)) return finish(fromJestJson(v));
        if (v.totals || Array.isArray(v.suites)) return finish(fromAgora(v));
    }
    throw new Error('Test results must be JUnit XML, Vitest/Jest JSON, or { totals, suites, failures }');
}

/** Order suites (failures first), apply caps, and trim text to the gateway's limits. */
function finish(r: TestResults): TestResults {
    const suites = [...r.suites]
        .sort((a, b) => b.failed - a.failed || a.name.localeCompare(b.name))
        .map(s => ({ ...s, name: clip(s.name, REPORT_LIMITS.name) }));
    const failures = r.failures.map(f => ({
        name: clip(f.name, REPORT_LIMITS.failureName),
        ...(f.suite ? { suite: clip(f.suite, REPORT_LIMITS.name) } : {}),
        message: clip(f.message.trim(), REPORT_LIMITS.failureMessage),
    }));
    return { totals: r.totals, suites, failures };
}

export function formatDuration(msValue: number | undefined): string {
    if (msValue === undefined) return '';
    if (msValue < 1000) return `${msValue} ms`;
    const s = msValue / 1000;
    return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

/** Deterministic one-paragraph summary, used when no chat route is available. */
export function computedSummary(r: TestResults): string {
    const { passed, failed, skipped, durationMs } = r.totals;
    const total = passed + failed + skipped;
    if (total === 0) return 'No tests ran.';
    const parts = [`${passed} of ${total} tests passed`];
    if (failed) parts.push(`${failed} failed`);
    if (skipped) parts.push(`${skipped} skipped`);
    let text = `${parts.join(', ')}${durationMs !== undefined ? ` in ${formatDuration(durationMs)}` : ''}.`;
    const failingSuites = r.suites.filter(s => s.failed > 0);
    if (failingSuites.length) {
        text += ` Failures are in ${failingSuites.slice(0, 3).map(s => s.name).join(', ')}${failingSuites.length > 3 ? ` and ${failingSuites.length - 3} more` : ''}.`;
    }
    return text;
}

/** The chat prompt for a model-written summary: facts only, no invented causes. */
export function summaryPrompt(r: TestResults, title: string): string {
    const failures = r.failures.slice(0, 10).map(f => `- ${f.suite ? `${f.suite} › ` : ''}${f.name}\n  ${f.message.split('\n').slice(0, 6).join('\n  ')}`);
    return [
        `Summarize this test run ("${title}") for a developer in 2–4 sentences.`,
        'State the outcome and counts first. If tests failed, name what failed and quote the most telling error text.',
        'Only use facts present below; do not guess causes that the errors do not show. No headings, no lists.',
        '',
        `Totals: ${JSON.stringify(r.totals)}`,
        `Suites (failures first): ${JSON.stringify(r.suites.slice(0, 20))}`,
        failures.length ? `Failures:\n${failures.join('\n')}` : 'Failures: none',
    ].join('\n');
}

/** Full report as Markdown (attached to the card; `.md` is an allowed file type by default). */
export function reportMarkdown(r: TestResults, title: string, summary: string, allFailures: Failure[] = r.failures): string {
    const { passed, failed, skipped, durationMs } = r.totals;
    const total = passed + failed + skipped;
    const pct = total ? Math.round((passed / total) * 1000) / 10 : 0;
    const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
    const lines = [
        `# ${title}`,
        '',
        `**${failed ? 'FAILED' : 'PASSED'}**: ${passed} passed · ${failed} failed · ${skipped} skipped · ${total} total (${pct}% pass)${durationMs !== undefined ? ` · ${formatDuration(durationMs)}` : ''}`,
        '',
        summary,
        '',
        '## Suites',
        '',
        '| Suite | Passed | Failed | Skipped | Time |',
        '|---|---:|---:|---:|---:|',
        ...r.suites.map(s => `| ${cell(s.name)} | ${s.passed} | ${s.failed} | ${s.skipped} | ${formatDuration(s.durationMs)} |`),
    ];
    if (allFailures.length) {
        lines.push('', '## Failures', '');
        for (const f of allFailures) {
            lines.push(`### ${f.suite ? `${f.suite} › ` : ''}${f.name}`, '', '```', f.message.replace(/```/g, "'''"), '```', '');
        }
    }
    return lines.join('\n');
}
