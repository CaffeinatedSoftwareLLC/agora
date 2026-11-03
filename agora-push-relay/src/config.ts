/** Relay settings from the environment. Every variable is documented in agora-push-relay/.env.example. */
export interface RelayConfig {
    host: string;
    port: number;
    /** SQLite file by default; Postgres when DATABASE_URL is set. */
    store: { kind: 'sqlite'; path: string } | { kind: 'postgres'; url: string; ssl: boolean };
    masterKey: Buffer;
    /** false, true (every hop), a hop count, or trusted addresses/CIDRs. */
    trustProxy: boolean | number | string[];
    registerPerMinute: number;
    handleTtlDays: number;
    logLevel: string;
    /** The service-account JSON from a file, or the JSON itself (FCM_SERVICE_ACCOUNT_JSON). */
    fcm: { serviceAccountFile: string } | { serviceAccountJson: string } | null;
    apns: { key: { file: string } | { pem: string }; keyId: string; teamId: string; bundleId: string; production: boolean } | null;
}

type Env = Record<string, string | undefined>;

function int(env: Env, name: string, fallback: number, min: number, max: number): number {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
    return n;
}

function trustProxy(env: Env): RelayConfig['trustProxy'] {
    const v = env.RELAY_TRUST_PROXY?.trim();
    if (!v || v === 'false') return false;
    if (v === 'true') return true;
    // A hop count: the client address is that many entries from the right of X-Forwarded-For.
    if (/^\d+$/.test(v)) return int(env, 'RELAY_TRUST_PROXY', 0, 1, 10);
    return v.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Both forms of one secret set is an error: neither silently wins. */
function oneOf(env: Env, fileVar: string, contentVar: string): { file: string } | { content: string } | null {
    const file = env[fileVar]?.trim();
    const content = env[contentVar]?.trim();
    if (file && content) throw new Error(`set ${fileVar} or ${contentVar}, not both`);
    if (file) return { file };
    if (content) return { content };
    return null;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function postgres(env: Env, url: string): RelayConfig['store'] {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        // The message never quotes the URL: it holds the database password.
        throw new Error('DATABASE_URL is not a valid postgres:// URL');
    }
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') throw new Error('DATABASE_URL must start with postgres://');
    // pg lets TLS settings in the URL override the ones the relay passes, and reads
    // sslmode=require as "verify the certificate", which Heroku's certificates fail.
    // RELAY_DB_SSL is the one place TLS is set.
    for (const key of parsed.searchParams.keys()) {
        if (key.startsWith('ssl') || key === 'uselibpqcompat') throw new Error(`DATABASE_URL: remove ${key}; set RELAY_DB_SSL=require or disable instead`);
    }
    const mode = env.RELAY_DB_SSL?.trim();
    if (mode && mode !== 'require' && mode !== 'disable') throw new Error('RELAY_DB_SSL must be require or disable');
    // TLS unless the database is on this host. Heroku Postgres refuses connections without it.
    const ssl = mode ? mode === 'require' : !LOCAL_HOSTS.has(parsed.hostname);
    return { kind: 'postgres', url, ssl };
}

export function loadConfig(env: Env = process.env): RelayConfig {
    const keyHex = env.RELAY_SECRET_KEY?.trim() ?? '';
    if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) throw new Error('RELAY_SECRET_KEY must be 64 hex characters (openssl rand -hex 32)');
    const masterKey = Buffer.from(keyHex, 'hex');
    if (masterKey.every((b) => b === masterKey[0])) throw new Error('RELAY_SECRET_KEY looks like a placeholder; generate one with openssl rand -hex 32');

    const fcmSource = oneOf(env, 'FCM_SERVICE_ACCOUNT_FILE', 'FCM_SERVICE_ACCOUNT_JSON');
    const fcm: RelayConfig['fcm'] = !fcmSource ? null : 'file' in fcmSource ? { serviceAccountFile: fcmSource.file } : { serviceAccountJson: fcmSource.content };

    const apnsKey = oneOf(env, 'APNS_KEY_FILE', 'APNS_KEY');
    const apnsSet = { 'APNS_KEY_FILE or APNS_KEY': Boolean(apnsKey), APNS_KEY_ID: false, APNS_TEAM_ID: false, APNS_BUNDLE_ID: false };
    for (const n of ['APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_BUNDLE_ID'] as const) apnsSet[n] = Boolean(env[n]?.trim());
    const missing = Object.entries(apnsSet).filter(([, set]) => !set).map(([n]) => n);
    if (missing.length > 0 && missing.length < 4) throw new Error(`APNs is partly configured; also set ${missing.join(', ')}`);
    let apns: RelayConfig['apns'] = null;
    if (apnsKey && missing.length === 0) {
        const keyId = env.APNS_KEY_ID!.trim();
        const teamId = env.APNS_TEAM_ID!.trim();
        if (!/^[A-Z0-9]{10}$/.test(keyId)) throw new Error('APNS_KEY_ID must be the 10-character key ID');
        if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new Error('APNS_TEAM_ID must be the 10-character team ID');
        const environment = env.APNS_ENVIRONMENT?.trim() || 'production';
        if (environment !== 'production' && environment !== 'sandbox') throw new Error('APNS_ENVIRONMENT must be production or sandbox');
        // Config vars are one line in some dashboards, so APNS_KEY may carry the .p8's line breaks as literal \n.
        const key = 'file' in apnsKey ? { file: apnsKey.file } : { pem: apnsKey.content.replace(/\\n/g, '\n') };
        apns = { key, keyId, teamId, bundleId: env.APNS_BUNDLE_ID!.trim(), production: environment === 'production' };
    }

    const databaseUrl = env.DATABASE_URL?.trim();
    return {
        host: env.RELAY_HOST?.trim() || '0.0.0.0',
        // Heroku assigns PORT; it wins over RELAY_PORT.
        port: env.PORT?.trim() ? int(env, 'PORT', 8080, 1, 65535) : int(env, 'RELAY_PORT', 8080, 1, 65535),
        store: databaseUrl ? postgres(env, databaseUrl) : { kind: 'sqlite', path: env.RELAY_DB_PATH?.trim() || '/data/relay.db' },
        masterKey,
        trustProxy: trustProxy(env),
        registerPerMinute: int(env, 'RELAY_REGISTER_PER_MINUTE', 10, 1, 10_000),
        handleTtlDays: int(env, 'RELAY_HANDLE_TTL_DAYS', 365, 0, 10_000),
        logLevel: env.RELAY_LOG_LEVEL?.trim() || 'info',
        fcm,
        apns,
    };
}
