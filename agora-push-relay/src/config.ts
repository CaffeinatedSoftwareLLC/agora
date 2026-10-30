/** Relay settings from the environment. Every variable is documented in agora-push-relay/.env.example. */
export interface RelayConfig {
    host: string;
    port: number;
    dbPath: string;
    masterKey: Buffer;
    trustProxy: boolean | string[];
    registerPerMinute: number;
    handleTtlDays: number;
    logLevel: string;
    fcm: { serviceAccountFile: string } | null;
    apns: { keyFile: string; keyId: string; teamId: string; bundleId: string; production: boolean } | null;
}

type Env = Record<string, string | undefined>;

function int(env: Env, name: string, fallback: number, min: number, max: number): number {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
    return n;
}

function trustProxy(raw: string | undefined): RelayConfig['trustProxy'] {
    const v = raw?.trim();
    if (!v || v === 'false') return false;
    if (v === 'true') return true;
    return v.split(',').map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(env: Env = process.env): RelayConfig {
    const keyHex = env.RELAY_SECRET_KEY?.trim() ?? '';
    if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) throw new Error('RELAY_SECRET_KEY must be 64 hex characters (openssl rand -hex 32)');
    const masterKey = Buffer.from(keyHex, 'hex');
    if (masterKey.every((b) => b === masterKey[0])) throw new Error('RELAY_SECRET_KEY looks like a placeholder; generate one with openssl rand -hex 32');

    const fcmFile = env.FCM_SERVICE_ACCOUNT_FILE?.trim();

    const apnsVars = ['APNS_KEY_FILE', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_BUNDLE_ID'] as const;
    const apnsSet = apnsVars.filter((n) => env[n]?.trim());
    if (apnsSet.length > 0 && apnsSet.length < apnsVars.length) {
        throw new Error(`APNs is partly configured; also set ${apnsVars.filter((n) => !apnsSet.includes(n)).join(', ')}`);
    }
    let apns: RelayConfig['apns'] = null;
    if (apnsSet.length === apnsVars.length) {
        const keyId = env.APNS_KEY_ID!.trim();
        const teamId = env.APNS_TEAM_ID!.trim();
        if (!/^[A-Z0-9]{10}$/.test(keyId)) throw new Error('APNS_KEY_ID must be the 10-character key ID');
        if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new Error('APNS_TEAM_ID must be the 10-character team ID');
        const environment = env.APNS_ENVIRONMENT?.trim() || 'production';
        if (environment !== 'production' && environment !== 'sandbox') throw new Error('APNS_ENVIRONMENT must be production or sandbox');
        apns = { keyFile: env.APNS_KEY_FILE!.trim(), keyId, teamId, bundleId: env.APNS_BUNDLE_ID!.trim(), production: environment === 'production' };
    }

    return {
        host: env.RELAY_HOST?.trim() || '0.0.0.0',
        port: int(env, 'RELAY_PORT', 8080, 1, 65535),
        dbPath: env.RELAY_DB_PATH?.trim() || '/data/relay.db',
        masterKey,
        trustProxy: trustProxy(env.RELAY_TRUST_PROXY),
        registerPerMinute: int(env, 'RELAY_REGISTER_PER_MINUTE', 10, 1, 10_000),
        handleTtlDays: int(env, 'RELAY_HANDLE_TTL_DAYS', 365, 0, 10_000),
        logLevel: env.RELAY_LOG_LEVEL?.trim() || 'info',
        fcm: fcmFile ? { serviceAccountFile: fcmFile } : null,
        apns,
    };
}
