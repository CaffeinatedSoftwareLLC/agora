import crypto from 'node:crypto';
import type { Browser, Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { apis } from './fixtures';
import { e2eEnv } from './env';
import type { Seed } from './seed-types';

/** A run-tagged name that is also unique within the run (retries, --repeat-each). */
export const uniq = (seed: Seed, prefix: string) => `${prefix}-${seed.runTag}-${crypto.randomBytes(2).toString('hex')}`;

/** A fresh run-tagged text channel, so counts in it are exact whatever else the instance holds. */
export async function freshChannel(seed: Seed, prefix: string): Promise<{ id: string; name: string }> {
    const { owner } = apis(seed);
    const name = uniq(seed, prefix);
    const ch = (await owner.ok('POST', `/servers/${seed.serverId}/channels`, { name, channelType: 3 }, [201])) as any;
    return { id: ch.id.trim(), name };
}

/** Message rows (virtualized list items) containing the text. */
export const rowWith = (page: Page, text: string) => page.locator('[data-index]').filter({ hasText: text });

/** The console strip above the channel: agent chips, then the active-thread chips. */
export const activeThreadsBar = (page: Page) => page.getByRole('toolbar', { name: 'Agents and active threads' });

/** The active-thread chip whose label starts "Open thread" and contains the text. */
export const threadChip = (page: Page, text: string) =>
    activeThreadsBar(page).getByRole('button', { name: new RegExp('^Open thread.*' + text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });

/**
 * Make the thread chips visible before asserting on one. The strip can keep them collapsed
 * behind a "Threads" toggle (closed by default in a fresh browser, remembered in localStorage),
 * so open it when it shows collapsed; with no toggle, or one already open, this only waits.
 * Never throws: the caller's assertion on the chip reports a failure.
 */
export async function revealThreadChips(page: Page, chip: Locator, timeout = 10_000): Promise<void> {
    const collapsed = activeThreadsBar(page).locator('[data-testid="threads-toggle"][aria-expanded="false"]');
    await chip.or(collapsed).first().waitFor({ state: 'visible', timeout }).catch(() => {});
    if (await collapsed.isVisible().catch(() => false)) await collapsed.click().catch(() => {});
}

export const sha256 = (b: Buffer | Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');

/** Log a user in through the real login page in a new context (for users without a saved storageState). */
export async function loginPage(browser: Browser, username: string, password: string): Promise<Page> {
    // Explicitly empty: inside a test, newContext would otherwise inherit the owner's storageState
    const ctx = await browser.newContext({ baseURL: e2eEnv().baseURL, storageState: { cookies: [], origins: [] } });
    const page = await ctx.newPage();
    await page.goto('/login');
    await page.getByLabel('Username or email').fill(username);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL(/\/app/, { timeout: 20_000 });
    await expect(page.getByPlaceholder(/^Message #/)).toBeVisible({ timeout: 20_000 });
    return page;
}

/**
 * Replace every occurrence of a secret in the page's text nodes and input values, so a
 * screenshot's DOM text (and pixels) never carry it. Use together with snap's mask option.
 */
export async function scrubText(page: Page, secret: string, replacement = '[masked]') {
    await page.evaluate(([s, r]) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (n.nodeValue && n.nodeValue.includes(s)) n.nodeValue = n.nodeValue.split(s).join(r);
        }
        for (const el of Array.from(document.querySelectorAll('input, textarea')) as HTMLInputElement[]) {
            if (el.value.includes(s)) el.value = el.value.split(s).join(r);
        }
    }, [secret, replacement] as const);
}

/** Bot actor for a bot this spec created (not the seeded agents, which other specs use). */
export async function makeBot(seed: Seed, username: string, channelIds: string[]) {
    const { owner } = apis(seed);
    const bot = (await owner.ok('POST', `/servers/${seed.serverId}/bots`, { username }, [201])) as any;
    const botId: string = bot.id.trim();
    const tok = (await owner.ok('POST', `/servers/${seed.serverId}/bots/${botId}/tokens`, {}, [201])) as any;
    for (const ch of channelIds) await owner.ok('POST', `/channels/${ch}/bots/${botId}`, undefined, [200, 201]);
    return { botId, api: apis(seed).anon.with(`Bot ${tok.token}`) };
}
