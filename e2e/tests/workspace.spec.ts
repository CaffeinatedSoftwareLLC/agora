import { test, expect, apis, openChannel, storageStateFor } from '../lib/fixtures';
import { snap } from '../lib/snap';

test.describe('task board and project context @smoke', () => {
    test('[UI-06.task-crud] create, edit, move and delete a card from the task board', async ({ page, seed }, ti) => {
        const { owner } = apis(seed);
        const ch = seed.channels.agents, name = `agents-${seed.runTag}`;
        await openChannel(page, ch, name);
        await page.getByRole('button', { name: 'Task board' }).click();
        const pane = page.locator('aside[aria-label="tasks"]');
        await expect(pane.getByRole('heading', { name: 'Tasks' })).toBeVisible();

        const title = `E2E card ${seed.runTag}`;
        await pane.getByRole('button', { name: 'New card' }).click();
        await pane.getByLabel('Card title').fill(title);
        await pane.getByLabel('Card description').fill('Lorem ipsum task for the harness.');
        await pane.getByRole('button', { name: 'Add card' }).click();
        const todo = pane.locator('section[aria-label="To do"]');
        const card = todo.getByRole('button', { name: new RegExp(title) });
        await expect(card).toBeVisible();
        await snap(page, ti, 'UI-06.task-crud', '01-card-created', `A task board pane with a To do column holding a card titled "${title}"`, { ready: card });

        // Edit (a new card may already be expanded)
        if ((await card.getAttribute('aria-expanded')) !== 'true') await card.click();
        await expect(card).toHaveAttribute('aria-expanded', 'true');
        await pane.getByRole('button', { name: 'Edit', exact: true }).click();
        await pane.getByLabel('Card title').fill(`${title} edited`);
        await pane.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(pane.getByRole('button', { name: new RegExp(`${title} edited`) })).toBeVisible();

        // Move to In progress via the Status select (persisted)
        const cardAfterEdit = pane.getByRole('button', { name: new RegExp(`${title} edited`) });
        if ((await cardAfterEdit.getAttribute('aria-expanded')) !== 'true') await cardAfterEdit.click();
        await pane.getByRole('combobox', { name: 'Status' }).selectOption({ label: 'In progress' });
        await expect(pane.locator('section[aria-label="In progress"]').getByRole('button', { name: new RegExp(`${title} edited`) })).toBeVisible();
        const tasks = (await owner.ok('GET', `/channels/${ch}/tasks`)) as any;
        const list: any[] = Array.isArray(tasks) ? tasks : (tasks.cards ?? tasks.tasks ?? []);
        expect(list.find(t => t.title === `${title} edited`)?.status).toBe('in_progress');

        // Delete
        const moved = pane.locator('section[aria-label="In progress"]').getByRole('button', { name: new RegExp(`${title} edited`) });
        if ((await moved.getAttribute('aria-expanded')) !== 'true') await moved.click();
        await pane.getByRole('button', { name: 'Delete', exact: true }).click();
        await pane.getByRole('group', { name: 'Confirm delete' }).getByRole('button', { name: 'Delete', exact: true }).click();
        await expect(pane.getByRole('button', { name: new RegExp(`${title} edited`) })).toHaveCount(0);
    });

    test('[UI-06.project-pin] owner saves project instructions; member can read but not edit', async ({ page, browser, seed }, ti) => {
        const { owner } = apis(seed);
        const ch = seed.channels.agents, name = `agents-${seed.runTag}`;
        await openChannel(page, ch, name);
        await page.getByRole('button', { name: 'Project context for agents' }).click();
        const pane = page.locator('aside[aria-label="project"]');
        await expect(pane.getByRole('heading', { name: 'Instructions' })).toBeVisible();
        const text = `Use the e2e fixtures only. Run ${seed.runTag}.`;
        await pane.getByLabel('Project instructions').fill(text);
        await pane.getByRole('button', { name: 'Save instructions' }).click();
        await expect(page.getByText('Instructions saved. Agents get them on their next wake.')).toBeVisible();
        await snap(page, ti, 'UI-06.project-pin', '01-saved', 'A project panel with saved instructions text and a confirmation message',
            { ready: pane.getByRole('heading', { name: 'Instructions' }) });
        const proj = (await owner.ok('GET', `/channels/${ch}/project`)) as any;
        expect(JSON.stringify(proj)).toContain(text);

        const mctx = await browser.newContext({ storageState: storageStateFor('member') });
        const mp = await mctx.newPage();
        await openChannel(mp, ch, name);
        await mp.getByRole('button', { name: 'Project context for agents' }).click();
        const mpane = mp.locator('aside[aria-label="project"]');
        await expect(mpane.getByText(text)).toBeVisible();
        await expect(mpane.getByLabel('Project instructions')).toHaveCount(0);
        await mctx.close();
    });
});
