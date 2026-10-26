import type { LocalProfile } from './config.js';
import type { Claim } from './types.js';

/**
 * Provider-terms guardrails (docs/provider-terms.md), enforced on this host as well as on
 * the server.
 *
 * - A profile on `subscription` (the CLI's own account login) runs only for the server
 *   owner: the owner's messages, the owner's /start, and hand-offs between agents inside
 *   sessions the owner started. Consumer subscriptions are personal; letting other people
 *   drive one is what every provider's terms forbid.
 * - A profile on `api_key` gets its key from this host's environment (`apiKeyEnv`), passed
 *   to the child only. The key is never logged, stored or sent to Agora.
 * - Gemini (CLI or Antigravity) must use an API key: Google's terms call third-party access
 *   through its account login a breach. Gemini is hosted only over ACP with an API key.
 * - opencode runs only over ACP with an API key: it has no account login of its own to host,
 *   and its fallback (OpenCode Zen) would send the work to a provider the owner didn't pick.
 * - The host never reads, copies or relays a CLI's own login files or OAuth tokens.
 */

export const TERMS_DOC = 'https://github.com/CaffeinatedSoftwareLLC/agora/blob/main/docs/provider-terms.md';

export type Adapter = 'codex' | 'claude' | 'gemini' | 'opencode';

/** The environment variables each CLI reads its API key from. */
export const API_KEY_ENVS: Record<Adapter, string[]> = {
    claude: ['ANTHROPIC_API_KEY'],
    codex: ['CODEX_API_KEY', 'OPENAI_API_KEY'],
    gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    // or OPENROUTER_API_KEY_<NAME>, one key per agent (apiKeyEnvAllowed)
    opencode: ['OPENROUTER_API_KEY'],
};

/**
 * An opencode profile may read its key from `OPENROUTER_API_KEY_<NAME>`, so agents on one host
 * can each have their own OpenRouter key and credit limit. opencode reads only
 * `OPENROUTER_API_KEY`, so the host passes the key to it under that name (adapters.ts).
 */
const OPENROUTER_KEY_ENV = /^OPENROUTER_API_KEY(?:_[A-Z0-9][A-Z0-9_]{0,39})?$/;

/** Whether `name` may hold this adapter's API key. */
export function apiKeyEnvAllowed(adapter: Adapter, name: string): boolean {
    return adapter === 'opencode' ? OPENROUTER_KEY_ENV.test(name) : API_KEY_ENVS[adapter].includes(name);
}

/** The opencode provider a key variable belongs to, and the only one its runs may use; null if none. */
export function opencodeProvider(apiKeyEnv: string | undefined): { provider: string; env: string } | null {
    return apiKeyEnv && OPENROUTER_KEY_ENV.test(apiKeyEnv) ? { provider: 'openrouter', env: 'OPENROUTER_API_KEY' } : null;
}

export const GEMINI_SUBSCRIPTION_REFUSAL =
    'a gemini profile must use auth "api_key" (GEMINI_API_KEY). Google\'s Antigravity terms, section 6: '
    + '"Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach", '
    + 'and accounts have been suspended for it. Agora never hosts a Google account login: run Gemini over ACP with an API key '
    + `("protocol": "acp", "acpArgs": ["--acp"], "auth": "api_key", "apiKeyEnv": "GEMINI_API_KEY"). See ${TERMS_DOC}`;

export const GEMINI_NOT_HOSTED =
    'Gemini is hosted only over ACP with an API key: set "protocol": "acp" and "acpArgs": ["--acp"] on the gemini profile (agora-host README, "ACP agents").';

export const OPENCODE_ACP_ONLY =
    'opencode is hosted only over ACP with an API key: set "protocol": "acp", "acpArgs": ["acp"], "auth": "api_key" and "apiKeyEnv": "OPENROUTER_API_KEY" (agora-host README, "opencode and OpenRouter").';

/**
 * The ACP `authenticate` method that reads each API key variable (acp/session.ts). An
 * api_key profile on ACP must use it, so the agent can't fall back to an account login.
 * Claude Code reads ANTHROPIC_API_KEY itself, so claude needs none. opencode reads
 * OPENROUTER_API_KEY itself and offers only a terminal login, so it needs none either.
 */
export const ACP_API_KEY_METHODS: Record<string, string> = {
    GEMINI_API_KEY: 'gemini-api-key',
    GOOGLE_API_KEY: 'vertex-ai',
    CODEX_API_KEY: 'codex-api-key',
    OPENAI_API_KEY: 'openai-api-key',
};

/** A configuration problem whose message is fixed text, safe to print. */
export class HostConfigError extends Error {}

