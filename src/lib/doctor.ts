import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The API's own doctor (docs/agent-boxes.md §12.5): what the instance can see about itself,
 * as plain lines for a setup problem report. Admin → Instance → Report setup problem shows it
 * first; nothing leaves the instance until the admin presses Send.
 *
 * It never includes a secret: environment variables are reported as set or not set, never
 * their values; box names, user names and message text are left out (boxes appear by id);
 * and every line goes through `redact`, which removes anything shaped like a token.
 */

export interface DoctorDeps {
    /** The table owner's pool (box tables have no app_user grants). */
    query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
    redis?: { ping(): Promise<string>; get(key: string): Promise<string | null> } | null;
    env?: NodeJS.ProcessEnv;
    now?: () => number;
    version?: string;
}

/** Keys whose presence matters; their values are never read into the report. */
const ENV_KEYS = [
    'AGORA_INSTANCE', 'AGORA_ENCRYPTION_KEY', 'JWT_SECRET', 'AGORA_EDGE_SECRET', 'DATABASE_URL', 'REDIS_URL',
    'CORS_ORIGIN', 'STORAGE_DRIVER', 'AGORA_TELEMETRY_URL',
];
/** Not secret, and useful as values. */
const ENV_SHOWN = new Set(['AGORA_INSTANCE', 'STORAGE_DRIVER']);

export const BOXD_HEARTBEAT_KEY = 'agora:boxd:heartbeat';
export const EDGE_HEARTBEAT_KEY = 'agora:edge:heartbeat';

const REDACTIONS: Array<[RegExp, string]> = [
    // URLs with a user and password
    [/([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1<redacted>@'],
    [/\bBearer\s+\S+/gi, 'Bearer <redacted>'],
    [/\bBot\s+[A-Za-z0-9._-]{8,}/g, 'Bot <redacted>'],
    // Agora host and bot tokens, provider keys, GitHub tokens, JWTs
    [/\b(ah|bot|sk|sk-ant|ghp|gho|ghs|ghu|github_pat|xox[abp])[_-][A-Za-z0-9._-]{8,}/g, '<redacted-token>'],
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '<redacted-jwt>'],
    // Long hex (secrets, setup tokens) and long base64 runs. Dashes end a run, so container
    // and volume names (agora-box-<id>-home) stay readable
    [/\b[0-9a-fA-F]{32,}\b/g, '<redacted-hex>'],
    [/[A-Za-z0-9+_]{40,}={0,2}/g, '<redacted>'],
    // KEY=value where the key sounds secret
    [/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASS|KEY)[A-Z0-9_]*)=\S+/g, '$1=<redacted>'],
];

/** Removes anything shaped like a credential. Applied to every line of every report. */
export function redact(text: string): string {
    let out = text;
    for (const [re, rep] of REDACTIONS) out = out.replace(re, rep);
    return out;
}

export function agoraVersion(): string {
    try {
        // dist/src/lib → the package root in the image; src/lib in development
        for (const up of ['../../..', '../..']) {
            const pkg = JSON.parse(readFileSync(join(__dirname, up, 'package.json'), 'utf8'));
            if (pkg?.name && typeof pkg.version === 'string') return pkg.version;
        }
    } catch { /* fall through */ }
    return 'unknown';
}

function age(ms: number | null, now: number): string {
    if (ms === null || !Number.isFinite(ms)) return 'never';
    const s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 120) return `${s}s ago`;
    if (s < 7200) return `${Math.round(s / 60)}m ago`;
    return `${Math.round(s / 3600)}h ago`;
}

const t = (v: unknown) => (typeof v === 'string' ? v.trim() : v);
const oneLine = (v: unknown, max = 200) => String(v ?? '').replace(/\s+/g, ' ').slice(0, max);

