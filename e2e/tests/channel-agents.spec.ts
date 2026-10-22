import { test, expect, openChannel } from '../lib/fixtures';
import { freshChannel, makeBot, uniq } from '../lib/helpers';

test('[UI-02.channel-agents] opening a channel avoids bot-detail fan-out; the dialog searches and changes membership', async ({ page, seed }) => {
    const channel = await freshChannel(seed, 'agent-list');
    const name = uniq(seed, 'addable-agent');
    await makeBot(seed, name, []);
    const reads: string[] = [];
    page.on('request', request => { if (request.method() === 'GET') reads.push(new URL(request.url()).pathname); });
    await openChannel(page, channel.id, channel.name);
    await expect(page.getByText('No agents in this channel ·', { exact: true })).toBeVisible();
    const details = () => reads.filter(path => /^\/servers\/[^/]+\/bots\/[^/]+$/.test(path));
    expect(details()).toHaveLength(0);
    expect(reads.filter(path => path === `/channels/${channel.id}/bots`)).toHaveLength(1);
    await page.getByRole('button', { name: 'Add agent to channel' }).click();
    const dialog = page.getByRole('dialog', { name: 'Channel agents' });
    await expect(dialog.getByRole('button', { name: 'Search', exact: true })).toBeEnabled();
    await dialog.getByRole('textbox', { name: 'Search agents' }).fill(name);
    await dialog.getByRole('button', { name: 'Search', exact: true }).click();
    await dialog.getByRole('button', { name: `Add ${name}`, exact: true }).click();
    await expect(dialog.getByRole('button', { name: `Remove ${name}`, exact: true })).toBeVisible();
    await expect(page.getByText('No agents in this channel ·', { exact: true })).toBeHidden();
    expect(details()).toHaveLength(0);
    expect(reads.filter(path => path === `/channels/${channel.id}/bots`)).toHaveLength(3);
    await dialog.getByRole('button', { name: `Remove ${name}`, exact: true }).click();
    await expect(page.getByText('No agents in this channel ·', { exact: true })).toBeVisible();
});
