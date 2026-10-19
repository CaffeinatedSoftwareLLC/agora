import { loadConfig } from '../config.js';
import { Client, HttpError } from '../client.js';
import { SiwcError, USAGE_URL } from './oauth.js';
import { DEFAULT_DIR } from './store.js';
import { bindAgoraUser, login, logout, planState } from './session.js';
import { openBrowser } from './requests.js';

/**
 * `agora-host siwc login|status|logout --profile <name> --config <file>`: Sign in with ChatGPT
 * for one codex profile on this machine (docs/codex-chatgpt-plan.md). Prints fixed text and
 * the account's email only; tokens stay in the credential file.
 */
export async function siwcCommand(argv: string[], out: (line: string) => void = console.log): Promise<number> {
    const action = argv[0];
    const flag = (name: string) => { const i = argv.indexOf(name); return i > 0 ? argv[i + 1] : undefined; };
    const profile = flag('--profile'); const configPath = flag('--config');
    if (!['login', 'status', 'logout'].includes(action ?? '') || !profile || !configPath) {
        out('Usage: agora-host siwc <login|status|logout> --profile <name> --config <absolute-file>');
        return 2;
    }
    const config = await loadConfig(configPath);
    const local = config.profiles[profile];
    if (local?.auth !== 'siwc') { out(`Profile "${profile}" is not a codex profile with "auth": "siwc" in this config.`); return 2; }
    const dir = config.siwc?.dir ?? DEFAULT_DIR;
    const client = new Client(config.instance, config.hostToken);
    const tell = async (status: 'connected' | 'scope_missing' | 'disconnected', accountLabel: string | null) => {
        try {
            const bound = await client.reportPlan(profile, { status, accountLabel });
            if (bound.planOwnerId && status !== 'disconnected') await bindAgoraUser({ dir, profile }, bound.planOwnerId);
        } catch (err) { out(err instanceof HttpError ? `Agora did not take the update (HTTP ${err.status}); the host reports it again at its next start.` : 'Agora could not be reached; the host reports the connection at its next start.'); }
    };
    try {
        if (action === 'status') {
            const s = await planState({ dir, profile });
            out(`Profile ${profile}: ${s.state.replace('_', ' ')}${s.email ? ` (${s.email})` : ''}. Usage: ${USAGE_URL}`);
            return 0;
        }
        if (action === 'logout') {
            const { revoked } = await logout({ dir, profile });
            out(revoked ? 'Signed out of ChatGPT for this profile.'
                : 'Local credentials were removed, but remote sign-out could not be confirmed. Disconnect Agora in ChatGPT Settings.');
            await tell('disconnected', null);
            return 0;
        }
        const before = await planState({ dir, profile });
        out('Opening your browser for Sign in with ChatGPT. Choose the account whose plan this agent should use.');
        const result = await login({ dir, profile, port: config.siwc?.callbackPort ?? 1455, openBrowser, reconsent: before.state === 'scope_missing' });
        out(result.state === 'connected'
            ? `Connected${result.email ? ` as ${result.email}` : ''}. This agent now runs on your ChatGPT plan. Manage usage: ${USAGE_URL}`
            : 'Signed in, but ChatGPT plan use was not allowed. Run login again and allow it, or use an API key profile.');
        await tell(result.state, result.email);
        return result.state === 'connected' ? 0 : 1;
    } catch (err) {
        out(err instanceof SiwcError ? `${err.message} (${err.code})` : 'Sign in with ChatGPT failed.');
        return 1;
    }
}
