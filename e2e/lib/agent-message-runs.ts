import type { Page, TestInfo } from '@playwright/test';
import { apis, expect, openChannel } from './fixtures';
import { freshChannel, makeBot, uniq } from './helpers';
import { snap } from './snap';
import type { Seed } from './seed-types';

/** Shared desktop/phone check; Claude runs against the isolated E2E stack. */
export async function checkAgentMessageRuns(page: Page, seed: Seed, ti: TestInfo) {
    const { owner } = apis(seed);
    const ch = await freshChannel(seed, 'agent-runs');
    const claudeName = uniq(seed, 'Claude');
    const codexName = uniq(seed, 'Codex');
    const claude = await makeBot(seed, claudeName, [ch.id]);
    const codex = await makeBot(seed, codexName, [ch.id]);
    await owner.ok('PATCH', `/channels/${ch.id}/bot-config`, { maxBotHops: 0 }, [200]);
    await owner.ok('POST', `/channels/${ch.id}/messages`, { content: 'Please continue the review.' }, [201]);
    await claude.api.ok('POST', `/channels/${ch.id}/messages`, {
        content: '[AGORA/v1 MODE=fix STATE=TURN]\nFirst review update.\n[YIELD to=Codex]',
    }, [201]);
    await codex.api.ok('POST', `/channels/${ch.id}/messages`, { content: 'Second review update.' }, [201]);
    await claude.api.ok('POST', `/channels/${ch.id}/messages`, { content: 'Third review update.' }, [201]);
    const title = 'Review notes';
    await claude.api.ok('POST', `/channels/${ch.id}/messages`, {
        content: 'The review card stays visible.', artifact: { title, kind: 'markdown', content: '# Review complete' },
    }, [201]);
    await owner.ok('POST', `/channels/${ch.id}/messages`, { content: 'Thanks, keep the card visible.' }, [201]);
    await openChannel(page, ch.id, ch.name);
    const toggle = page.getByRole('button', { name: `3 agent messages (${claudeName}, ${codexName})` });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByText('Second review update.', { exact: true })).toBeHidden();
    await expect(page.getByText('Thanks, keep the card visible.', { exact: true })).toBeVisible();
    const card = page.getByRole('button', { name: `Open ${title} in the canvas` });
    await expect(card).toBeVisible();
    const bounds = await toggle.boundingBox();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(bounds!.width).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await snap(page, ti, 'UI-02.agent-runs', '01-collapsed', 'One compact agent-message drawer; human replies and the review card remain visible', { ready: toggle });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText('Second review update.', { exact: true })).toBeVisible();
    await expect(page.getByText('TURN', { exact: true })).toBeVisible();
    await expect(card).toBeVisible();
    await snap(page, ti, 'UI-02.agent-runs', '02-expanded', 'Agent messages open with the TURN protocol badge; the review card remains usable', { ready: toggle });
    await page.reload();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByText('Second review update.', { exact: true })).toBeHidden();
    await expect(card).toBeVisible();
}
