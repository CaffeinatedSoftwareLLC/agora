import fs from 'node:fs';
import path from 'node:path';
import type { Page, Locator, TestInfo } from '@playwright/test';
import { artifactsDir, runId } from './env';

export interface ManifestEntry {
    run_id: string;
    scenario_id: string;
    step: string;
    expectation: string;
    file: string;          // PNG, relative to the run dir
    text_file: string;     // DOM text captured with the PNG (for the leak scan)
    project: string;
    viewport: { width: number; height: number } | null;
    test_title: string;
    captured_at: string;
}

function safe(s: string) {
    return s.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
}

/**
 * Screenshot a visual state after an explicit readiness condition, plus the page's DOM
 * text next to it, and append a manifest line. Readiness is the caller's job: pass the
 * element that proves the state is rendered (never networkidle).
 */
export async function snap(
    page: Page,
    testInfo: TestInfo,
    scenarioId: string,
    step: string,
    expectation: string,
    opts: { ready?: Locator; mask?: Locator[]; fullPage?: boolean } = {},
): Promise<string> {
    if (opts.ready) await opts.ready.waitFor({ state: 'visible', timeout: 15_000 });
    await page.evaluate(() => (document as any).fonts?.ready).catch(() => undefined);
    const dir = artifactsDir();
    const sub = path.join('screens', safe(testInfo.project.name), safe(scenarioId));
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
    const base = path.join(sub, safe(step));
    const png = `${base}.png`;
    const txt = `${base}.txt`;
    await page.screenshot({
        path: path.join(dir, png),
        animations: 'disabled',
        caret: 'hide',
        fullPage: opts.fullPage ?? false,
        mask: opts.mask,
    });
    const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    fs.writeFileSync(path.join(dir, txt), text);
    const entry: ManifestEntry = {
        run_id: runId(),
        scenario_id: scenarioId,
        step,
        expectation,
        file: png.split(path.sep).join('/'),
        text_file: txt.split(path.sep).join('/'),
        project: testInfo.project.name,
        viewport: page.viewportSize(),
        test_title: testInfo.titlePath.join(' > '),
        captured_at: new Date().toISOString(),
    };
    fs.appendFileSync(path.join(dir, 'manifest.jsonl'), JSON.stringify(entry) + '\n');
    return path.join(dir, png);
}
