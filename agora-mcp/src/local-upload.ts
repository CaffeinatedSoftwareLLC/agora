import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

export interface UploadConfig { uploadRoot?: string; allowOutsideWorkdir?: boolean }

function within(root: string, file: string): boolean {
    const path = relative(root, file);
    return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** Open once, validate the real path, and stream that handle instead of rereading a path. */
export async function openLocalUpload(path: string, config: UploadConfig): Promise<{ handle: FileHandle; name: string; size: number }> {
    const root = await realpath(resolve(config.uploadRoot ?? process.cwd()));
    const target = resolve(root, path);
    if (!config.allowOutsideWorkdir && !within(root, target)) throw new Error('Upload path is outside the configured working folder.');
    const canonical = await realpath(target);
    if (!config.allowOutsideWorkdir && !within(root, canonical)) throw new Error('Upload symlink resolves outside the configured working folder.');
    if (!(await stat(canonical)).isFile()) throw new Error('Upload path must be a regular file.');
    const handle = await open(canonical, 'r');
    try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error('Upload path must be a regular file.');
        const checked = await realpath(target);
        const current = await stat(checked);
        if (checked !== canonical || current.dev !== info.dev || current.ino !== info.ino) throw new Error('Upload path changed while opening the file. Try again.');
        return { handle, name: basename(target), size: info.size };
    } catch (error) { await handle.close(); throw error; }
}
