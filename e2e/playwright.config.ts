import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { e2eEnv, runId, SECRETS_DIR } from './lib/env';

// Fixed for the whole run: workers inherit it from this process.
runId();
const { baseURL } = e2eEnv();

export default defineConfig({
    testDir: './tests',
    // Raw Playwright output (traces, videos, failure screenshots) holds cookies and request
    // bodies, so it lives under secrets/ and is deleted on teardown. Sanitized failure
    // evidence is copied to artifacts/<run-id>/failures by the fixture in lib/fixtures.ts.
    outputDir: path.join(SECRETS_DIR, 'test-results'),
    globalSetup: './global-setup.ts',
    fullyParallel: false,
    workers: 1,
    retries: 0,
    timeout: 60_000,
    expect: { timeout: 10_000 },
    reporter: [['list'], ['./lib/summary-reporter.ts']],
    use: {
        baseURL,
        trace: 'retain-on-failure',
        screenshot: 'off',
        video: 'off',
        reducedMotion: 'reduce',
        actionTimeout: 10_000,
    },
    projects: [
        {
            name: 'desktop-chromium',
            testIgnore: /mobile\.spec\.ts/,
            use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
        },
        {
            name: 'pixel-7',
            testMatch: /mobile\.spec\.ts/,
            use: { ...devices['Pixel 7'] },
        },
    ],
});
