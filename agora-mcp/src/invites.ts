import { createHash } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, loadUploadConfig, type AgoraMcpConfig } from './config.js';

export function parseInvite(value: string): string {
    if (/^[a-f0-9]{64}$/.test(value)) return value;
    try {
        const code = new URLSearchParams(new URL(value).hash.slice(1)).get('agora-invite');
        if (code && /^[a-f0-9]{64}$/.test(code)) return code;
    } catch { /* Invalid link. */ }
    throw new Error('Invalid Agora invite. Copy a fresh invite code or link from Bot Management.');
}

export async function loadStartupConfig(args: string[], options: {
    credentialDir?: string;
    fetch?: typeof fetch;
} = {}): Promise<AgoraMcpConfig> {
    const arg = (key: string) => {
        const index = args.indexOf(key);
        if (index < 0) return undefined;
        if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${key}`);
        return args[index + 1];
    };
    const invite = arg('--invite') ?? process.env.AGORA_INVITE;
    if (!invite) return loadConfig(args);
    if (args.includes('--token') || args.includes('--config')) throw new Error('Use --invite without --token or --config.');
    const code = parseInvite(invite);
    const rawInstance = arg('--instance') ?? process.env.AGORA_INSTANCE;
    if (!rawInstance) throw new Error('An invite requires --instance <url> or AGORA_INSTANCE.');
    const url = new URL(rawInstance);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
        throw new Error('Agora instance must be an origin URL without credentials, path, query or fragment.');
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
        throw new Error('Use HTTPS for remote Agora instances, or HTTP on localhost.');
    }
    const instance = url.origin;
    const defaultChannel = arg('--channel') ?? process.env.AGORA_DEFAULT_CHANNEL;
    const uploadConfig = loadUploadConfig(args);
    const directory = options.credentialDir ?? join(homedir(), '.agora', 'credentials');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // mkdir's mode only applies when it creates the directory; tighten a pre-existing one too.
    if (process.platform !== 'win32') await chmod(directory, 0o700).catch(() => {});
    // Include the invite in the digest so different agents on one instance stay distinct.
    const key = createHash('sha256').update(`${instance}\n${code}`).digest('hex');
    const path = join(directory, `${key}.json`);
    const cached = async (): Promise<AgoraMcpConfig | undefined> => {
        try {
            const raw = await readFile(path, 'utf8');
            let saved;
            try { saved = JSON.parse(raw); }
            catch { throw new Error('Invalid saved Agora credentials. Request a fresh invite.'); }
            if (!saved || saved.instance !== instance || typeof saved.token !== 'string' || !saved.token.startsWith('bot_')) {
                throw new Error('Invalid saved Agora credentials.');
            }
            return { instance, token: saved.token, defaultChannel, ...uploadConfig };
        } catch (error: any) {
            if (error.code === 'ENOENT') return undefined;
            throw error;
        }
    };
    const existing = await cached();
    if (existing) return existing;
    // Serialize simultaneous MCP starts locally before consuming the single-use invite.
    const lockPath = `${path}.lock`;
    let lock;
    for (let attempt = 0; attempt < 100; attempt++) {
        try { lock = await open(lockPath, 'wx', 0o600); break; }
        catch (error: any) {
            if (error.code !== 'EEXIST') throw error;
            const saved = await cached();
            if (saved) return saved;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    if (!lock) throw new Error('Another Agora invite redemption is running. Retry in 10 seconds; if it crashed, remove the .lock file in ~/.agora/credentials.');
    const temporary = `${path}.tmp`;
    try {
        const saved = await cached();
        if (saved) return saved;
        // We hold the lock, so a leftover temp file is from a crashed run; clear it.
        await unlink(temporary).catch(() => {});
        // Preflight local storage before consuming the invite. Never log response bodies/tokens.
        const file = await open(temporary, 'wx', 0o600);
        try {
            const response = await (options.fetch ?? fetch)(`${instance}/agent-invites/redeem`, {
                method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
            });
            if (!response.ok) throw new Error(`Agora invite redemption failed (${response.status}). Request a fresh invite if used or expired.`);
            const data = await response.json().catch(() => {
                throw new Error('Agora returned invalid credentials.');
            }) as { token?: string };
            if (!data || typeof data.token !== 'string' || !data.token.startsWith('bot_')) throw new Error('Agora returned invalid credentials.');
            await file.writeFile(JSON.stringify({ instance, token: data.token }));
            await file.sync();
        } finally { await file.close(); }
        await rename(temporary, path);
        return (await cached())!;
    } finally {
        await unlink(temporary).catch(() => {});
        await lock.close();
        await unlink(lockPath);
    }
}
