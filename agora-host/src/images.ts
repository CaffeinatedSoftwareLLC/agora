import { open, realpath, stat as pathStat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { extractImagePaths } from './image-references.js';
import type { Claim, HostApi } from './types.js';

export { extractImagePaths };
export function inside(root: string, target: string): boolean {
    const relative = path.relative(root, target);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/** Resolve links before opening, check the opened file, and cap reads at the DB limit.
 * Never follow a reference into a sibling worktree or an arbitrary user directory. */
export async function readRunImage(reference: string, cwd: string, maxBytes: number, temp = tmpdir()) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('invalid_image_limit');
    if (!extractImagePaths(`\`${reference}\``).includes(reference)) throw new Error('invalid_image_path');
    // Network/device paths and Windows alternate data streams aren't local images.
    if (/^(?:\\\\|\/\/|\\\?\\)/.test(reference) || reference.replace(/^[A-Za-z]:/, '').includes(':')) throw new Error('invalid_image_path');
    const roots = await Promise.all([realpath(cwd), realpath(temp)]);
    const resolved = await realpath(path.resolve(cwd, reference));
    if (!roots.some(root => inside(root, resolved))) throw new Error('image_outside_run');
    const expected = await pathStat(resolved);
    if (!expected.isFile() || expected.size > maxBytes) throw new Error('image_too_large_or_not_file');
    const file = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        // Catch links replaced between resolution and open (and before returning bytes).
        const stat = await file.stat();
        if (stat.dev !== expected.dev || stat.ino !== expected.ino) throw new Error('image_changed');
        if (!stat.isFile() || stat.size > maxBytes) throw new Error('image_too_large_or_not_file');
        const buffer = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
        let length = 0;
        while (length < buffer.length) {
            const read = await file.read(buffer, length, buffer.length - length, null);
            if (!read.bytesRead) break;
            length += read.bytesRead;
        }
        if (length > maxBytes || length !== stat.size) throw new Error('image_changed_or_too_large');
        const current = await realpath(path.resolve(cwd, reference));
        const after = await pathStat(current);
        if (current !== resolved || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('image_changed');
        return { resolved, buffer: buffer.subarray(0, length), filename: path.basename(resolved) };
    } finally { await file.close(); }
}

/** Only server-selected posts by this bot during this run are considered. */
export async function attachRunImages(api: HostApi, claim: Claim, cwd: string, signal?: AbortSignal,
    log: (code: string) => void = () => {}) {
    if (!api.imageMessages || !api.uploadImage) return;
    const { messages, maxBytes } = await api.imageMessages(claim, signal);
    const seen = new Set<string>();
    for (const message of messages) {
        for (const reference of extractImagePaths(message.content)) {
            if (signal?.aborted) return;
            let image;
            try { image = await readRunImage(reference, cwd, maxBytes); }
            catch { log('image_reference_skipped'); continue; }
            if (seen.has(image.resolved)) continue;
            try {
                await api.uploadImage(claim, { messageId: message.id, reference, filename: image.filename, buffer: image.buffer }, signal);
                seen.add(image.resolved);
            } catch (error) {
                // Authentication/fencing must stop the run's reporting path.
                const status = (error as { status?: number }).status;
                if (status === 401 || status === 403 || status === 404 || status === 409) throw error;
                log('image_upload_failed');
            }
        }
    }
}
