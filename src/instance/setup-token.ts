import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Get the setup token for initial instance configuration.
 *
 * Priority:
 * 1. AGORA_SETUP_TOKEN env var (if set)
 * 2. Read from .agora/setup-token file (if exists)
 * 3. Generate new token, persist to file, log to console
 */
export async function getSetupToken(): Promise<string> {
    // 1. Check env var
    const envToken = process.env.AGORA_SETUP_TOKEN;
    if (envToken) {
        return envToken;
    }

    // 2. Check persisted token file
    const dataDir = process.env.AGORA_DATA_DIR || path.join(process.cwd(), '.agora');
    const tokenPath = path.join(dataDir, 'setup-token');

    try {
        const token = fs.readFileSync(tokenPath, 'utf-8').trim();
        if (token.length > 0) {
            return token;
        }
    } catch {
        // File doesn't exist or can't be read — generate new token
    }

    // 3. Generate and persist
    const token = crypto.randomBytes(32).toString('hex');

    // Create directory if needed
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(tokenPath, token, 'utf-8');

    console.log('');
    console.log('='.repeat(60));
    console.log('  AGORA SETUP TOKEN (use this to complete initial setup):');
    console.log(`  ${token}`);
    console.log('='.repeat(60));
    console.log('');

    return token;
}