/** Runs every check it can; a failed check is a line, never an exception. */
export async function buildApiDoctorReport(deps: DoctorDeps): Promise<string> {
    const env = deps.env ?? process.env;
    const now = (deps.now ?? Date.now)();
    const lines: string[] = [];
    const section = (title: string) => lines.push('', `## ${title}`);
    const check = async (label: string, fn: () => Promise<void>) => {
        try {
            await fn();
        } catch (err) {
            lines.push(`${label}: FAILED (${oneLine((err as { code?: string; message?: string })?.code ?? (err as Error)?.message ?? 'error', 120)})`);
        }
    };

    lines.push('# Agora API doctor', `generated: ${new Date(now).toISOString()}`);
    lines.push(`agora: ${deps.version ?? agoraVersion()}`, `node: ${process.version}`, `platform: ${process.platform} ${process.arch}`);

    section('Configuration (set or not set; values are never included)');
    for (const key of ENV_KEYS) {
        const v = env[key];
        if (ENV_SHOWN.has(key) && v) lines.push(`${key}: ${oneLine(v, 40)}`);
        else lines.push(`${key}: ${v ? 'set' : 'not set'}`);
    }
    const edgeSecret = env.AGORA_EDGE_SECRET ?? '';
    if (edgeSecret) lines.push(`AGORA_EDGE_SECRET shape: ${/^[0-9a-f]{64}$/i.test(edgeSecret) ? 'ok (64 hex)' : 'NOT 64 hex characters'}`);

    section('Database');
    await check('database', async () => {
        const started = Date.now();
        const v = (await deps.query('SELECT version() AS v')).rows[0]?.v as string;
        lines.push(`database: ok (${Date.now() - started} ms) ${oneLine(v, 60)}`);
        const m = (await deps.query('SELECT max(version) AS v, count(*)::int AS n FROM schema_migrations')).rows[0];
        lines.push(`migrations: ${m?.n ?? 0} applied, latest ${oneLine(m?.v ?? 'none', 80)}`);
        const init = (await deps.query('SELECT count(*)::int AS n FROM users WHERE is_instance_admin = true')).rows[0];
        lines.push(`instance admins: ${init?.n ?? 0}`);
    });

    section('Redis');
    let heartbeats: Record<string, number | null> = {};
    await check('redis', async () => {
        if (!deps.redis) {
            lines.push('redis: not connected');
            return;
        }
        const started = Date.now();
        const pong = await deps.redis.ping();
        lines.push(`redis: ${pong === 'PONG' ? 'ok' : oneLine(pong, 20)} (${Date.now() - started} ms)`);
        for (const [name, key] of [['boxd', BOXD_HEARTBEAT_KEY], ['edge', EDGE_HEARTBEAT_KEY]] as const) {
            const raw = await deps.redis.get(key);
            heartbeats[name] = raw && /^\d+$/.test(raw) ? Number(raw) : null;
        }
    });

    section('Code runs (runner)');
    await check('runner', async () => {
        const rows = (await deps.query(
            `SELECT status, count(*)::int AS n FROM exec_runs WHERE created_at > now() - interval '24 hours' GROUP BY status ORDER BY status`,
        )).rows;
        lines.push(`runs in the last 24h: ${rows.length ? rows.map((r) => `${r.status}=${r.n}`).join(', ') : 'none'}`);
        const queued = (await deps.query(
            `SELECT min(created_at) AS oldest FROM exec_runs WHERE status = 'queued'`,
        )).rows[0]?.oldest;
        const oldest = queued ? new Date(queued).getTime() : null;
        lines.push(`oldest queued run: ${oldest ? age(oldest, now) : 'none'}`);
        if (oldest && now - oldest > 10 * 60_000) lines.push('note: a run has waited over 10 minutes; the runner may be down (no gVisor, or AGORA_SANDBOX_INSECURE_DEV unset)');
    });

    section('Agent boxes');
    lines.push(`boxd heartbeat: ${age(heartbeats.boxd ?? null, now)}${heartbeats.boxd && now - heartbeats.boxd > 120_000 ? ' (stale)' : ''}`);
    lines.push(`edge heartbeat: ${age(heartbeats.edge ?? null, now)}${heartbeats.edge && now - heartbeats.edge > 120_000 ? ' (stale)' : ''}`);
    await check('boxes', async () => {
        const boxes = (await deps.query(
            `SELECT id, state, desired_state, pending_action, generation, image_version, login_state,
                    failures, last_error, last_error_at, last_seen_at, deleted_at
             FROM agent_boxes ORDER BY created_at`,
        )).rows;
        if (boxes.length === 0) lines.push('boxes: none');
        const lastSeen = boxes.map((b) => (b.last_seen_at ? new Date(b.last_seen_at).getTime() : 0)).reduce((a, b) => Math.max(a, b), 0);
        if (boxes.length && heartbeats.boxd == null) lines.push(`newest box last_seen_at: ${age(lastSeen || null, now)}`);
        for (const b of boxes) {
            const seen = b.last_seen_at ? new Date(b.last_seen_at).getTime() : null;
            lines.push(
                `box ${t(b.id)}: state=${b.state} desired=${b.desired_state}${b.pending_action ? ` pending=${b.pending_action}` : ''}`
                + ` gen=${b.generation} image=${b.image_version ?? '-'} login=${b.login_state} failures=${b.failures}`
                + ` seen=${age(seen, now)}${b.deleted_at ? ' deleted' : ''}`,
            );
            if (b.last_error) lines.push(`  last error (${age(b.last_error_at ? new Date(b.last_error_at).getTime() : null, now)}): ${oneLine(b.last_error, 300)}`);
        }
        const edge = (await deps.query(
            `SELECT kind, status, count(*)::int AS n FROM box_edge_requests WHERE created_at > now() - interval '7 days' GROUP BY kind, status ORDER BY kind, status`,
        )).rows;
        lines.push(`edge requests (7 days): ${edge.length ? edge.map((r) => `${r.kind}/${r.status}=${r.n}`).join(', ') : 'none'}`);
    });

    return lines.map(redact).join('\n') + '\n';
}
