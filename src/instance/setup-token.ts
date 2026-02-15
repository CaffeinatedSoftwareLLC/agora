import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// Process-lifetime cache. Once resolved, the token never changes until restart.
let cachedToken: string | null = null;

/**
 * Get the setup token for initial instance configuration.
 *
 * Priority:
 * 1. AGORA_SETUP_TOKEN env var (if set)
 * 2. Read from .agora/setup-token file (if exists)
 * 3. Generate new token, attempt to persist to file, cache in memory
 *
 * The result is cached for the lifetime of the process. Even if persistence
 * fails (read-only filesystem), the token remains stable across calls.
 */
export async function getSetupToken(): Promise<string> {
    if (cachedToken !== null) {
        return cachedToken;
    }

    // 1. Check env var
    const envToken = process.env.AGORA_SETUP_TOKEN;
    if (envToken) {
        cachedToken = envToken;
        return cachedToken;
    }

    // 2. Check persisted token file
    const dataDir = process.env.AGORA_DATA_DIR || path.join(process.cwd(), '.agora');
    const tokenPath = path.join(dataDir, 'setup-token');

    try {
        const token = fs.readFileSync(tokenPath, 'utf-8').trim();
        if (token.length > 0) {
            cachedToken = token;
            return cachedToken;
        }
    } catch {
        // File doesn't exist or can't be read — generate new token
    }

    // 3. Generate and attempt to persist
    const token = crypto.randomBytes(32).toString('hex');
    cachedToken = token;

    try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(tokenPath, token, 'utf-8');
    } catch (err) {
        console.error('');
        console.error('='.repeat(60));
        console.error('  WARNING: Could not persist setup token to disk.');
        console.error(`  Path: ${tokenPath}`);
        console.error(`  Error: ${(err as Error).message}`);
        console.error('  The token below will NOT survive a process restart.');
        console.error('  Set AGORA_SETUP_TOKEN env var for a stable token.');
        console.error('='.repeat(60));
    }

    console.log('');
    console.log('='.repeat(60));
    console.log('  AGORA SETUP TOKEN (use this to complete initial setup):');
    console.log(`  ${token}`);
    console.log('='.repeat(60));
    console.log('');

    return cachedToken;
}

/** Reset the cached token. For testing only. */
export function resetSetupTokenCache(): void {
    cachedToken = null;
}