/** The host refused a claim because of the provider-terms rules. Never retried. */
export class TermsRefusal extends Error {
    constructor(public readonly code: 'subscription_owner_only' | 'run_not_approved' | 'plan_owner_only' | SiwcRunError, message: string) { super(message); }
}

/** Why a run on a ChatGPT plan (auth "siwc") can't start or didn't finish. */
export type SiwcRunError = 'siwc_not_connected' | 'siwc_scope_missing' | 'siwc_reauth_required' | 'siwc_not_eligible'
    | 'siwc_usage_limit' | 'siwc_plan_owner_mismatch' | 'siwc_refresh_unavailable';
/** Result errors a retry can't fix. siwc_refresh_unavailable stays retryable (network). */
export const NON_RETRYABLE = new Set(['host_launch_failed', 'subscription_owner_only', 'run_not_approved', 'plan_owner_only',
    'siwc_not_connected', 'siwc_scope_missing', 'siwc_reauth_required', 'siwc_not_eligible', 'siwc_plan_owner_mismatch']);

/** Every wake needs the owner's approval: asked for, or forced for Gemini on account login. */
export function needsRunApproval(profile: LocalProfile): boolean {
    return profile.requireRunApproval || (profile.adapter === 'gemini' && profile.auth === 'subscription');
}

/**
 * Check a claim against the local profile's auth mode before anything starts. The server
 * applies the same rules; this catches a stale server-side mode or a server bug.
 */
export function checkTerms(profile: LocalProfile, claim: Claim, boundUser: string | null = null): void {
    if (profile.auth === 'siwc') {
        // A ChatGPT plan is its owner's: only their own messages and commands, and hand-offs
        // inside sessions they started (docs/codex-chatgpt-plan.md)
        const owner = claim.profile.planOwnerId;
        const refuse = () => new TermsRefusal('plan_owner_only', `${claim.profile.name} runs on its plan owner's ChatGPT plan; only they can wake it.`);
        if (!owner) throw new TermsRefusal('siwc_not_connected', `${claim.profile.name} is not connected to a ChatGPT plan.`);
        // The server's binding must match the one this host saved at sign-in
        if (boundUser && boundUser !== owner) throw new TermsRefusal('siwc_plan_owner_mismatch', `${claim.profile.name} is connected for another Agora user on this host.`);
        if (!claim.session.startedByOwner) throw refuse();
        for (const item of claim.inbox) {
            if (item.reason === 'command') continue;
            // delegate: a subtask's brief or summary, posted by the server for a session it delegated
            if (item.reason === 'handoff' || item.reason === 'protocol' || item.reason === 'delegate') { if (!item.authorBot) throw refuse(); continue; }
            if (item.authorBot || item.authority === null || item.authorId !== owner) throw refuse();
        }
    }
    if (profile.auth === 'subscription') {
        const refuse = () => new TermsRefusal('subscription_owner_only',
            `${claim.profile.name} runs on the owner's personal subscription; only the owner can wake it.`);
        if (!claim.session.startedByOwner) throw refuse();
        for (const item of claim.inbox) {
            // The session notice of the owner's /start or /resume; the server gates who sends it
            if (item.reason === 'command') continue;
            // delegate: a subtask's brief or summary, posted by the server for a session it delegated
            if (item.reason === 'handoff' || item.reason === 'protocol' || item.reason === 'delegate') {
                if (!item.authorBot) throw refuse();
                continue;
            }
            // direct and lurk: the owner's own message
            if (item.authorBot || item.authority !== 'owner') throw refuse();
        }
    }
    if (needsRunApproval(profile) && !claim.run.ownerApproved)
        throw new TermsRefusal('run_not_approved', `${claim.profile.name} needs the owner's approval for every run.`);
}

/** What the host tells Agora about each profile at start. Only the variable's name. */
export function profileReport(profiles: Record<string, LocalProfile>) {
    return Object.entries(profiles).map(([name, p]) => ({
        name, adapter: p.adapter, authMode: p.auth, apiKeyEnv: p.auth === 'api_key' ? p.apiKeyEnv! : null, runApproval: needsRunApproval(p),
    }));
}

/** One line for the start-up log. */
export function describeAuth(name: string, profile: LocalProfile): string {
    const approval = needsRunApproval(profile) ? '; every run needs the owner\'s approval' : '';
    if (profile.auth === 'siwc') return `Profile ${name}: ChatGPT plan via Sign in with ChatGPT (codex app-server); only its plan owner can wake it${approval}.`;
    return profile.auth === 'api_key'
        ? `Profile ${name}: API key from ${profile.apiKeyEnv}${approval}.`
        : `Profile ${name}: account login (subscription); only the server owner can wake it${approval}.`;
}
