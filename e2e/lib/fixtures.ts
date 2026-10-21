import fs from 'node:fs';
import path from 'node:path';
import { test as base, expect, type Page } from '@playwright/test';
import { Api } from './api';
import { artifactsDir, e2eEnv, SEED_FILE, storageStatePath } from './env';
import type { Seed } from './seed-types';
import { Sensitive, writeFailureEvidence } from './sensitive';

export function loadSeed(): Seed {
    return JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
}

type Fixtures = {
    seed: Seed;
    consoleErrors: string[];
    /** Secrets this test shows on screen; see lib/sensitive.ts. */
    sensitive: Sensitive;
    _failureEvidence: void;
};

/**
 * Base test. Default storageState = owner. On failure, writes a viewport screenshot, the
 * DOM text, the error and console errors to artifacts/<run-id>/failures/<test>/ (all
 * text, so the leak scan can read it). A test that showed a secret (`sensitive`) keeps no
 * screenshot and its text is scrubbed. Raw traces stay under secrets/ and are deleted.
 */
export const test = base.extend<Fixtures>({
    storageState: async ({}, use) => { await use(storageStatePath('owner')); },
    seed: async ({}, use) => { await use(loadSeed()); },
    consoleErrors: async ({ page }, use) => {
        const errs: string[] = [];
        page.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 500)); });
        page.on('pageerror', e => errs.push(`pageerror: ${String(e.message).slice(0, 500)}`));
        page.on('response', r => { if (r.status() >= 400) errs.push(`http ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`); });
        await use(errs);
    },
    sensitive: async ({}, use) => { await use(new Sensitive()); },
    _failureEvidence: [async ({ page, consoleErrors, sensitive }, use, testInfo) => {
        await use();
        if (testInfo.status === testInfo.expectedStatus) return;
        const dir = path.join(artifactsDir(), 'failures', testInfo.project.name,
            testInfo.titlePath.slice(1).join('__').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120));
        await writeFailureEvidence(page, dir, {
            test: testInfo.titlePath.join(' > '),
            status: testInfo.status ?? 'unknown',
            errors: testInfo.errors.map(e => e.message ?? ''),
        }, consoleErrors, sensitive);
    }, { auto: true }],
});

export { expect };

/** Wait until the app shell is rendered on a channel (observable readiness). */
export async function waitForChannel(page: Page, channelName: string) {
    await expect(page.getByPlaceholder(`Message #${channelName}`)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Loading messages...')).toHaveCount(0, { timeout: 20_000 });
}


/** API clients for the seeded actors (Bearer / Bot), for setup steps and state assertions. */
export function apis(seed: Seed) {
    const base = new Api(e2eEnv().apiURL);
    return {
        anon: base,
        owner: base.with(`Bearer ${seed.secrets.ownerToken}`),
        member: base.with(`Bearer ${seed.secrets.memberToken}`),
        bot: base.with(`Bot ${seed.secrets.botToken}`),
    };
}

/** Open a channel by id and wait for it to render. */
export async function openChannel(page: Page, channelId: string, name: string) {
    await page.goto(`/app/${channelId}`);
    await waitForChannel(page, name);
}

export function storageStateFor(user: 'owner' | 'member') { return storageStatePath(user); }
