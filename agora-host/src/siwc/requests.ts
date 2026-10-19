import { spawn } from 'node:child_process';
import type { Config } from '../config.js';
import { fatalAuth, HttpError } from '../client.js';
import type { HostApi, PlanRequest, PlanStatus } from '../types.js';
import { SiwcError } from './oauth.js';
import { DEFAULT_DIR } from './store.js';
import { bindAgoraUser, login, logout, planState } from './session.js';

/**
 * The host side of Settings → Agents "Continue with ChatGPT" (docs/codex-chatgpt-plan.md):
 * pick up a connect or disconnect request for one of this host's siwc profiles, run the
 * sign-in in this machine's browser, report the outcome. Reports carry a status, a fixed
 * error code and the account's email, never a token.
 */

const CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** Open the system browser without a shell (the URL carries no token). */
export async function openBrowser(url: string): Promise<void> {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
    await new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, { stdio: 'ignore', shell: false, windowsHide: true });
        child.once('error', () => reject(new SiwcError('browser_unavailable', 'The browser could not be opened on this host.')));
        child.once('exit', code => code === 0 || process.platform === 'win32' ? resolve() : reject(new SiwcError('browser_unavailable', 'The browser could not be opened on this host.')));
    });
}

export interface PlanLoopOptions {
    signal: AbortSignal;
    log(code: string): void;
    pause(ms: number): Promise<void>;
    stopping(): boolean;
    pollMs?: number;
    /** Injected in tests. */
    open?(url: string): Promise<void>;
    fetch?: typeof fetch;
    issuer?: string;
    loginTimeoutMs?: number;
}

const siwcProfiles = (config: Config) => Object.entries(config.profiles).filter(([, p]) => p.auth === 'siwc').map(([name]) => name);

/** Handle one request; exported for tests. */
export async function handlePlanRequest(config: Config, api: HostApi, req: PlanRequest, o: PlanLoopOptions): Promise<void> {
    const dir = config.siwc?.dir ?? DEFAULT_DIR;
    const env = { dir, profile: req.profile, ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.issuer ? { issuer: o.issuer } : {}) };
    const report = async (status: PlanStatus, extra: { error?: string | null; accountLabel?: string | null } = {}) =>
        api.reportPlan!(req.profile, { status, ...extra }, o.signal);
    if (config.profiles[req.profile]?.auth !== 'siwc') { await report('failed', { error: 'siwc_not_configured' }); return; }
    try {
        if (req.action === 'disconnect') {
            const { revoked } = await logout(env);
            await report('disconnected', { error: revoked ? null : 'revocation_unconfirmed' });
            return;
        }
        // After an earlier decline, ask for consent again so plan use can be allowed
        const before = await planState(env);
        o.log('siwc_sign_in_started');
        const result = await login({ ...env, port: config.siwc?.callbackPort ?? 1455, openBrowser: o.open ?? openBrowser,
            agoraUserId: req.requestedBy ?? undefined, reconsent: before.state === 'scope_missing', timeoutMs: o.loginTimeoutMs });
        const bound = await report(result.state, { accountLabel: result.email });
        if (bound.planOwnerId) await bindAgoraUser(env, bound.planOwnerId);
        o.log(result.state === 'connected' ? 'siwc_connected' : 'siwc_scope_missing');
    } catch (err) {
        if (fatalAuth(err) || (err instanceof HttpError)) throw err;
        const code = err instanceof SiwcError && CODE.test(err.code) ? err.code : 'siwc_sign_in_failed';
        o.log(code);
        await report('failed', { error: code });
    }
}

/** Tell Agora each siwc profile's state at start (connected ones only; a pending request wins). */
export async function reportPlanStates(config: Config, api: HostApi, o: Pick<PlanLoopOptions, 'signal' | 'log'>): Promise<void> {
    if (!api.reportPlan) return;
    const dir = config.siwc?.dir ?? DEFAULT_DIR;
    for (const profile of siwcProfiles(config)) {
        try {
            const s = await planState({ dir, profile });
            if (s.state !== 'connected' && s.state !== 'scope_missing') continue;
            const bound = await api.reportPlan(profile, { status: s.state, accountLabel: s.email }, o.signal);
            if (bound.planOwnerId && !s.agoraUserId) await bindAgoraUser({ dir, profile }, bound.planOwnerId);
        } catch (err) {
            if (err instanceof HttpError && err.status === 404) continue;
            o.log('siwc_state_report_failed');
        }
    }
}

export async function planLoop(config: Config, api: HostApi, o: PlanLoopOptions): Promise<void> {
    if (!api.claimPlanRequest || !api.reportPlan || siwcProfiles(config).length === 0) return;
    await reportPlanStates(config, api, o);
    while (!o.stopping()) {
        try {
            const req = await api.claimPlanRequest(o.signal);
            if (!req) { await o.pause(o.pollMs ?? 3000); continue; }
            await handlePlanRequest(config, api, req, o);
        } catch (err) {
            if (o.stopping()) return;
            if (fatalAuth(err)) { o.log('host_auth_rejected'); return; }
            // An older server without plan connections: stop polling, runs keep working
            if (err instanceof HttpError && err.status === 404) { o.log('plan_requests_unsupported'); return; }
            o.log('plan_request_failed');
            await o.pause(3000);
        }
    }
}
