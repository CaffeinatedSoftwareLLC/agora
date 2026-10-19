import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { attachRunImages, extractImagePaths, inside, readRunImage } from '../src/images.js';
import { isLurkRun, wakePrompt } from '../src/prompt.js';
import { parseOutput, prepare } from '../src/adapters.js';
import { claim, config, tempDir } from './helpers.js';
import { git } from '../src/workspaces.js';
import type { HostApi } from '../src/types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function dirs() {
    const t = await tempDir(); cleanups.push(t.cleanup);
    const cwd = path.join(t.dir, 'run'), temp = path.join(t.dir, 'temp'), outside = path.join(t.dir, 'outside');
    await Promise.all([cwd, temp, outside].map(p => mkdir(p)));
    return { cwd, temp, outside };
}

describe('local image references', () => {
    it('extracts relative, absolute, Windows and quoted paths; excludes remote URLs', () => {
        expect(extractImagePaths('`out/a.png` ![b](</tmp/image b.JPG>) "C:\\work\\shot.webp" bare.gif, out/a.png '
            + '[remote](https://a/b.png) https://a/c.jpeg data:image/png;base64,xxx file:///tmp/no.png'))
            .toEqual(['/tmp/image b.JPG', 'out/a.png', 'C:\\work\\shot.webp', 'bare.gif']);
    });
    it('uses path components for containment, never string prefixes', () => {
        const root = path.resolve('work');
        expect(inside(root, path.join(root, 'a.png'))).toBe(true);
        expect(inside(root, root + '-other/a.png')).toBe(false);
        expect(inside(root, path.resolve(root, '..', 'a.png'))).toBe(false);
    });
    it('reads cwd and temp images and rejects escapes, missing files, directories and oversize files', async () => {
        const { cwd, temp, outside } = await dirs();
        await Promise.all([writeFile(path.join(cwd, 'a.png'), 'abc'), writeFile(path.join(temp, 'b.png'), 'def'),
            writeFile(path.join(outside, 'c.png'), 'secret'), mkdir(path.join(cwd, 'directory.png'))]);
        expect((await readRunImage('a.png', cwd, 3, temp)).buffer.toString()).toBe('abc');
        expect((await readRunImage(path.join(temp, 'b.png'), cwd, 3, temp)).buffer.toString()).toBe('def');
        await expect(readRunImage('../outside/c.png', cwd, 100, temp)).rejects.toThrow('image_outside_run');
        await expect(readRunImage('a.png', cwd, 2, temp)).rejects.toThrow('image_too_large');
        await expect(readRunImage('directory.png', cwd, 100, temp)).rejects.toThrow('not_file');
        await expect(readRunImage('missing.png', cwd, 100, temp)).rejects.toThrow();
        await expect(readRunImage('a.png:stream.png', cwd, 100, temp)).rejects.toThrow('invalid_image_path');
    });
    it('resolves directory symlinks/junctions before allowing reads', async () => {
        const { cwd, temp, outside } = await dirs();
        await writeFile(path.join(outside, 'secret.png'), 'secret');
        await symlink(outside, path.join(cwd, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
        await expect(readRunImage('escape/secret.png', cwd, 100, temp)).rejects.toThrow('image_outside_run');
    });
    it('uploads references from posted messages once per canonical path and ignores missing files', async () => {
        const { cwd } = await dirs();
        await writeFile(path.join(cwd, 'a.png'), 'image');
        const uploadImage = vi.fn(async () => {});
        const api = { imageMessages: async () => ({ maxBytes: 100, messages: [
            { id: 'one', content: '`a.png` `missing.png`' }, { id: 'two', content: '`./a.png`' },
        ] }), uploadImage } as unknown as HostApi;
        await attachRunImages(api, claim(), cwd);
        expect(uploadImage).toHaveBeenCalledOnce();
        expect(uploadImage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ messageId: 'one', reference: 'a.png' }), undefined);
    });
});

describe('passive turns', () => {
    it.each(['quiet', 'balanced', 'vocal'] as const)('gives the %s dial and exact silent output instruction', dial => {
        const c = claim(); c.inbox[0].reason = 'lurk'; c.session.lurkMode = dial;
        expect(isLurkRun(c)).toBe(true);
        expect(wakePrompt(c)).toContain(`passive lurk run (${dial})`);
        expect(wakePrompt(c)).toContain('output exactly [pass] and post nothing');
        c.inbox.push({ ...c.inbox[0], reason: 'direct' });
        expect(isLurkRun(c)).toBe(false);
        expect(wakePrompt(c)).not.toContain('passive lurk run');
    });
    it('accepts [pass] from both CLIs while preserving token usage and failures', () => {
        const claude = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '[pass]', usage: { input_tokens: 10, output_tokens: 2 } });
        const codex = [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '[pass]' } }),
            JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } })].join('\n');
        expect(parseOutput('claude', claude, 0)).toMatchObject({ success: true, summary: null, tokensUsed: 12 });
        expect(parseOutput('codex', codex, 0)).toMatchObject({ success: true, summary: null, tokensUsed: 12 });
        expect(parseOutput('codex', codex, 1).success).toBe(false);
    });
    it('allows exact [pass] by removing the JSON schema requirement only for lurk deliveries', async () => {
        const t = await tempDir(); cleanups.push(t.cleanup);
        await git(t.dir, ['init']);
        await git(t.dir, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'fixture']);
        const c = config(t.dir), delivery = claim(); delivery.inbox[0].reason = 'lurk';
        const codex = await prepare(c, delivery); cleanups.push(codex.cleanup);
        expect(codex.args).not.toContain('--output-schema');
        c.profiles.builder.adapter = 'claude'; delivery.profile.adapter = 'claude';
        const claude = await prepare(c, delivery); cleanups.push(claude.cleanup);
        expect(claude.args).not.toContain('--json-schema');
    });
    it('accepts an otherwise successful silent CLI only for a lurk delivery', () => {
        const claude = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '', usage: { input_tokens: 10, output_tokens: 0 } });
        const codex = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 0 } });
        for (const [adapter, output] of [['claude', claude], ['codex', codex]] as const) {
            expect(parseOutput(adapter, output, 0).success).toBe(false);
            expect(parseOutput(adapter, output, 0, undefined, true)).toMatchObject({ success: true, summary: null, tokensUsed: 10 });
            expect(parseOutput(adapter, output, 1, undefined, true).success).toBe(false);
        }
        expect(parseOutput('codex', '', 0, undefined, true).success).toBe(false);
    });
});
