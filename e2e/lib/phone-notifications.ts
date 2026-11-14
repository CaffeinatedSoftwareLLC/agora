import type { Page, TestInfo } from '@playwright/test';
import { apis, expect, openChannel } from './fixtures';
import { freshChannel } from './helpers';
import { snap } from './snap';
import type { Seed } from './seed-types';

/**
 * The phone notifications list sits above the channel: opaque, rows that do not overlap, taps
 * that land on the notification (not the messages behind), Back that closes it. The bell lives in
 * a header with a backdrop-filter; a `fixed` list inside it was laid out against the 48px header
 * and painted under the message list.
 */
export async function checkPhoneNotifications(page: Page, seed: Seed, ti: TestInfo) {
    const { member } = apis(seed);
    // Real route: the member @mentions the owner, one channel each (a channel's mentions are de-duplicated)
    const channels: { id: string; name: string }[] = [];
    for (let i = 0; i < 6; i++) {
        const ch = await freshChannel(seed, `notif${i}`);
        await member.ok('POST', `/channels/${ch.id}/messages`, { content: `@${seed.users.owner.username} please look at this, it is a long message ${i}` }, [201]);
        channels.push(ch);
    }
    const target = channels[0]!;
    // The channel behind the list has plenty of messages, so there is something to fall through to
    const behind = channels[1]!;
    for (let i = 0; i < 10; i++) await member.ok('POST', `/channels/${behind.id}/messages`, { content: `Filler message ${i} with some words on it` }, [201]);
    await openChannel(page, behind.id, behind.name);

    await page.getByRole('button', { name: /^Notifications/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Notifications' });
    await expect(dialog).toBeVisible();
    const rows = dialog.getByRole('list', { name: 'Notification list' }).getByRole('button');
    await expect(rows.first()).toBeVisible();
    await snap(page, ti, 'UI-08.phone-notifications', '01-open', 'The notifications list over a channel: opaque, one row per notification, nothing overlapping', { ready: rows.first() });

    // Opaque, above the page
    const bg = await dialog.evaluate(el => getComputedStyle(el).backgroundColor);
    expect(bg, 'notifications surface has a background').not.toMatch(/rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)|transparent/);
    const geometry = await dialog.evaluate(el => {
        const box = el.getBoundingClientRect();
        const list = [...el.querySelectorAll('ul li button')].map(b => {
            const r = b.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, Math.min(r.top + r.height / 2, box.bottom - 1));
            return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, inside: r.bottom <= box.bottom + 0.5 && r.top >= box.top - 0.5, hitInside: !!hit && el.contains(hit) };
        });
        return { box: { left: box.left, right: box.right }, list, vw: innerWidth };
    });
    expect(geometry.list.length).toBeGreaterThanOrEqual(6);
    expect(geometry.box.left).toBeGreaterThanOrEqual(0);
    expect(geometry.box.right).toBeLessThanOrEqual(geometry.vw);
    for (let i = 1; i < geometry.list.length; i++) {
        expect(geometry.list[i]!.top, `row ${i} starts below row ${i - 1}`).toBeGreaterThanOrEqual(geometry.list[i - 1]!.bottom - 0.5);
    }
    for (const [i, r] of geometry.list.entries()) if (r.inside) expect(r.hitInside, `a tap on row ${i} lands on the notification`).toBe(true);

    // Back closes it and stays on the channel
    await page.goBack();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/app/${behind.id}`));

    // A tap on a row opens that channel and marks it read
    await page.getByRole('button', { name: /^Notifications/ }).click();
    await dialog.getByRole('button', { name: new RegExp(`#${target.name}$`) }).click();
    await expect(page).toHaveURL(new RegExp(`/app/${target.id}`));
    await expect(dialog).toHaveCount(0);
}
