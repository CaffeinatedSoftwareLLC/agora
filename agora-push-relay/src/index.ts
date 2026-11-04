import type { FastifyBaseLogger } from 'fastify';
import { buildApp } from './app.js';
import { loadConfig, type RelayConfig } from './config.js';
import { deriveKeys, type Keys } from './crypto.js';
import { SqliteHandleStore, type HandleStore, type Platform } from './store.js';
import { PgHandleStore } from './store-pg.js';
import { ApnsSender, loadApnsKey, parseApnsKey } from './senders/apns.js';
import { FcmSender, loadServiceAccount, parseServiceAccount } from './senders/fcm.js';
import type { Sender } from './senders/types.js';
import { pruneProblems } from './telemetry.js';
import { PgTelemetryStore, SqliteTelemetryStore, type TelemetryStore } from './telemetry-store.js';

const DAY = 86_400_000;

async function openStore(config: RelayConfig['store'], keys: Keys, log: () => FastifyBaseLogger | undefined): Promise<HandleStore> {
    if (config.kind === 'sqlite') return new SqliteHandleStore(config.path, keys);
    // Logged as a code only: pg error messages can name the host and user.
    return PgHandleStore.open(config.url, keys, { ssl: config.ssl, onError: (err) => log()?.warn({ code: err.code ?? 'unknown' }, 'database connection lost') });
}

async function openTelemetry(config: RelayConfig['store'], log: () => FastifyBaseLogger | undefined): Promise<TelemetryStore> {
    if (config.kind === 'sqlite') return new SqliteTelemetryStore(config.path);
    return PgTelemetryStore.open(config.url, { ssl: config.ssl, onError: (err) => log()?.warn({ code: err.code ?? 'unknown' }, 'database connection lost') });
}

async function main() {
    const config = loadConfig();
    let log: FastifyBaseLogger | undefined;
    const store = await openStore(config.store, deriveKeys(config.masterKey), () => log);
    const telemetry = await openTelemetry(config.store, () => log);

    const senders: Partial<Record<Platform, Sender>> = {};
    if (config.fcm) {
        const sa = 'serviceAccountFile' in config.fcm ? loadServiceAccount(config.fcm.serviceAccountFile) : parseServiceAccount(config.fcm.serviceAccountJson);
        senders.android = new FcmSender(sa);
    }
    if (config.apns) {
        const { key, ...rest } = config.apns;
        senders.ios = new ApnsSender({ keyPem: 'file' in key ? loadApnsKey(key.file) : parseApnsKey(key.pem), ...rest });
    }

    const app = buildApp({
        store,
        senders,
        registerPerMinute: config.registerPerMinute,
        trustProxy: config.trustProxy,
        logger: { level: config.logLevel },
        telemetry: { store: telemetry, adminToken: config.adminToken },
    });
    log = app.log;
    if (!senders.android && !senders.ios) app.log.warn('no provider configured: every register answers 503 platform_unavailable');
    app.log.info({ android: Boolean(senders.android), ios: Boolean(senders.ios), apnsProduction: config.apns?.production ?? null }, 'providers');
    app.log.info({ store: config.store.kind, tls: config.store.kind === 'postgres' ? config.store.ssl : null }, 'store');

    // Hourly: outcome counts since the last line, then reset. Daily: drop handles unused for the TTL.
    const report = setInterval(() => {
        if (Object.keys(app.counters).length === 0) return;
        const counts = { ...app.counters };
        for (const k of Object.keys(app.counters)) delete app.counters[k];
        store.count().then(
            (handles) => app.log.info({ counts, handles }, 'hourly counts'),
            () => app.log.info({ counts, handles: null }, 'hourly counts'),
        );
    }, 3_600_000);
    const prune = async () => {
        if (config.handleTtlDays === 0) return;
        try {
            const removed = await store.pruneSeenBefore(Date.now() - config.handleTtlDays * DAY);
            if (removed > 0) app.log.info({ removed }, 'pruned unused handles');
        } catch (err) {
            app.log.warn({ code: (err as { code?: string }).code ?? 'unknown' }, 'prune failed; retrying tomorrow');
        }
    };
    // Problem reports are kept RELAY_PROBLEM_DAYS (90), whatever the handle TTL
    const pruneReports = async () => {
        try {
            const removed = await pruneProblems(telemetry, Date.now(), config.problemDays);
            if (removed > 0) app.log.info({ removed }, 'pruned old problem reports');
        } catch (err) {
            app.log.warn({ code: (err as { code?: string }).code ?? 'unknown' }, 'problem report prune failed; retrying tomorrow');
        }
    };
    await prune();
    await pruneReports();
    const pruneTimer = setInterval(() => {
        void prune();
        void pruneReports();
    }, DAY);

    let closing = false;
    const shutdown = async (signal: string) => {
        if (closing) return;
        closing = true;
        app.log.info({ signal }, 'shutting down');
        clearInterval(report);
        clearInterval(pruneTimer);
        await app.close();
        await Promise.all(Object.values(senders).map((s) => s?.close?.()));
        await store.close();
        await telemetry.close();
        process.exit(0);
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));

    await app.listen({ host: config.host, port: config.port });
}

main().catch((err: unknown) => {
    // Config errors name the variable; they never contain secret values. A refused database
    // connection can be an AggregateError with an empty message, so fall back to its code.
    const e = err as { message?: string; code?: string };
    console.error(`agora-push-relay: ${(err instanceof Error && (e.message || e.code)) || 'failed to start'}`);
    process.exit(1);
});
