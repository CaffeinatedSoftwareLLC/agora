/**
 * Test API keys for the real-CLI agent E2E (beta-test-plan §3.1, §2.4 "Host child environments").
 *
 * - The keys are `AGORA_TEST_ANTHROPIC_KEY`, `AGORA_TEST_OPENAI_KEY` and `AGORA_TEST_GEMINI_KEY`,
 *   read from the environment, else from %USERPROFILE%\.agora-test\keys.env (same format as
 *   vision-judge.ts). The file is read only when `E2E_AGENT_LIVE=1`.
 * - Values stay in this module's memory. They are never copied into the test runner's
 *   `process.env`, never written to disk and never logged: lib/agent-host.ts puts each one into
 *   the agora-host child's environment under the provider's own variable name, and
 *   lib/finalize.ts asks `agentKeysForScan()` for them so the leak scan looks for the values.
 * - Live runs are refused unless `E2E_AGENT_LIVE=1` and all three keys are present.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type AgentAdapter = 'claude' | 'codex' | 'gemini';

/** The runner's variable for each adapter's test key. */
export const TEST_KEY_VARS: Record<AgentAdapter, string> = {
    claude: 'AGORA_TEST_ANTHROPIC_KEY',
    codex: 'AGORA_TEST_OPENAI_KEY',
    gemini: 'AGORA_TEST_GEMINI_KEY',
};

/**
 * The provider variable agora-host passes to each CLI (it accepts only these names, see
 * agora-host/src/terms.ts API_KEY_ENVS). Codex accepts OPENAI_API_KEY (plan §3.1, the default)
 * or CODEX_API_KEY; `E2E_CODEX_KEY_ENV=CODEX_API_KEY` switches it.
 */
export function providerKeyEnv(adapter: AgentAdapter): string {
    if (adapter === 'claude') return 'ANTHROPIC_API_KEY';
    if (adapter === 'gemini') return 'GEMINI_API_KEY';
    const v = process.env.E2E_CODEX_KEY_ENV ?? 'OPENAI_API_KEY';
    if (v !== 'OPENAI_API_KEY' && v !== 'CODEX_API_KEY') throw new Error('E2E_CODEX_KEY_ENV must be OPENAI_API_KEY or CODEX_API_KEY');
    return v;
}

/** Every provider variable any CLI could read: always removed from the host child's inherited env. */
export const PROVIDER_ENVS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY',
    'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_GENAI_USE_VERTEXAI'];

export const KEYS_FILE = path.join(os.homedir(), '.agora-test', 'keys.env');
export const LIVE_BLOCKED = 'blocked: E2E_AGENT_LIVE not set (owner approval pending)';

let cache: Partial<Record<AgentAdapter, string>> | null = null;

function fromFile(): Record<string, string> {
    const out: Record<string, string> = {};
    if (!fs.existsSync(KEYS_FILE)) return out;
    for (const line of fs.readFileSync(KEYS_FILE, 'utf8').split(/\r?\n/)) {
        const m = /^\s*(?:export\s+)?(AGORA_TEST_[A-Z]+_KEY)\s*=\s*["']?([^"'\s]+)["']?/.exec(line);
        if (m) out[m[1]] = m[2];
    }
    return out;
}

/** True when the owner asked for a live run. Nothing else in this module reads a key without it. */
export const liveRequested = () => process.env.E2E_AGENT_LIVE === '1';

/** The test keys, in memory. Only when E2E_AGENT_LIVE=1. */
function load(): Partial<Record<AgentAdapter, string>> {
    if (!liveRequested()) return {};
    if (cache) return cache;
    const file = fromFile();
    cache = {};
    for (const a of Object.keys(TEST_KEY_VARS) as AgentAdapter[]) {
        const v = process.env[TEST_KEY_VARS[a]]?.trim() || file[TEST_KEY_VARS[a]]?.trim();
        if (v) cache[a] = v;
    }
    return cache;
}

/** Whether a live run may start: `{ ok: false, reason }` names what is missing (variable names only). */
export function liveGate(): { ok: true } | { ok: false; reason: string } {
    if (!liveRequested()) return { ok: false, reason: LIVE_BLOCKED };
    const keys = load();
    const missing = (Object.keys(TEST_KEY_VARS) as AgentAdapter[]).filter(a => !keys[a]).map(a => TEST_KEY_VARS[a]);
    if (missing.length) return { ok: false, reason: `blocked: ${missing.join(', ')} not set (environment or ${KEYS_FILE})` };
    return { ok: true };
}

/** One adapter's test key for the host child env. Throws (naming the variable) when absent. */
export function testKey(adapter: AgentAdapter): string {
    const gate = liveGate();
    if (!gate.ok) throw new Error(gate.reason);
    return load()[adapter]!;
}

/** Key values the end-of-run leak scan must look for (in memory; empty unless live). */
export function agentKeysForScan(): Record<string, string> {
    const keys = load();
    return Object.fromEntries(Object.entries(keys).map(([a, v]) => [`agentKey_${a}`, v!]));
}
